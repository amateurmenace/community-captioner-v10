# SDI verification tools

Small programs for proving that picture, sound and captions actually leave a DeckLink port when the app runs **NDI → SDI** (or any Caption Injection mode). They are not part of the app.

| Tool | What it does |
|---|---|
| `ndi_testsrc` | An NDI source with known content: 1920×1080 UYVY 75% colour bars plus a moving white box at 29.97p, and stereo audio with **1 kHz on the left, 440 Hz on the right** at NDI reference level (so the SDI should carry both tones at **−20 dBFS**). |
| `decklink_probe` | Listens on a DeckLink **input** and reports the detected mode, whether the bars match, the audio level of each tone on each channel, and the SMPTE 334 caption packets (DID 0x61/SDID 0x01) decoded to CEA-608 text. Ends with `RESULT vs ndi_testsrc: picture PASS/FAIL, audio PASS/FAIL, captions PASS/FAIL` and saves a still (BMP). `list` prints the devices; `scan` probes every input. |
| `ndi-sdi-run.mjs` | Drives the app's NDI → SDI injection through the relay API (the calls the Caption Injection screen makes), sends `CAPTION TEST n` every 3 s and prints frames/s, dropped frames and the caption queue. |

## Build

Both tools build on Windows and macOS. `decklink_probe` reuses the addon's `native/decklink/src/platform.h`; the build has been run on Windows (VS 2026, DeckLink SDK 15.3, NDI 6 SDK), not yet on macOS.

**Windows**, from an x64 Native Tools / `vcvars64` shell (MIDL must be on PATH), DeckLink SDK headers from the private draft release `sdk-internal-do-not-publish` (see WINDOWS-HANDOFF.md):

```powershell
cmake -S tools\sdi-verify -B build\sdi-verify -G "NMake Makefiles" -DCMAKE_BUILD_TYPE=Release -DBMD_SDK_DIR="<sdk>\Win\include"
cmake --build build\sdi-verify
```

`ndi_testsrc` is built when the NDI SDK is found (`NDI_SDK_DIR`, set by the NDI SDK installer). Run it with the NDI runtime folder on PATH, e.g. `$env:PATH = "C:\Program Files\NDI\NDI 6 Tools\Runtime;$env:PATH"`.

**macOS** (DeckLink and NDI SDK paths default to the same places as the addon; override with `-DBMD_SDK_DIR=… -DNDI_SDK_DIR=…`):

```bash
cmake -S tools/sdi-verify -B build/sdi-verify -DCMAKE_BUILD_TYPE=Release && cmake --build build/sdi-verify
```

## The on-wire test (needs a loopback)

1. **Pick the ports with whoever knows the wiring.** Device labels in Desktop Video can be wrong (they are on the Windows rig). Cable a free DeckLink SDI **output** to a free DeckLink **input**, or route it through the router. Never put the test signal on a port that might feed air.
2. **Baseline:** `decklink_probe scan 3 <outputIndex>` with nothing running, so you know which inputs already see a signal.
3. **Source:** start `ndi_testsrc 300`.
4. **App:** start the **packaged** app on a spare port (`PORT=8090`), then `node tools/sdi-verify/ndi-sdi-run.mjs "<HOST> (CC Test Source)" <outputIndex> 1080p29.97 90`. The exact source name is in `GET /api/ndi/sources`. Expect ~30 frames/s and 0 dropped.
5. **Capture:** while it runs, `decklink_probe <inputIndex> 10`. Expected:
   - `test bars matched 8/8` and a still that shows the bars and the box;
   - `tones: L 1 kHz -20.0 dBFS … R 440 Hz -20.0 dBFS` with the cross terms below −40 dB (a reading 20 dB higher means the NDI audio reference level is wrong again; see CLAUDE.md, Windows-specific addon notes, item 8);
   - `caption text` containing `CAPTION TEST 1 from the NDI to SDI check.` and the following numbers;
   - `RESULT vs ndi_testsrc: picture PASS, audio PASS, captions PASS`.

If the input reports no signal, it is the wrong input or cable. If an input refuses to open it is in use by another application, or it is the same physical connector as the output (DeckLink 8K Pro sub-devices pair up; on the Windows rig #10 cannot open while #8 outputs).

## Gotchas

- **Local NDI sources invisible?** On the Windows rig `C:\ProgramData\NDI\ndi-config.v1.json` restricts NDI to an adapter the PC does not have, so a local sender never shows up. Do not edit that file (the switcher uses it). Give only your test processes a different config: put `{ "ndi": { "networks": { "ips": "<this PC's IP>", "discovery": "" } } }` in a folder as `ndi-config.v1.json` and set `NDI_CONFIG_DIR` to that folder for both `ndi_testsrc` and the app.
- **No loopback available?** What the app hands the card can still be checked from inside the addon: on 2026-10-12 a scratch build with read-back hooks (output frame dump, caption packet read-back after `AttachPacket`, audio samples accepted and buffered by `WriteAudioSamplesSync`, `IDeckLinkStatus`) proved the frame bit-identical to the source, a caption packet on every frame and −20.0 dBFS audio. That proves the app side, not the cable; see CLAUDE.md item 8.
