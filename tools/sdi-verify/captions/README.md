# Caption transport tools

Scripts for measuring embedded CEA-608/708 captions on the path DeckLink SDI → encoder (Blackmagic Web Presenter 4K) → RTMP/YouTube, and for scoring what a decoder would display. Node 20+, ffmpeg on PATH. None of this is part of the app.

| Tool | What it does |
|---|---|
| `dtvcc-model.mjs` | A small CEA-708 service-1 decoder model (windows, pen, SPL, CR, HCR, FF, DefineWindow/Clear/Delete, ETX). Used by the unit tests, the simulation and `dtvcc-display.mjs`. `clearOnRedefine` (default on) mimics YouTube's converter, which clears the window on every DefineWindow. |
| `sei-cc.mjs <capture> [--csv out]` | Per video frame: the CEA-608 field-1 pair and the DTVCC packet bytes in the H.264 A/53 caption SEI. Importable (`extractFrames`). |
| `dtvcc-display.mjs <capture> [--sent schedule.json] [--errors] [--quiet]` | Decodes a capture with the model and prints the display on every change; with a schedule it scores the run: % of frames correct / stale / mixed (one stale row) / garbled (text that was never sent) / blank, per phase, plus the delay of every caption. |
| `wp-redraw-test.mjs --relay http://localhost:8090 [--captions 40] [--interval 75] [--config '{…}'] [--tag R] [--short N]` | Sends numbered captions through a running Caption Injection (CEA-708 only, verbatim) with the given transport settings and writes the schedule for `dtvcc-display.mjs` / `yt-score.mjs`; `--short N` makes one-row captions of at most N characters for the atomic style. |
| `wp-pattern.mjs 608\|708\|both` + `pattern-analyze.mjs cc.csv fromFrame` | The numbered CEA-608/708 pattern (240 unique pairs / 40 one-packet captions) and its per-frame survival map — how the Web Presenter's frame loss was measured. `RELAY=` overrides the relay URL. |
| `sei-write.mjs <in.ts> <out.ts> 608\|708\|both` | Rewrites a capture's caption SEI with the app's encoders → a known-good embedded-caption stream for testing a platform without the Web Presenter (`ffmpeg -re -stream_loop -1 -i out.mp4 -c copy -f flv rtmp://a.rtmp.youtube.com/live2/KEY`). |
| `yt-live-captions.mjs <watch-url> [--python <venv python>] [--minutes 3] [--json cues.json]` | Prints YouTube's live caption track (yt-dlp finds the unlisted live video and its WebVTT HLS track; every cue with time, settings and text), and with `--json` saves the cues for scoring. |
| `yt-score.mjs schedule.json cues.json [--from HH:MM:SS --to HH:MM:SS]` | Which captions of a `wp-redraw-test.mjs` run reached YouTube's track, when, for how long and whether complete (matched by the window text, in order, within the run's UTC window). |
| `yt-track.mjs <playlist-url-file> <fromUTC>` | Older reader of the same track from a saved playlist URL. |
| `wp-control.mjs <host> status\|capture-on <rtmp-url>\|capture-off\|start\|stop` | Points a Web Presenter at a local `ffmpeg -listen 1 -i rtmp://0.0.0.0:1935/live/test -c copy cap.ts` receiver through its REST API and restores the previous platform afterwards. The saved platform file contains a stream key: keep it out of git. |
| `rtmp-listen.sh` | Accepts Web Presenter connections one after another into `capN.ts`. |

## What YouTube's converter does with CEA-708 (measured 2026-10-12 with clean ffmpeg streams of the encoder's output)

- The window anchor is honoured: anchor 7 at 50 %/90 % gives `line:85%`, bottom-centre on the player. Padding spaces survive into the cue text, so rows are erased with HCR for YouTube.
- A caption cue is opened by DefineWindow or DisplayWindow and **closed, with its final text, by HideWindow** (or by a CR in roll-up). A DefineWindow while a cue is pending **discards** that cue. Every DisplayWindow **restarts** the pending cue; text re-writes separated by a few idle frames do not.
- Within a 5-second segment the segmenter keeps only the last of identical cues, so a window re-sent every N frames is shown for N frames at the end of each segment and otherwise vanishes (the 6.12.0 "flashing").
- A cue cut at a segment boundary carries the window as it was before the last write (one row short unless a settling write follows the last row); cues closed by HideWindow are complete.
- Hence the presets: pop-on (rows into the hidden window, DisplayWindow+HideWindow swap, 3 copies, no keep-alive) or hide+define+rows with copies for YouTube; continuous re-send for SDI decoders.
- **One-frame ("atomic") captions beat both the loss and the rules** (2026-10-13): DeleteWindow + DefineWindow + up to 23 characters + ETX in one packet, repeated six times four frames apart. Through the Web Presenter at ~50 % frame loss, 29–30 of 30 captions reached YouTube's track complete, appearing 0.7 s after they were sent. The Web Presenter re-packs every CDP to 20 triplets per frame (24/25 → 20 + a fragment; 31 wedges its caption reader until the stream is restarted), so 23 characters per frame is the ceiling. Long captions go out as consecutive parts (`dtvccAtomicHoldFrames`).

## Measuring a transport through the Web Presenter

1. Start the packaged app on a spare port (`PORT=8090`), start Caption Injection on the output that feeds the Web Presenter (CEA-708, CEA-608 off).
2. `node wp-control.mjs 192.168.20.71 capture-on rtmp://<this pc>:1935/live` after starting `ffmpeg -listen 1 -i rtmp://0.0.0.0:1935/live/test -c copy cap.ts`.
3. `node wp-redraw-test.mjs --relay http://localhost:8090 --tag A --config '{"dtvccRepeat":2,"dtvccRepaintFrames":30}'` (one run per setting to compare; the captions are unique two-row texts so the scorers can match them).
4. Stop ffmpeg, then `node dtvcc-display.mjs cap.ts --sent schedule-A.json --quiet`.
5. `node wp-control.mjs 192.168.20.71 capture-off`.

The same scorer runs on a stream built with `sei-write.mjs` (no loss: expect 100 % correct) and on the simulation in the session notes, so numbers are comparable.

## Measuring a transport on YouTube (through the Web Presenter or straight from ffmpeg)

1. Point the Web Presenter at YouTube (`wp-control.mjs <host> capture-off` restores the saved platform, `start` starts it), or stream a `sei-write.mjs` / clean file with ffmpeg to the stream key. The broadcast is unlisted: get the watch URL from YouTube Studio.
2. `node wp-redraw-test.mjs --relay http://localhost:8090 --tag Z --config '{"dtvccStyle":"popon","dtvccRepeat":3,"dtvccRepeatGap":3,"dtvccKeepAlive":false,"dtvccRowErase":"hcr"}' --out schedule-Z.json`, note the UTC start/end.
3. About a minute later: `node yt-live-captions.mjs <watch-url> --python <venv python> --minutes 5 --json cues-Z.json`, then `node yt-score.mjs schedule-Z.json cues-Z.json --from HH:MM:SS --to HH:MM:SS`.
