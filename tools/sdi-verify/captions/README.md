# Caption transport tools

Scripts for measuring embedded CEA-608/708 captions on the path DeckLink SDI → encoder (Blackmagic Web Presenter 4K) → RTMP/YouTube, and for scoring what a decoder would display. Node 20+, ffmpeg on PATH. None of this is part of the app.

| Tool | What it does |
|---|---|
| `dtvcc-model.mjs` | A small CEA-708 service-1 decoder model (windows, pen, SPL, CR, HCR, FF, DefineWindow/Clear/Delete, ETX). Used by the unit tests, the simulation and `dtvcc-display.mjs`. `clearOnRedefine` (default on) mimics YouTube's converter, which clears the window on every DefineWindow. |
| `sei-cc.mjs <capture> [--csv out]` | Per video frame: the CEA-608 field-1 pair and the DTVCC packet bytes in the H.264 A/53 caption SEI. Importable (`extractFrames`). |
| `dtvcc-display.mjs <capture> [--sent schedule.json] [--errors] [--quiet]` | Decodes a capture with the model and prints the display on every change; with a schedule it scores the run: % of frames correct / stale / mixed (one stale row) / garbled (text that was never sent) / blank, per phase, plus the delay of every caption. |
| `wp-redraw-test.mjs --relay http://localhost:8090 [--captions 40] [--interval 75] [--config '{…}'] [--tag R]` | Sends numbered captions through a running Caption Injection (CEA-708 only, verbatim) with the given transport settings and writes the schedule for `dtvcc-display.mjs`. |
| `wp-pattern.mjs 608\|708\|both` + `pattern-analyze.mjs cc.csv fromFrame` | The numbered CEA-608/708 pattern (240 unique pairs / 40 one-packet captions) and its per-frame survival map — how the Web Presenter's frame loss was measured. `RELAY=` overrides the relay URL. |
| `sei-write.mjs <in.ts> <out.ts> 608\|708\|both` | Rewrites a capture's caption SEI with the app's encoders → a known-good embedded-caption stream for testing a platform without the Web Presenter (`ffmpeg -re -stream_loop -1 -i out.mp4 -c copy -f flv rtmp://a.rtmp.youtube.com/live2/KEY`). |
| `yt-track.mjs <playlist-url-file> <fromUTC>` | Prints YouTube's live caption track (WebVTT segments from `yt-dlp --dump-json` → `automatic_captions.en[0].url`). |
| `wp-control.mjs <host> status\|capture-on <rtmp-url>\|capture-off\|start\|stop` | Points a Web Presenter at a local `ffmpeg -listen 1 -i rtmp://0.0.0.0:1935/live/test -c copy cap.ts` receiver through its REST API and restores the previous platform afterwards. The saved platform file contains a stream key: keep it out of git. |
| `rtmp-listen.sh` | Accepts Web Presenter connections one after another into `capN.ts`. |

## Measuring a transport through the Web Presenter

1. Start the packaged app on a spare port (`PORT=8090`), start Caption Injection on the output that feeds the Web Presenter (CEA-708, CEA-608 off).
2. `node wp-control.mjs 192.168.20.71 capture-on rtmp://<this pc>:1935/live` after starting `ffmpeg -listen 1 -i rtmp://0.0.0.0:1935/live/test -c copy cap.ts`.
3. `node wp-redraw-test.mjs --relay http://localhost:8090 --tag A --config '{"dtvccRepeat":2,"dtvccRepaintFrames":30}'` (one run per setting to compare).
4. Stop ffmpeg, then `node dtvcc-display.mjs cap.ts --sent schedule-A.json --quiet`.
5. `node wp-control.mjs 192.168.20.71 capture-off`.

The same scorer runs on a stream built with `sei-write.mjs` (no loss: expect 100 % correct) and on the simulation in the session notes, so numbers are comparable.
