# Mac handoff — Windows session of 12 October 2026 (evening)

Paste into the Mac Claude session after `git pull`. Everything below is on `main`; the Windows
build 6.12.0 was published from it. The Mac app needs a rebuild to pick up the shared fixes.

## Shared code that changed (affects the Mac app as soon as it is rebuilt)

- `server/cea708/cea608-encoder.js` — rewritten. The old encoder never sent a carriage return
  (the relay called `enqueueText(text)` without the final flag) and wrote up to 64 characters on a
  32-column row, so on every real decoder the row filled, later characters piled into column 32
  and nothing ever rolled. Now: each caption is wrapped into 32-column rows, each row goes out as
  `RU2 RU2 [PAC PAC once] CR CR <text>`; `setRollupRows(2|3|4)`, `setPacing(paceFrames, repeat)`,
  exported `wrapRows()` / `CEA608_COLUMNS`. `test/test-cea708.mjs` updated (39 pass).
- `server/cea708/dtvcc-encoder.js` — repaint mode (`setRepaint(frames)`, default 30 via
  `captionConfig.dtvccRepaintFrames`): keeps the visible rows and re-sends the whole window 0
  (DefineWindow + SetPenLocation + rows padded to 32 columns + ETX, 3 frames) on every caption and
  every N frames, so a decoder behind a lossy encoder recovers within N frames. `setRepaint(0)`
  = the old roll-up behaviour. Imports `wrapRows` from the 608 encoder.
- `server/cea708/cea708-cdp-builder.js` — `buildCDP_DTVCC(..., cc608Valid = true)`; with `false`
  the two 608 triplets are `F8/F9 00 00` (708-only stream).
- `server/relay.js` — caption config gained `cea608PaceFrames`, `cea608Repeat`, `cea608InDtvcc`,
  `vancLine`, `dtvccRepaintFrames` (all on `/api/caption/config`); `normalizeFrameRate()` ("30.00"
  → "30"); finals from the Caption Injection screen are no longer encoded/POSTed twice
  (`source: 'inject'` on the WS copy + 5 s dedupe against the last `/api/inject/caption`);
  `/api/audio/devices`; `audioDevice` on `/api/inject/start` and `/api/ndi/start` (passed as the
  4th argument of `startNdiPassthrough`, ignored where the addon has no audio capture).
- `components/CaptionInjection.tsx` — CEA-708 options (608 alongside on/off, redraw interval),
  "Audio on the SDI output" dropdown in NDI mode (only shown when `/api/audio/devices` returns
  devices, i.e. never on macOS unless you add a CoreAudio equivalent), `source: 'inject'` on WS finals.
- `components/HelpGuide.tsx`, `CLAUDE.md` (addon notes 13–16), `utils/appLinks.ts`, `package.json`
  6.12.0.

## Addon changes (compile on macOS, Windows-only behaviour)

- `native/decklink/src/ndi_passthrough.{h,cpp}` — `Start(source, device, mode, const char*
  audioDeviceId = nullptr)`; `#ifdef _WIN32` WASAPI capture (`wasapi_capture.{h,cpp}`, listed only
  in the Windows CMake branch); the video thread writes the captured audio
  (`DrainAudioInput()`) — do not write DeckLink audio from another thread. RP188 VITC1 + LTC
  timecode on every output frame (`EnableVideoOutput(mode, VANC | RP188)` with a VANC-only
  fallback) — this part is platform-neutral, check it compiles with your SDK headers.
- `native/decklink/src/vanc_packet.{h,cpp}` — `SetCaptionLine(n)` / `GetCaptionLine()`; the packet's
  `GetLineNumber()` returns it (0 = driver default = line 9). Platform-neutral.
- `native/decklink/src/addon.cpp` — `setCaptionLine`, `getCaptionLine` exports (all platforms);
  `listAudioDevices` and the `audioDevice` status fields under `#ifdef _WIN32`.
- `tools/sdi-verify/audio_probe.cpp` (Windows only), `WEB-PRESENTER-CAPTIONS-REPORT.md` rewritten.

## What the Mac session should do

1. `git pull`, rebuild the addon and the app, run `node test/test-cea708.mjs`.
2. Verify on hardware that CEA-608 now rolls (two 32-column rows, new line per caption) on a
   real decoder, and that CEA-708 repaints look right (a window redraw every second must not
   flicker; if a decoder flickers, raise `dtvccRepaintFrames` or send `setRepaint(0)`).
3. Ship a Mac build and update `MAC_DOWNLOAD_URL` in `utils/appLinks.ts`.

## Update, night of 12 October: 6.13.0 / 6.13.1 (commit a7933b0 and later; 6.13.1 makes continuous the default CEA-708 transport)

All platform-neutral JavaScript; the Mac app only needs `git pull`, a rebuild and `node test/test-cea708.mjs` (61 pass).

- `server/cea708/dtvcc-encoder.js` — the repaint mode was rebuilt. Every frame now carries one
  self-contained packet (one service block: SetPenLocation(row, 0) + the row padded to 27 columns
  + ETX), DefineWindow goes out in its own packet with every new caption and never in a keep-alive,
  each caption's rows are re-sent `repeat` times `repeatGap` frames apart and the whole window every
  `repaintFrames` frames; `repaintFrames = 1` is "continuous" (rows alternate on every frame). Rows
  are 27 columns wide in this mode (32 do not fit one block in a 29.97 frame). Classic mode
  (`setRepaint(0)`) sends CR before each row, not after. New: `setRedraw({repeat, repeatGap,
  maxBlocks, rowErase, columns, defineOnChange})`, `setFrameCapacity(bytes)` (the relay calls it
  with `Cea708CdpBuilder.dtvccCapacity(frameRate)` when the frame loop starts), `.lines`, `.columns`.
- `server/relay.js` — `captionConfig` gained `dtvccRepeat` (2), `dtvccRepeatGap` (3), `dtvccBlocks`
  (1), `dtvccRowErase` ('pad'), `dtvccColumns` (0), `dtvccDefineOnChange` (true); `applyDtvccTransport()`;
  `/api/inject/status` reports `dtvccTransport`.
- `components/CaptionInjection.tsx` — re-send interval (never / continuously / 5 frames / ½ s / 1 s /
  2 s) and copies; `components/HelpGuide.tsx` text; `utils/appLinks.ts` Windows 6.13.0.
- `tools/sdi-verify/captions/` — CEA-708 decoder model, capture scorer, numbered-caption driver,
  Web Presenter REST control, YouTube live-track reader (README there). `tools/sdi-verify/captions/
  dtvcc-model.mjs` is imported by the unit tests.
- Why: measured through the Web Presenter at 35–40 % frame loss, keep-alive 1 s gave 75 % of frames
  correct and 36/40 captions complete; continuous gave 100 %, 40/40, worst delay 0.4 s, never a
  garbled row (CLAUDE.md addon note 17). Nothing to verify on Mac hardware beyond "it still
  encodes"; the Mac 608 path is untouched.
- Later the same night (commit ea01b45): `dtvccStyle` 'rollup' | 'popon' | 'youtube' and
  `dtvccKeepAlive` (relay config + `setRedraw({style, keepAlive})`), the Caption Injection
  "Transport" preset select (YouTube pop-on ×3 / immediate / continuous / ½ s / 1 s / classic),
  `tools/sdi-verify/captions/yt-live-captions.mjs` + `yt-score.mjs`. YouTube's converter rules and
  the live verdict are CLAUDE.md addon note 18: through the Web Presenter only ~2/3 of captions
  reach YouTube's track, so the caption-ingestion POST stays the YouTube path; embedded CEA-708
  (continuous) is the decoder path. All JavaScript, nothing platform-specific.

## Findings worth knowing

- Blackmagic Web Presenter 4K 4.2.3 (two units, direct cable or Videohub, 1080p29.97/1080i/1080p30,
  any VANC line) drops 15–50 % of caption-bearing frames in blocks, 608 and 708 alike. Our SDI is
  verified complete by a DeckLink loopback of the same seconds with a numbered pattern. CEA-608
  roll-up cannot survive that; 708 + repaint can, if the destination renders 708. YouTube's own 708
  rendering was still being tested with a clean ffmpeg stream (`Desktop\youtube-caption-test.bat`
  on the Windows rig) when this was written — see the next Windows handoff for the verdict.
- The YouTube caption-ingestion POST (6.11.3) remains the reliable YouTube path.
