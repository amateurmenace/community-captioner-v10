# Mac handoff — Windows session of 13 October 2026 (6.14.0, then 6.15.0 the same night)

Paste into the Mac Claude session after `git pull`. Everything below is on `main`; the Windows build
6.15.0 is attached to release v10.1. The Mac app needs a rebuild to pick up the shared changes; the
native addon did NOT change, so the addon built for Mac 6.13.3 can be reused (`npm run build:native`
is still the safe default when a DeckLink SDK is present).

## 6.15.0 on top of 6.14.0 (read CLAUDE.md "Live word feed and one caption session" first)

- `server/live-feed.js` (new) + `appendText()` on both encoders: interim words that the recognizer has
  stopped revising are appended to the roll-up encoders at once (CEA-608 rollup/rollup_pac, CEA-708
  rollup), so captions stream a second or two behind the speaker instead of a block per sentence. The final is
  aligned to the words already on air by content (fragments are completed, revised words skipped). Config keys
  `liveFeed` (default true), `liveFeedStable` (4), `liveFeedHold` (2), `liveFeedMinAge` (1200 ms), `liveFeedBreak`.
  Tests: `node test/test-live-feed.mjs` (30), `node test/test-cea708.mjs` (123), `node tools/e2e/live-feed-e2e.mjs --spawn`
  (virtual output, no hardware).
- The caption config persists in `DATA_DIR/caption-config.json`; `POST /api/inject/start {sourceKind:'virtual'}` +
  `GET /api/inject/cdps` run the frame loop without a DeckLink.
- UI: the Caption Injection screen drives the app's own session (five speech engines, Start/Stop, mirrors
  interims/finals to the relay while on view), has the "Where the captions go" setups, live-roll-up checkbox;
  the Dashboard has an SDI pill; the Output designer's "SDI CC" tab opens Caption Injection. The Web Presenter
  4K on software 3.5 forwards every caption frame (240/240 twice); 4.2.2 and 4.2.3 drop 36–50 %.
- Mac checks after the rebuild: the three test commands above against the packaged binary on a spare port
  (`node tools/e2e/live-feed-e2e.mjs --relay http://localhost:8090` without `--spawn`), `GET /api/caption/config`
  shows `liveFeed: true`, and with a DeckLink the roll-up on a decoder fills word by word.

## What changed (shared code — read CLAUDE.md addon note 20 and the "Gemini models" / "Cloud mode and
## the Gemini key" sections first)

- `server/cea708/cea608-encoder.js` — styles: `rollup_pac` (new default: RU2 RU2 CR CR PAC PAC text on every
  row — YouTube renders roll-up only with a PAC per row), `rollup` (the 6.11–6.13 form), `popon`
  (RCL ENM PAC(14) text PAC(15) text EOC), `painton`; `setControlRepeat(1|2)`, `setOneFrame({…})`,
  `setHoldFrames(n)`, `drainPairs()` per frame. `cea708-cdp-builder.js`: `buildCDP(pairs, rate, ccCount)`,
  `cea608Capacity()`, `svcInfoEvery`. Relay config keys: `cea608Style`, `cea608ControlRepeat`,
  `cea608OneFrame`, `cea608Copies`, `cea608CopyGap`, `cea608MaxPairs`, `cea608HoldFrames`, `cea608CcCount`,
  `cdpSvcInfoEvery`. Unit tests: `node test/test-cea708.mjs` → 106 pass.
- `server/obs-captions.js` (new) + `/api/obs/status`, `/api/obs/config` — every final caption to OBS Studio
  over obs-websocket (`SendStreamCaption`). Pure Node (`ws`), no platform code.
- `server/relay.js` — `GET /api/gemini/key` (loopback-only, see CLAUDE.md), the 608 config keys above.
- Gemini models moved (`caption-polisher.js`, `translation-service.js`, `context-learner.js`,
  `context-sources.js`, `services/geminiService.ts`, `App.tsx` legacy recognizer → `gemini-3.8-live`,
  `GlobalSettings.tsx` ping → `gemini-3.8-flash`); thinking budgets pinned; the wizard's research is
  two-step (grounded prose on 3.8-flash → JSON on 3.5-flash-lite). `sendRealtimeInput({ audio })`.
- Cloud mode key flow (`App.tsx`, `components/GlobalSettings.tsx`, `components/Dashboard.tsx`, `types.ts`):
  choosing Cloud never needs a key up front; Start opens Help & Settings → Cloud when none is stored and
  starts by itself after Save; the desktop app uses the relay's `.env.local` key without typing.
- `components/CaptionInjection.tsx` — Caption text (strategy + cap) row, CEA-608 **Style** select, **OBS
  Studio captions** panel. `components/HelpGuide.tsx` updated. `tools/e2e/cloud-e2e.mjs` (new): fresh
  Chrome profile + fake microphone driven over the DevTools protocol, verifies Cloud mode end to end.

## What to do on the Mac

1. `git pull && npm ci`, `node test/test-cea708.mjs` (106) and `node test/test-corrections.mjs` (32).
2. Rebuild and notarize: `npm run build:mac:notarized` (needs the Developer ID in the keychain and the
   `community-captioner` notary profile). The addon is unchanged since 6.13.3; if `native/decklink/build/Release`
   is missing, `npm run build:native` with the SDK as before.
3. Launch the packaged binary on a spare port and probe it:
   `PORT=8090 "build/Community Captioner.app/Contents/MacOS/CommunityCaptioner-bin"`, then
   `GET /api/app/info` (version 6.14.0, desktopApp true), `GET /api/context/capabilities` (`pdf`, `docx`, `upload`,
   `geminiKey` true, `model` gemini-3.8-flash), `GET /api/inject/status` (`addonLoaded`, `ndiAvailable`, `ndiRuntime`),
   `GET /api/gemini/key` from 127.0.0.1 (ok) and from the LAN address (403), `GET /api/obs/status`,
   `GET /api/caption/config` (`cea608Style` rollup_pac, `encodingMode` dtvcc, `dtvccStyle` atomic).
4. Cloud mode end to end: `node tools/e2e/cloud-e2e.mjs http://localhost:8090 /path/to/speech.wav` after changing
   `CHROME` in the script to `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` (and `taskkill` to
   `kill`); make the WAV with `ffmpeg -f lavfi -i "flite=text='The Select Board of the Town of Brookline …'" -ar 48000 -ac 1 -sample_fmt s16 speech.wav`.
   Expected: Gemini Live connected within ~2 s, the sentence on the Dashboard within ~6 s, no settings dialog, no key in localStorage.
5. If a DeckLink is attached: Caption Injection in CEA-608 mode with the default style, `decklink_probe` on a loopback input
   should decode rolling rows (the PAC is now on every row); the 708 default (one-frame) is unchanged.
6. Attach `build/Community-Captioner-6.15.0-mac-arm64.zip` to release v10.1 (`gh release upload v10.1 … --clobber`), delete the
   6.13.3 Mac zip from the release (`gh release delete-asset v10.1 Community-Captioner-6.13.3-mac-arm64.zip --yes`), point
   `MAC_DOWNLOAD_URL` in `utils/appLinks.ts` at the new file, update the release notes (intro line and the macOS row say 6.13.3;
   `gh release view v10.1 --json body --jq .body > notes.md`, edit, `gh release edit v10.1 --notes-file notes.md`), commit with
   `-c user.name="Stephen Walter" -c user.email="swalter4669@gmail.com"` and the Co-Authored-By trailer; never push `v*` tags,
   never commit `build/` or `.env.local`.

## Verdict to carry forward (so the Mac session does not re-open it)

The SDI and the CDPs are right (OBS on the same SDI forwards 240/240 caption pairs; the Web Presenter 4K 4.2.3 loses
21–50 % and forwards only one 608 pair per frame). YouTube renders CEA-608 pop-on and PAC-per-row roll-up correctly
on a lossless encoder; through the Web Presenter no 608 form survives, and the one-frame CEA-708 transport (default)
is the embedded path (19–30 of 20–30 captions). The caption-ingestion POST remains the full-quality YouTube path;
OBS (DeckLink input + Decklink Captions, or the OBS captions panel) is the way to embed 608 for YouTube.
