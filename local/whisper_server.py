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
# Bumped whenever the protocol or the captioning behaviour changes; the app compares it
# with the server it finds on port 9000 so an older copy can be replaced.
SCRIPT_VERSION = 4

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

    def __init__(self, threshold=0.012, silence_ms=550, min_speech_ms=350, max_segment_s=10.0, interim_s=0.3):
        import numpy as np
        self.np = np
        self.segment_id = 0  # bumps on every reset so late interim results for an old segment are dropped
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

    def speaking(self):
        """True while a segment is open and the speaker has not paused long enough to end it."""
        return self.speech_frames >= self.min_speech_frames and self.trailing_silence < self.silence_frames

    def _reset(self):
        self.segment_id += 1
        self.buffer = self.np.zeros(0, dtype=self.np.float32)
        self.speech_frames = 0
        self.trailing_silence = 0
        self.since_interim = 0
        self.speech_started_at = None
        self.last_speech_at = None


# ---------------------------------------------------------------------------
# Prerecorded files: decode with PyAV (ships with faster-whisper, no ffmpeg CLI
# needed), cut into utterances with the same energy VAD, transcribe each one.
# ---------------------------------------------------------------------------

def decode_media(path, progress=None):
    """Decode any audio/video file to 16 kHz mono int16. Returns (pcm_int16, duration_s)."""
    import av  # noqa: WPS433
    import numpy as np
    container = av.open(path)
    stream = next((st for st in container.streams if st.type == "audio"), None)
    if stream is None:
        container.close()
        raise RuntimeError("This file has no audio track")
    duration = float(stream.duration * stream.time_base) if stream.duration else (float(container.duration) / 1e6 if container.duration else 0.0)
    resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
    chunks = []
    last_report = 0.0
    try:
        for frame in container.decode(stream):
            for out in resampler.resample(frame):
                arr = out.to_ndarray()
                chunks.append(arr.reshape(-1).astype(np.int16))
            if progress and frame.time is not None and duration and frame.time - last_report >= 2.0:
                last_report = frame.time
                progress(min(0.999, frame.time / duration))
        for out in resampler.resample(None):  # flush
            chunks.append(out.to_ndarray().reshape(-1).astype(np.int16))
    finally:
        container.close()
    pcm = np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.int16)
    if not duration:
        duration = len(pcm) / SAMPLE_RATE
    return pcm, duration


def split_utterances(pcm_int16, threshold=0.012, silence_ms=550, min_speech_ms=350, max_segment_s=15.0, pad_ms=250):
    """Offline VAD with the live Segmenter's rules → list of (start_sample, end_sample)."""
    import numpy as np
    audio = pcm_int16.astype(np.float32) / 32768.0
    hop = SAMPLE_RATE // 50  # 20 ms
    n_hops = (len(audio) + hop - 1) // hop
    noise_floor = 0.004
    speech = np.zeros(n_hops, dtype=bool)
    for i in range(n_hops):
        chunk = audio[i * hop:(i + 1) * hop]
        rms = float(np.sqrt(np.mean(chunk * chunk))) if len(chunk) else 0.0
        if rms < noise_floor * 1.5:
            noise_floor = 0.95 * noise_floor + 0.05 * max(rms, 1e-5)
        speech[i] = rms > max(threshold, noise_floor * 3.0)
    silence_hops = max(1, silence_ms // 20)
    min_speech_hops = max(1, min_speech_ms // 20)
    max_hops = int(max_segment_s * 50)
    pad = int(SAMPLE_RATE * pad_ms / 1000)
    segments = []
    start = None
    speech_hops = 0
    quiet = 0
    last_quiet_cut = None
    for i in range(n_hops):
        if speech[i]:
            if start is None:
                start = i
                speech_hops = 0
            speech_hops += 1
            quiet = 0
        else:
            if start is not None:
                quiet += 1
                if quiet == 1:
                    last_quiet_cut = i
        if start is None:
            continue
        long_enough = speech_hops >= min_speech_hops
        if long_enough and quiet >= silence_hops:
            segments.append((start, i - quiet + 1))
            start = None
        elif i - start >= max_hops:
            # Too long without a pause: cut at the most recent quiet hop if there is one
            cut = last_quiet_cut if (last_quiet_cut and last_quiet_cut > start + min_speech_hops) else i
            segments.append((start, cut))
            start = cut if cut < i else None
            speech_hops = 0 if start is None else (i - cut)
            quiet = 0
        elif not long_enough and quiet >= silence_hops * 4:
            start = None  # just a click or noise
    if start is not None and speech_hops >= min_speech_hops:
        segments.append((start, n_hops))
    out = []
    for a, b in segments:
        s0 = max(0, a * hop - pad)
        s1 = min(len(pcm_int16), b * hop + pad)
        if s1 - s0 >= SAMPLE_RATE // 4:
            out.append((s0, s1))
    return out


# ---------------------------------------------------------------------------
# Server
# ---------------------------------------------------------------------------

class Server:
    def __init__(self, backend, interim, interim_s=None, interim_backend=None):
        self.backend = backend
        self.interim = interim
        self.interim_backend = interim_backend  # optional small model for the live line
        # Interim cadence: on a GPU the model keeps up with ~0.3 s updates (they run back
        # to back anyway when inference is slower than that); on CPU a longer gap leaves
        # room for the finals, which share the transcription lock with the interims.
        on_cpu = "cpu" in str(getattr(backend, "device", "")).lower()
        self.interim_s = interim_s if interim_s else (1.2 if on_cpu and interim_backend is None else 0.6 if on_cpu else 0.3)
        self.lock = threading.Lock()  # one transcription at a time per process

    async def handle(self, websocket):
        import numpy as np
        peer = getattr(websocket, "remote_address", ("?", 0))
        log(f"Client connected from {peer[0]}")
        await websocket.send(json.dumps({
            "type": "hello", "version": 1, "backend": self.backend.name, "model": self.backend.model_id,
            "device": self.backend.device, "compute": self.backend.compute, "language": self.backend.language or "auto",
            "interim": self.interim, "interimSeconds": self.interim_s, "platform": platform.system().lower(),
            "interimModel": getattr(self.interim_backend, "model_id", None), "scriptVersion": SCRIPT_VERSION,
        }))
        seg = Segmenter(interim_s=self.interim_s)
        loop = asyncio.get_running_loop()
        conn = {"seg": seg, "pending": None, "deferred": False, "final_pending": False}
        try:
            async for message in websocket:
                if isinstance(message, str):
                    # Text control messages
                    try:
                        ctl = json.loads(message)
                    except Exception:
                        continue
                    kind = ctl.get("type")
                    if kind == "ping":
                        await websocket.send(json.dumps({"type": "pong"}))
                    elif kind == "transcribe_file":
                        job = {"id": str(ctl.get("jobId") or ""), "path": str(ctl.get("path") or ""), "cancel": False}
                        conn.setdefault("jobs", {})[job["id"]] = job
                        asyncio.ensure_future(self._run_file_job(websocket, job, loop))
                    elif kind == "cancel_file":
                        j = conn.get("jobs", {}).get(str(ctl.get("jobId") or ""))
                        if j:
                            j["cancel"] = True
                    continue
                pcm = np.frombuffer(message, dtype=np.int16)
                for kind, audio, last_speech_at in seg.feed(pcm):
                    if kind == "interim":
                        if not self.interim:
                            continue
                        if conn["pending"] and not conn["pending"].done():
                            conn["deferred"] = True  # run again the moment the current one finishes
                            continue
                        self._start_interim(loop, websocket, conn, audio)
                    else:
                        t0 = time.time()
                        conn["final_pending"] = True
                        conn["deferred"] = False
                        try:
                            text = await loop.run_in_executor(None, self._transcribe_safe, audio)
                        finally:
                            conn["final_pending"] = False
                        if text:
                            latency = int((time.time() - (last_speech_at or t0)) * 1000)
                            log(f"[{latency:5d} ms] {text}")
                            await websocket.send(json.dumps({"text": text, "isFinal": True, "latencyMs": latency,
                                                             "audioSeconds": round(len(audio) / SAMPLE_RATE, 2)}))
        except Exception as e:  # websockets.ConnectionClosed and friends
            if "closed" not in str(type(e)).lower() and "Closed" not in type(e).__name__:
                log(f"Client error: {e}")
        log("Client disconnected")

    async def _run_file_job(self, websocket, job, loop):
        """Transcribe a whole media file, streaming timed segments back as they are done."""
        import numpy as np
        jid = job["id"]
        t0 = time.time()
        q = asyncio.Queue()

        def emit(msg):
            msg["jobId"] = jid
            loop.call_soon_threadsafe(q.put_nowait, msg)

        def work():
            try:
                emit({"type": "file_status", "stage": "decoding", "progress": 0.0, "message": "Decoding audio…"})
                pcm, duration = decode_media(job["path"], progress=lambda p: emit({"type": "file_status", "stage": "decoding", "progress": p, "message": "Decoding audio…"}))
                if job["cancel"]:
                    emit({"type": "file_error", "error": "cancelled"}); return
                if len(pcm) < SAMPLE_RATE // 2:
                    emit({"type": "file_error", "error": "No audio found in this file"}); return
                parts = split_utterances(pcm)
                emit({"type": "file_status", "stage": "transcribing", "progress": 0.0, "durationSec": duration, "utterances": len(parts),
                      "message": f"Transcribing {len(parts)} utterances with {self.backend.model_id}…"})
                log(f"[file {jid}] {duration:.1f}s of audio → {len(parts)} utterances")
                done_count = 0
                for (s0, s1) in parts:
                    if job["cancel"]:
                        emit({"type": "file_error", "error": "cancelled"}); return
                    audio = pcm[s0:s1].astype(np.float32) / 32768.0
                    text = self._transcribe_safe(audio)
                    done_count += 1
                    if text:
                        emit({"type": "file_segment", "start": round(s0 / SAMPLE_RATE, 2), "end": round(s1 / SAMPLE_RATE, 2), "text": text,
                              "progress": min(0.999, s1 / max(1, len(pcm))), "durationSec": duration})
                elapsed = int((time.time() - t0) * 1000)
                log(f"[file {jid}] done in {elapsed} ms ({duration / max(0.001, elapsed / 1000):.1f}x real time)")
                emit({"type": "file_done", "durationSec": duration, "segments": done_count, "elapsedMs": elapsed})
            except Exception as e:
                log(f"[file {jid}] error: {e}")
                emit({"type": "file_error", "error": str(e)})

        fut = loop.run_in_executor(None, work)
        try:
            while True:
                msg = await q.get()
                await websocket.send(json.dumps(msg))
                if msg["type"] in ("file_done", "file_error"):
                    break
        except Exception:
            job["cancel"] = True
        await fut

    def _start_interim(self, loop, websocket, conn, audio):
        seg = conn["seg"]
        fut = loop.run_in_executor(None, self._transcribe_safe, audio, True)
        conn["pending"] = fut
        conn["deferred"] = False
        asyncio.ensure_future(self._send_interim(websocket, fut, conn, seg.segment_id, loop))

    async def _send_interim(self, websocket, fut, conn, segment_id, loop):
        try:
            text = await fut
            seg = conn["seg"]
            # Drop it if the segment has already been finalized: a late interim would
            # otherwise overwrite the cleared interim line in the UI with old words.
            if text and seg.segment_id == segment_id:
                await websocket.send(json.dumps({"text": text, "isFinal": False}))
            # Audio kept arriving while we were busy: go straight into the next one,
            # unless a final for this segment is waiting its turn.
            if conn["deferred"] and not conn["final_pending"] and seg.segment_id == segment_id and seg.speaking():
                self._start_interim(loop, websocket, conn, seg.buffer.copy())
        except Exception:
            pass

    def _transcribe_safe(self, audio, interim=False):
        backend = self.interim_backend if (interim and self.interim_backend is not None) else self.backend
        with self.lock:
            try:
                return backend.transcribe(audio)
            except Exception as e:
                log(f"Inference error: {e}")
                status("error", message=f"Inference error: {e}")
                return ""


async def serve(args, backend):
    import websockets
    interim_backend = None
    if not args.no_interim:
        choice = (args.interim_model or "auto").strip()
        on_cpu = "cpu" in str(getattr(backend, "device", "")).lower()
        if choice == "auto":
            # On a GPU the main model already answers in well under half a second; on CPU
            # a small model keeps the live line moving while the big one does the finals.
            choice = ("base.en" if (backend.language or "en") == "en" else "base") if on_cpu else "none"
        if choice and choice != "none" and choice != args.model:
            try:
                status("loading", backend=backend.name, model=choice, device=backend.device, compute=backend.compute,
                       message=f"Loading the fast live-caption model ({choice})…")
                interim_backend = type(backend)(choice, args.device, args.compute, backend.language)
                log(f"Live captions use {interim_backend.model_id}; finals use {backend.model_id}")
            except Exception as e:
                log(f"Could not load interim model '{choice}' ({e}); using the main model for live captions")
                interim_backend = None
    server = Server(backend, interim=not args.no_interim, interim_s=args.interim_interval, interim_backend=interim_backend)
    async with websockets.serve(server.handle, args.host, args.port, max_size=8 * 1024 * 1024):
        url = f"ws://127.0.0.1:{args.port}"
        status("ready", url=url, backend=backend.name, model=backend.model_id, device=backend.device, compute=backend.compute,
               scriptVersion=SCRIPT_VERSION, interimModel=getattr(interim_backend, "model_id", None), interimSeconds=server.interim_s)
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
    p.add_argument("--interim-interval", type=float, default=None, help="seconds of new speech between interim updates (default 0.3 on GPU, 1.2 on CPU)")
    p.add_argument("--interim-model", default="auto", help="model for the live (interim) line: auto | none | base.en | small.en | base | small (auto = a small model on CPU, none on GPU)")
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
