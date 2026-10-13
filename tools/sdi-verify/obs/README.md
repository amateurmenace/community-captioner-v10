# OBS Studio as the control encoder

Scripts that drive OBS Studio (Windows, OBS 32 with the bundled DeckLink, Decklink Captions and obs-websocket plugins) as a second encoder on the same SDI, to separate "the SDI is wrong" from "the Web Presenter loses captions". Node 20+, `ws` from the repo's node_modules. None of this is part of the app.

| Script | What it does |
|---|---|
| `obs-setup.mjs` | `write` creates a profile and a scene collection both named **CaptionControl** (cloned from the operator's "Untitled" files, which are never changed): one scene, one DeckLink input, the Decklink Captions tool bound to it, desktop/mic audio off, x264 CBR to a local RTMP URL. `websocket-on` / `websocket-off` enable the obs-websocket server in `plugin_config` and restore the backup. `launch --password PW` starts `obs64.exe --collection CaptionControl --profile CaptionControl --websocket_password PW --disable-updater --disable-shutdown-check` (user.ini backed up); `restore` puts the operator's current profile/collection back after OBS has exited. |
| `obs-ws.mjs` | A small obs-websocket 5 client (importable): `version`, `status`, `inputs`, `devices <input>` (DeckLink device → `device_hash`), `modes`, `get-input` / `set-input <input> <json>`, `scene`, `start` / `stop`, `caption <text>` (SendStreamCaption), `captions-test [n] [ms] [tag] [--out schedule.json]` (numbered two-row captions for `yt-score.mjs`), `request <type> [json]`. |

## What was measured with it (2026-10-13, device 8 → loopback input 7 → OBS → x264 → `ffmpeg -listen`)

- **The SDI is complete and OBS forwards it losslessly**: the numbered CEA-608 pattern (240 unique pairs + 60 control codes) arrived 240/240 — OBS occasionally packs two pairs into one frame's SEI when its clock slips, which decoders accept. The Web Presenter 4K on the same SDI loses 21–50 % of caption frames, so the loss is the box's.
- libobs forwards **only the CEA-608 field-1 pairs** of each CDP (`add_caption` skips cc_type ≠ 0, null pairs and bad parity) and repacks everything queued since the last video packet into one A/53 SEI; CEA-708 never passes through OBS.
- OBS's own **SendStreamCaption** (libcaption) builds a whole pop-on caption — ENM RCL PAC(row 1) text PAC(row 2) text EOC EOC — in one SEI (up to 31 pairs) on rows 1–2, so YouTube draws it at the **top** of the picture (`line:0%`). On YouTube's caption track 18 of 20 captions sent 2.5 s apart arrived (two lost at 5-second segment boundaries).
- When the Decklink Captions tool is bound to a DeckLink input that carries any CDP, text captions starve: libobs prefers queued DeckLink cc_data for every packet and the text caption waits for an empty queue (3 of 12 got through, one 40 s late). Use one path or the other.

## The relay's OBS output

`POST /api/obs/config {enabled, url, password, displaySeconds}` and `GET /api/obs/status` (also on the Caption Injection screen, "OBS Studio captions"): every final caption goes to OBS over obs-websocket as `SendStreamCaption`. This is the embedded-caption path for operators whose encoder is OBS; it never touches the Web Presenter.
