# Embedded captions — rethink brief (hand-off from the Windows session of 12 Oct 2026)

**Mandate for the new session:** decide, with evidence, whether embedded CEA-608/708 captions from
Community Captioner can be made broadcast-reliable on the path *DeckLink SDI → Blackmagic Web
Presenter 4K → YouTube* (and on SDI in general), and either make it so or state plainly that it is
impossible with this encoder and what the alternatives are. Bound the effort: one focused session,
then a verdict. Do not re-derive what is proven below; start from the open questions.

## 1. What is proven (do not re-test)

1. **The app's SDI output is correct.** Every frame carries a SMPTE 334-2 CDP (VANC line 9 by
   default, selectable 0–41): 20 cc_data triplets, ccsvcinfo, checksum, sequence counter,
   RP188 VITC/LTC timecode. Verified three ways: a DeckLink loopback decoded all 240 pairs of a
   numbered CEA-608 pattern in order (`tools/sdi-verify/decklink_probe`), ffmpeg's `cc_dec`
   renders our 608 as two clean rolling rows, and YouTube renders our 708 when it does not go
   through the Web Presenter. Unit tests: `node test/test-cea708.mjs` (40 pass).
2. **Blackmagic Web Presenter 4K, software 4.2.3, drops caption-bearing frames in blocks.**
   Two units (192.168.20.71 and .106), direct cable from the DeckLink or through the Videohub,
   1080p29.97 / 1080i59.94 / 1080p30, VANC lines 9–20, with or without RP188, 608 pairs or
   DTVCC packets, 1 pair per 1/2/3/4 frames, repeated pairs — all the same: the H.264 output has
   an A/53 SEI on every frame, but 12–50 % of frames (50 % in the afternoon runs, 79–88 % kept in
   the evening runs) carry a null layout instead of the data that was on the SDI, in blocks of
   10–30 frames, surviving data on the frame it was sent on (no queueing). Nothing in the SDI
   changes it. Evidence and scripts: `Desktop\web-presenter-evidence\` on the Windows rig, report
   `tools/sdi-verify/WEB-PRESENTER-CAPTIONS-REPORT.md`, CLAUDE.md addon notes 11, 14.
3. **CEA-608 roll-up cannot survive that loss** (every lost pair = two missing characters, a lost
   CR merges rows). Pacing, repeating pairs and the VANC line do not help.
4. **YouTube renders CEA-708 service 1** (clean ffmpeg stream of our packets): one cue per row,
   `line:71%`. **YouTube's player positions the caption box from the DTVCC window anchor** —
   builds ≤ 6.12.0 defined the window with the row count in the anchor nibble (anchor 1,
   top-centre, at the left edge) so captions sat half off-screen on the left on every new caption;
   6.12.1 defines anchor 7 (bottom-centre), relative 50 %/90 %, rows − 1, 32 columns — **not yet
   seen on YouTube's player when this was written.**
5. **YouTube prefers CEA-608 when both are present and renders our 608 as single characters**
   ("m", "."), although ffmpeg decodes the same stream perfectly. Cause unknown (candidates:
   CR-before-text row sequence, RU2 per row, PAC only once; the old encoder, which sent no CR at
   all, produced multi-character fragments). For YouTube the app must send **708 only**
   (`cea608InDtvcc: false`).
6. **A YouTube broadcast that has once received 608 keeps using it for its lifetime.** Switching
   the app to 708-only produced nothing until the stream was ended and a new one started.
7. **Live result on a fresh broadcast, 708-only, through the Web Presenter (6.12.0, redraw every
   second):** YouTube showed the spoken captions. Defects seen: rows mixing old and new text when a
   redraw frame was dropped (corrected by the next redraw), captions flashing once a second
   (every redraw re-sent DefineWindow and YouTube's converter treats DefineWindow as "clear"
   — fixed in 6.12.2: DefineWindow only every fifth redraw), window at the left edge (item 4).
8. **The YouTube caption-ingestion POST works** (6.11.3; absolute UTC timestamp, epoch-seconds
   seq, `text/plain`) and bypasses the encoder entirely. It is the only path proven clean
   end-to-end today.
9. NDI PTZ cameras carry no audio; 6.12.x embeds any Windows audio input (or "what this PC
   plays on …") on the NDI → SDI output; verified with a tone on the loopback.

## 2. Current code (all on `main`, Windows build 6.12.2 published on release v10.1)

- `server/cea708/cea608-encoder.js` — 32-column wrap, `RU2 RU2 [PAC PAC once] CR CR <row>`,
  `setRollupRows`, `setPacing(paceFrames, repeat)`, `wrapRows()`.
- `server/cea708/dtvcc-encoder.js` — DefineWindow per CEA-708 §8.4.5 (see item 4); classic mode
  (`setRepaint(0)`: CW0, rows with CR, ETX) and repaint mode (`setRepaint(N)`: keep the visible
  rows, on every caption and every N frames send [DFW every 5th time] CW0, SPL(row,0) + row padded
  to 32 columns for each row, ETX — 82 bytes = 3 frames at 29.97).
- `server/cea708/cea708-cdp-builder.js` — `buildCDP` (608), `buildCDP_DTVCC(dtvcc, rate, cc1,
  cc2, cc608Valid)`, `dtvccCapacity(rate)` = 34 bytes/frame.
- `server/relay.js` — `captionConfig`: `encodingMode` cea608|dtvcc, `cea608InDtvcc`,
  `dtvccRepaintFrames` (default 30), `cea608PaceFrames`, `cea608Repeat`, `vancLine`, `rollupRows`,
  `maxCharsPerLine`, strategy; `/api/caption/config` GET/POST applies live; `/api/inject/start`
  (`sourceKind` ndi|sdi|standalone, `audioDevice`), `/api/audio/devices`; frame loop is a
  `setInterval` at the nominal rate pushing one CDP per tick into the addon's per-frame queue.
- `components/CaptionInjection.tsx` — CEA-708 options (608 alongside, redraw interval), audio
  device picker. `components/HelpGuide.tsx` — operator guidance.
- `native/decklink/src/` — `vanc_packet.cpp` (`SetCaptionLine`), `ndi_passthrough.cpp` (RP188,
  WASAPI audio written from the video thread), `wasapi_capture.cpp`, `addon.cpp` exports.
- Docs: CLAUDE.md addon notes 11–16, `MAC-HANDOFF-2026-10-12.md` (the Mac app has not been rebuilt
  with any of this yet).

## 3. Open questions, in priority order

1. **Window placement on YouTube with 6.12.1+** (relative 50 %/90 %, anchor 7). If still wrong,
   try absolute coordinates (rp = 0, anchor 7, anchor_v 74, anchor_h 105 for 16:9) and check what
   a reference encoder emits (e.g. libcaption's `cea708_define_window`, or captures from a
   broadcast 708 encoder). Read YouTube's player DOM/CSS for the caption box if needed.
2. **Make the 708 redraw robust against block loss.** Ideas not yet tried: one row per packet
   (a lost frame then damages one row, not the whole window); a 15-frame interval; sending each
   row as SPL + text + "erase to end of row" so stale tails never show; using *pop-on* style
   (write into a hidden window 1, then swap with DSW/HDW — a lost swap just delays); a 1-row window
   (36 bytes = 2 frames); measure with the numbered 708 pattern through the Web Presenter (RTMP
   capture + `sei-cc.mjs`) and define an acceptable loss figure for broadcast.
3. **Why YouTube's 608 decoder mangles our roll-up** (only matters if 608 must reach YouTube; it
   does not for us — 708 only). Test variants with the clean-stream tool: CR after text, PAC per
   row, pop-on (RCL/ENM/EOC). Keep SDI 608 as it is (standard decoders are happy).
4. **Is the loss in the Web Presenter avoidable?** Not from our side (proven). Things only
   Blackmagic or a different encoder can change: firmware (ask Blackmagic with the report),
   or replace the encoder for YouTube (vMix, OBS + caption plugin, Teradek, or ffmpeg from a
   DeckLink input on a PC — `-f decklink` is not in the choco ffmpeg build here).
5. **Decision rule.** If, after 1–2, 708+redraw through the Web Presenter gives readable,
   correctly placed captions with at most occasional one-second glitches, call it usable for
   the YouTube path and document the operator settings. If not, the honest answer is: embedded
   captions through *this* encoder are not broadcast-reliable; use the caption-ingestion POST
   for YouTube (clean) and keep embedded captions for SDI decoders, or change the encoder.

## 4. Tooling you will reuse (Windows rig, Claude scratchpad of session 293fb248… and `Desktop\web-presenter-evidence\`)

- Capture the Web Presenter: point it at `rtmp://192.168.20.211:1935/live/test`;
  `ffmpeg -listen 1 -i rtmp://0.0.0.0:1935/live/test -c copy cap.ts` (the looping `listen.sh` keeps
  re-spawning — stop the bash loop, not just ffmpeg).
- `sei-cc.mjs <ts|flv|mp4> [--csv out]` — per-frame 608 pair / DTVCC bytes from the SEI.
- `wp-pattern.mjs 608|708|both [1080p|1080i]` + `pattern-analyze.mjs cc.csv fromFrame` — exact
  per-frame survival map; `vanc-sweep.mjs` repeats it per VANC line.
- `sei-write.mjs <capture.ts> <out.ts> 608|708|both` — rewrites a capture's caption SEI with our
  encoders' output; then extract `.h264` and mux with silent AAC into MP4
  (`onsite/clean/clean-*.mp4`); `Desktop\youtube-caption-test.bat <mode> KEY` streams one to
  YouTube with ffmpeg (needs a *fresh* broadcast each time 608/708 presence changes).
- `yt-track.mjs <url-file> <fromUTC>` and raw segment fetches: YouTube's live caption track via
  yt-dlp `--dump-json` → `automatic_captions.en[0].url`; cue settings show `line:` only.
- ffmpeg's own 608 decoder: `ffmpeg -f lavfi -i "movie=file.mp4[out0+subcc]" -map 0:s:0 -f srt -`.
- Loopback probe: `build/sdi-verify/decklink_probe.exe 7 <seconds> -1 <dir>` (`CC_DUMP=N`).
- Audio: `tools/sdi-verify/audio_probe.cpp` (levels per Windows input).

## 5. Standing rules (unchanged)

Never print or commit the Gemini key; never commit `build\` or `.env.local`; no system installs;
build the addon from the VS Native Tools prompt (stop any dev relay first — it holds the .node
file); test the packaged exe, not dev mode; never push `v*` tags (CI overwrites the Windows addon
asset); only DeckLink device 8 ("Output C to Videohub Input 21") for output tests; the app is the
live program path to the Web Presenter — every restart blacks the stream, so batch changes; the
user runs the packaged app (port 8081 when 8080 is taken) — ask before taking over device 8.
Commit with `-c user.name="Stephen Walter" -c user.email="swalter4669@gmail.com"` and the
`Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` trailer.
