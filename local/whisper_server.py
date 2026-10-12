#!/usr/bin/env python3
"""
Community Captioner — local speech-to-text server.

Runs entirely on your machine. The app streams microphone audio to this
process over a WebSocket and gets captions back; nothing leaves the computer.

Protocol (WebSocket, default ws://127.0.0.1:9000):
  client → server : binary frames of 16 kHz, 16-bit, mono PCM audio
  server → client : {"type":"hello", "backend":..., "model":..., "device":...}   on connect
                    {"text": "...", "isFinal": false}                            interim (while speaking)
                    {"text": "...", "isFinal": true, "latencyMs": 420}           final segment
                    {"type":"status", "state": "...", "message": "..."}          progress/errors

Backends (auto-selected unless --backend is given):
  mlx            mlx-whisper  — Apple Silicon GPU, fastest on Macs      (pip install mlx-whisper)
  faster-whisper CTranslate2  — CPU everywhere, NVIDIA GPU on Windows    (pip install faster-whisper)

Usage:
  python whisper_server.py --model large-v3-turbo
  python whisper_server.py --model small.en --backend faster-whisper --device cpu --compute int8
  python whisper_server.py --list-models

Status lines for the app's launcher are printed as:  __WHISPER_STATUS__ {"state": ...}
"""

import argparse
import asyncio
import json
import os
import platform
import sys
import threading
import time

# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

# name → (faster-whisper id, mlx-community repo, description, approx download MB, english_only)
MODELS = {
    "tiny.en":          ("tiny.en",          "mlx-community/whisper-tiny.en-mlx",        "Lightest. Rough accuracy; fine for testing.",            75,   True),
    "base.en":          ("base.en",          "mlx-community/whisper-base.en-mlx",        "Light. Usable captions on any laptop.",                 145,  True),
    "small.en":         ("small.en",         "mlx-community/whisper-small.en-mlx",       "Good balance for CPU-only machines.",                   480,  True),
    "distil-large-v3":  ("distil-large-v3",  "mlx-community/distil-whisper-large-v3",    "English-only distilled large model: near large-v3 accuracy at ~2x speed.", 1500, True),
    "large-v3-turbo":   ("large-v3-turbo",   "mlx-community/whisper-large-v3-turbo",     "Recommended. Multilingual, near large-v3 accuracy, 8x faster than large-v3.", 1600, False),
    "medium.en":        ("medium.en",        "mlx-community/whisper-medium.en-mlx",      "Older middle option; prefer distil-large-v3 or turbo.", 1500, True),
    "large-v3":         ("large-v3",         "mlx-community/whisper-large-v3-mlx",       "Highest accuracy, slowest. Needs a GPU for real time.",  3000, False),
}

SAMPLE_RATE = 16000


def status(state, **extra):
    """Machine-readable progress line for the app's launcher (and humans)."""
    payload = {"state": state, **extra}
    print("__WHISPER_STATUS__ " + json.dumps(payload), flush=True)


def log(msg):
    print(msg, flush=True)


# ---------------------------------------------------------------------------
# Backends
# ---------------------------------------------------------------------------

class FasterWhisperBackend:
    name = "faster-whisper"

    def __init__(self, model_name, device, compute, language):
        from faster_whisper import WhisperModel  # noqa: WPS433
        fw_id = MODELS.get(model_name, (model_name,))[0]
        if device == "auto":
            device = "cuda" if _cuda_available() else "cpu"
        if compute == "auto":
            compute = "float16" if device == "cuda" else "int8"
        self.device, self.compute, self.language = device, compute, language
        status("loading", backend=self.name, model=fw_id, device=device, compute=compute,
               message=f"Loading {fw_id} on {device} ({compute}) — first run downloads the model")
        self.model = WhisperModel(fw_id, device=device, compute_type=compute)
        self.model_id = fw_id

    def transcribe(self, audio):
        segments, _info = self.model.transcribe(
            audio, language=self.language, beam_size=1, best_of=1,
            vad_filter=False, condition_on_previous_text=False, without_timestamps=True,
        )
        return " ".join(s.text.strip() for s in segments if s.text and s.text.strip())


class MlxWhisperBackend:
    name = "mlx-whisper"

    def __init__(self, model_name, device, compute, language):
        import mlx_whisper  # noqa: WPS433
        self._mlx = mlx_whisper
        repo = MODELS.get(model_name, (None, model_name))[1]
        self.device, self.compute, self.language = "apple-gpu", "mlx", language
        status("loading", backend=self.name, model=repo, device=self.device, compute=self.compute,
               message=f"Loading {repo} on the Apple GPU — first run downloads the model")
        # Warm up (downloads + compiles)
        import numpy as np
        self._mlx.transcribe(np.zeros(SAMPLE_RATE, dtype=np.float32), path_or_hf_repo=repo,
                             language=language, fp16=True, verbose=None)
        self.model_id = repo

    def transcribe(self, audio):
        r = self._mlx.transcribe(audio, path_or_hf_repo=self.model_id, language=self.language,
                                 fp16=True, condition_on_previous_text=False, verbose=None)
        return (r.get("text") or "").strip()


def _cuda_available():
    try:
        import ctranslate2  # noqa: WPS433
        return ctranslate2.get_cuda_device_count() > 0
    except Exception:
        return False


def _is_apple_silicon():
    return platform.system() == "Darwin" and platform.machine() in ("arm64", "aarch64")


def pick_backend(requested):
    if requested == "mlx":
        return MlxWhisperBackend
    if requested == "faster-whisper":
        return FasterWhisperBackend
    if _is_apple_silicon():
        try:
            import mlx_whisper  # noqa: F401,WPS433
            return MlxWhisperBackend
        except Exception:
            pass
    return FasterWhisperBackend


# ---------------------------------------------------------------------------
# Segmenter: energy-based voice activity detection → whole utterances
# ---------------------------------------------------------------------------

class Segmenter:
    """Buffers PCM and cuts it into utterances on silence.

    A segment ends after `silence_ms` of quiet following at least `min_speech_ms`
    of speech, or when it reaches `max_segment_s`. Interim transcriptions of the
    growing segment are produced every `interim_s` while the speaker continues.
    """

    def __init__(self, threshold=0.012, silence_ms=650, min_speech_ms=350, max_segment_s=14.0, interim_s=2.0):
        import numpy as np
        self.np = np
        self.threshold = threshold
        self.silence_frames = int(SAMPLE_RATE * silence_ms / 1000)
        self.min_speech_frames = int(SAMPLE_RATE * min_speech_ms / 1000)
        self.max_frames = int(SAMPLE_RATE * max_segment_s)
        self.interim_frames = int(SAMPLE_RATE * interim_s)
        self.buffer = np.zeros(0, dtype=np.float32)
        self.speech_frames = 0
        self.trailing_silence = 0
        self.since_interim = 0
        self.noise_floor = 0.004
        self.speech_started_at = None
        self.last_speech_at = None

    def feed(self, pcm_int16):
        np = self.np
        audio = pcm_int16.astype(np.float32) / 32768.0
        out = []
        # Work in 20 ms hops so the VAD reacts quickly
        hop = SAMPLE_RATE // 50
        for i in range(0, len(audio), hop):
            chunk = audio[i:i + hop]
            rms = float(np.sqrt(np.mean(chunk * chunk))) if len(chunk) else 0.0
            # Adaptive threshold: a little above the running noise floor
            if rms < self.noise_floor * 1.5:
                self.noise_floor = 0.95 * self.noise_floor + 0.05 * max(rms, 1e-5)
            thr = max(self.threshold, self.noise_floor * 3.0)
            is_speech = rms > thr
            if is_speech:
                if self.speech_frames == 0 and self.trailing_silence > 0 and len(self.buffer) == 0:
                    pass
                self.speech_frames += len(chunk)
                self.trailing_silence = 0
                self.last_speech_at = time.time()
                if self.speech_started_at is None:
                    self.speech_started_at = time.time()
            else:
                self.trailing_silence += len(chunk)
            if self.speech_frames > 0 or len(self.buffer) > 0:
                self.buffer = np.concatenate((self.buffer, chunk))
                self.since_interim += len(chunk)
            # Keep ~300 ms of pre-roll before speech starts so first syllables survive
            elif len(self.buffer) == 0:
                self.buffer = np.concatenate((self.buffer, chunk))[-int(SAMPLE_RATE * 0.3):]

            long_enough = self.speech_frames >= self.min_speech_frames
            if long_enough and self.trailing_silence >= self.silence_frames:
                out.append(("final", self.buffer.copy(), self.last_speech_at))
                self._reset()
            elif len(self.buffer) >= self.max_frames and long_enough:
                out.append(("final", self.buffer.copy(), self.last_speech_at))
                self._reset()
            elif long_enough and self.trailing_silence == 0 and self.since_interim >= self.interim_frames:
                out.append(("interim", self.buffer.copy(), None))
                self.since_interim = 0
            elif not long_enough and self.speech_frames == 0 and self.trailing_silence >= self.silence_frames * 4 and len(self.buffer) > 0:
                # Nothing but noise for a while: drop it
                self._reset()
        return out

    def _reset(self):
        self.buffer = self.np.zeros(0, dtype=self.np.float32)
        self.speech_frames = 0
        self.trailing_silence = 0
        self.since_interim = 0
        self.speech_started_at = None
        self.last_speech_at = None


# ---------------------------------------------------------------------------
# Server
# ---------------------------------------------------------------------------

class Server:
    def __init__(self, backend, interim):
        self.backend = backend
        self.interim = interim
        self.lock = threading.Lock()  # one transcription at a time per process

    async def handle(self, websocket):
        import numpy as np
        peer = getattr(websocket, "remote_address", ("?", 0))
        log(f"Client connected from {peer[0]}")
        await websocket.send(json.dumps({
            "type": "hello", "version": 1, "backend": self.backend.name, "model": self.backend.model_id,
            "device": self.backend.device, "compute": self.backend.compute, "language": self.backend.language or "auto",
            "interim": self.interim, "platform": platform.system().lower(),
        }))
        seg = Segmenter()
        loop = asyncio.get_running_loop()
        pending_interim = None
        try:
            async for message in websocket:
                if isinstance(message, str):
                    # Text control messages
                    try:
                        ctl = json.loads(message)
                    except Exception:
                        continue
                    if ctl.get("type") == "ping":
                        await websocket.send(json.dumps({"type": "pong"}))
                    continue
                pcm = np.frombuffer(message, dtype=np.int16)
                for kind, audio, last_speech_at in seg.feed(pcm):
                    if kind == "interim":
                        if not self.interim or (pending_interim and not pending_interim.done()):
                            continue  # skip if a previous interim is still running
                        pending_interim = loop.run_in_executor(None, self._transcribe_safe, audio)
                        asyncio.ensure_future(self._send_when_done(websocket, pending_interim, False, None))
                    else:
                        t0 = time.time()
                        text = await loop.run_in_executor(None, self._transcribe_safe, audio)
                        if text:
                            latency = int((time.time() - (last_speech_at or t0)) * 1000)
                            log(f"[{latency:5d} ms] {text}")
                            await websocket.send(json.dumps({"text": text, "isFinal": True, "latencyMs": latency,
                                                             "audioSeconds": round(len(audio) / SAMPLE_RATE, 2)}))
        except Exception as e:  # websockets.ConnectionClosed and friends
            if "closed" not in str(type(e)).lower() and "Closed" not in type(e).__name__:
                log(f"Client error: {e}")
        log("Client disconnected")

    async def _send_when_done(self, websocket, fut, is_final, latency):
        try:
            text = await fut
            if text:
                await websocket.send(json.dumps({"text": text, "isFinal": is_final}))
        except Exception:
            pass

    def _transcribe_safe(self, audio):
        with self.lock:
            try:
                return self.backend.transcribe(audio)
            except Exception as e:
                log(f"Inference error: {e}")
                status("error", message=f"Inference error: {e}")
                return ""


async def serve(args, backend):
    import websockets
    server = Server(backend, interim=not args.no_interim)
    async with websockets.serve(server.handle, args.host, args.port, max_size=8 * 1024 * 1024):
        url = f"ws://127.0.0.1:{args.port}"
        status("ready", url=url, backend=backend.name, model=backend.model_id, device=backend.device, compute=backend.compute)
        log("")
        log("✅ Speech server ready")
        log(f"   Backend : {backend.name}")
        log(f"   Model   : {backend.model_id}")
        log(f"   Device  : {backend.device} ({backend.compute})")
        log(f"   Listen  : {url}   (also reachable on this machine's LAN address)")
        log("   Leave this window open while captioning. Ctrl+C stops the server.")
        log("")
        await asyncio.Future()


def main():
    p = argparse.ArgumentParser(description="Community Captioner local speech server")
    p.add_argument("--model", default="large-v3-turbo", help="model name (see --list-models) or a custom model id/path")
    p.add_argument("--backend", default="auto", choices=["auto", "mlx", "faster-whisper"])
    p.add_argument("--device", default="auto", help="faster-whisper device: auto|cpu|cuda")
    p.add_argument("--compute", default="auto", help="faster-whisper compute type: auto|int8|float16|int8_float16|float32")
    p.add_argument("--language", default="en", help="language code, or 'auto' to detect")
    p.add_argument("--host", default="0.0.0.0")
    p.add_argument("--port", type=int, default=9000)
    p.add_argument("--no-interim", action="store_true", help="only send final segments (saves CPU)")
    p.add_argument("--list-models", action="store_true")
    args = p.parse_args()

    if args.list_models:
        print(json.dumps([{"name": k, "description": v[2], "downloadMB": v[3], "englishOnly": v[4]} for k, v in MODELS.items()], indent=1))
        return

    language = None if args.language in ("auto", "", None) else args.language
    status("starting", python=sys.version.split()[0], platform=platform.platform(), model=args.model, backend=args.backend)
    try:
        import numpy  # noqa: F401
        import websockets  # noqa: F401
    except ImportError as e:
        status("error", message=f"Missing package: {e.name}. Install with: pip install numpy websockets faster-whisper")
        sys.exit(2)

    try:
        Backend = pick_backend(args.backend)
        backend = Backend(args.model, args.device, args.compute, language)
    except ImportError as e:
        hint = "pip install mlx-whisper" if "mlx" in str(e) else "pip install faster-whisper"
        status("error", message=f"Backend not installed ({e}). Try: {hint}")
        sys.exit(2)
    except Exception as e:
        status("error", message=f"Could not load model '{args.model}': {e}")
        sys.exit(3)

    try:
        asyncio.run(serve(args, backend))
    except KeyboardInterrupt:
        log("Server stopped.")
    except OSError as e:
        status("error", message=f"Could not listen on port {args.port}: {e}")
        sys.exit(4)


if __name__ == "__main__":
    main()
