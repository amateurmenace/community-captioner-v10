# Community Captioner v10

AI-powered live captioning platform for community media. Bridges professional broadcast with accessible subtitles using Gemini AI, local Whisper/Ollama, and DeckLink SDI hardware. Includes phone-based audience captioning via WiFi/QR code, and an AI-powered Context Engine that learns proper nouns from agendas and live speech.

## Quick Start

```bash
npm run dev              # Vite (5173+) + Relay (8080) concurrent
npm run build:native     # Compile C++ DeckLink/NDI addon
npm run dist             # Full Electron build (dmg/exe/AppImage)
npm run build:mac        # Standalone macOS .app (double-click launch)
npm run build:windows    # Standalone Windows .exe (double-click launch)
npm run build:app        # Build for current platform
```

## Standalone Desktop Builds

`scripts/build-app.js` produces lightweight standalone apps that bundle Node.js + the server + frontend into a single double-clickable package. No Node.js installation required on the target machine.

### Build Commands

- `npm run build:mac` → `build/Community Captioner.app` (~56 MB)
- `npm run build:windows` → `build/CommunityCaptioner.exe` (~51 MB)
- `npm run build:app` → builds for whichever platform you're on
- `npm run build:app -- --platform all` → builds both

### How It Works

1. `vite build` → `dist/` (frontend)
2. `esbuild` bundles `server/relay.js` + all deps → `server.cjs`
3. `@yao-pkg/pkg` wraps Node.js + server + frontend into a single binary
4. (Mac) wraps binary in a `.app` bundle with `dist/` in `Resources/`
5. (Windows) `dist/` is embedded in the `.exe` via pkg snapshot

On launch: starts relay server on port 8080, opens system browser automatically.

### DeckLink Native Addon on Windows

**The DeckLink addon MUST be compiled on the target platform.** It cannot be cross-compiled from Mac to Windows. To build a Windows `.exe` with DeckLink support:

1. **Must be done on a Windows machine** with:
   - [DeckLink Desktop Video](https://www.blackmagicdesign.com/support/) installed (includes SDK)
   - [Node.js 20+](https://nodejs.org/)
   - [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with C++ workload
   - NDI SDK (if NDI passthrough is needed)

2. Clone the repo on Windows and run:
   ```bash
   npm install
   npm run build:native    # compiles decklink_addon.node for Windows
   npm run build:windows   # builds the standalone .exe
   ```

3. The build script should be updated to automatically include `native/decklink/build/Release/decklink_addon.node` in the `.exe` if it exists.

4. **Fallback**: If the addon wasn't compiled at build time, you can place a Windows-compiled `decklink_addon.node` next to `CommunityCaptioner.exe` and the server will load it from there (see fallback in `relay.js` line ~210).

`npm run build:windows` on a Windows machine now bundles an in-tree `native/decklink/build/Release/decklink_addon.node` automatically and zips `build/windows-bundle/` to `build/Community-Captioner-<version>-windows-x64.zip`. The step-by-step brief for producing and verifying a Windows release (including the packaged-exe probes) is `WINDOWS-HANDOFF.md`.

### macOS .app Bundle Structure
```
Community Captioner.app/
  Contents/
    Info.plist
    MacOS/CommunityCaptioner        (shell launcher: opens Terminal.app running the binary, falls back to exec)
    MacOS/CommunityCaptioner-bin    (pkg binary: Node 20 + server.cjs + dist snapshot)
    MacOS/decklink_addon.node       (macOS DeckLink addon, copied from native/decklink/build/Release — run build:native first)
    Resources/dist/                 (frontend assets; DIST_PATH points here)
    Resources/.env.local            (Gemini key, optional; relay.js checks <Resources>/.env.local and <exe dir>/.env.local)
```
`npm run build:mac` also **codesigns** the bundle (inner Mach-O files first, then the bundle) with the "Developer ID Application" identity from the keychain when present — with the **hardened runtime** and `electron/entitlements.mac.plist` (allow-jit + unsigned-executable-memory for Node, disable-library-validation so the Blackmagic-signed DeckLinkAPI.framework can load, audio-input, network) — otherwise ad-hoc, and writes `build/Community-Captioner-<version>-mac-arm64.zip` (via `ditto`, with `README-MAC.txt`) ready to attach to a GitHub release. Non-code files must not live in `Contents/MacOS/` or codesign fails ("code object is not signed at all / In subcomponent …"); the script removes strays (e.g. a `.data` folder from a test launch) before signing. Packaged builds keep their data in `~/.community-captioner/data/` (`DATA_DIR` in context-learner.js) for the same reason — writing inside the bundle would break the seal.

**Notarization** — `npm run build:mac:notarized` (= `--notarize` / `NOTARIZE=1`) submits the signed app with `xcrun notarytool submit --wait`, prints the notary log on rejection, staples the ticket and verifies with `spctl`. Credentials, first match wins: keychain profile `NOTARY_PROFILE` (default `community-captioner`) → `APPLE_API_KEY`/`APPLE_API_KEY_ID`/`APPLE_API_ISSUER` → `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`. One-time local setup:
```bash
xcrun notarytool store-credentials community-captioner --apple-id <apple id email> --team-id 6M536MV7GT --password <app-specific password>
```
Without credentials the build is signed only and first launch needs right-click → Open (the README in the zip explains; on macOS 15+ it is System Settings → Privacy & Security → Open Anyway).

**CI** (`.github/workflows/build-mac.yml`, `macos-14` runner): builds the addon from the SDK headers with `BMD_LINK_FRAMEWORK=OFF` (DeckLinkAPIDispatch.cpp loads the framework at runtime, so Desktop Video isn't needed to compile), imports the Developer ID `.p12` from secrets into a temp keychain, runs `npm run build:mac` with `NOTARIZE=1`, uploads the zip as an artifact and attaches it to the (draft) release for `v*` tags. Secrets: `MACOS_CERTIFICATE_P12` (base64 .p12), `MACOS_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, optional `GEMINI_API_KEY` (written to `.env.local`) and `BMD_SDK_URL` (else the `sdk-internal-do-not-publish` draft release is used).

### Important Notes

- Each build wipes intermediate files but preserves other platform outputs in `build/`
- **Server dependencies must be static `import`s.** Anything loaded via `createRequire(import.meta.url)('pkg')` at runtime is invisible to esbuild and cannot be resolved inside the pkg snapshot — multer and pdf-parse were loaded that way, which silently disabled uploads and PDF parsing in every packaged build while dev mode worked. After building, launch the binary on a spare port (`PORT=8090 "build/Community Captioner.app/Contents/MacOS/CommunityCaptioner-bin"`) and check `GET /api/context/capabilities` reports `upload:true, pdf:true` and `GET /api/inject/status` reports `addonLoaded:true`.
- The `DIST_PATH` env var tells the server where to find frontend assets (set automatically by the launcher)
- Browser globals (`DOMMatrix`, `ImageData`, `Path2D`) are polyfilled in the launcher for pdf-parse compatibility
- The `@napi-rs/canvas` warning on startup is harmless (optional dep for PDF rendering)

## Architecture

```
Browser/Electron UI (React 18 + TypeScript)
    ↕ WebSocket JSON
Relay Server (server/relay.js, port 8080)
    ↕ N-API
C++ Native Addon (native/decklink/)
    ↕ DeckLink SDK + NDI SDK
SDI Output with CEA-708 VANC captions
```

### Caption Pipeline

```
Audio → Gemini Transcribe Live / Gemini native audio / Whisper / WebSpeech → Text
  → Context Engine (shared/corrections.js: exact + phonetic dictionary matching, profanity filter, auto-learned corrections)
  → Caption Polisher (capitalize, punctuate, fix contractions, optional Gemini summarize)
  → Strategy Router (truncate / summarize / verbatim based on user config)
  → CEA-608 Encoder (text → CC byte pairs, configurable roll-up 2 or 3)
  → DTVCC Encoder (text → Service 1 blocks, higher throughput) [optional, parallel]
  → CDP Builder (CC pairs + DTVCC data → SMPTE 334 CDP packets)
  → decklink.pushCDP() → VANC embedding on SDI output (via CDP queue, one per frame)
```

**Critical**: Only FINAL captions are fed to encoders. Interim/partial results are skipped everywhere — in relay.js `feedCaptionToEncoder()`, electron/main.js, and `forwardToCea708()`. Sending interims causes garbled overlapping text because CEA-608 cannot erase and rewrite.

**Critical**: The native C++ addon uses a **queue** (not a single buffer) for CDP packets. Each CDP is consumed exactly once per output frame. The old single-buffer approach caused each character to repeat across dozens of frames, producing garbled output like "onononlolog".

## Key Files

| File | Purpose |
|------|---------|
| `server/relay.js` | Express + WebSocket relay, DeckLink REST API, caption config, encoder orchestration, Context Engine endpoints (SSE), local proper noun extraction fallback |
| `server/caption-polisher.js` | Two-layer text cleanup: local rules (capitalize, contractions) + Gemini AI (grammar, summarize) |
| `server/context-learner.js` | Auto-Learn engine (buffers live captions, extracts proper nouns via Gemini, accept/dismiss suggestions) + `extractDictionary()` (chunked Gemini extraction from document text) + `generateMishearings()` |
| `server/context-sources.js` | Source ingestion for the Context Engine: pdf-parse v2 wrapper, DOCX reader, HTML→text, browser-like fetch, Google-grounding redirect resolution, link discovery, Municipality Wizard (`locateMunicipalitySources`, `researchMunicipality`), Gemini `urlContext` page reading for bot-blocked sites, `itemsToEntries()` (names → correction rules) |
| `server/profiles.js` | Named Context Engine profiles stored as JSON under `DATA_DIR/profiles/` (list / save / merge / delete) |
| `shared/corrections.js` | Correction engine used by **both** the browser and the relay: Metaphone-style `phoneticKey()`, `buildCorrectionIndex()`, `applyCorrections()` (exact pass, then sounds-like pass gated by sensitivity), `diffForRules()` (operator edit → proposed rules). Tests in `test/test-corrections.mjs` |
| `utils/languages.ts` | The 15 translation languages (code, English name, native name, flag) shared by the Dashboard picker, the audience view and Gemini prompts. Mirror of `SUPPORTED_LANGUAGES` in `server/translation-service.js` |
| `local/whisper_server.py` | Bundled local speech server: faster-whisper (CPU/NVIDIA) or mlx-whisper (Apple GPU), energy VAD segmentation, interim + final captions over WebSocket, `__WHISPER_STATUS__` lines for the launcher |
| `server/local-stack.js` | System probe, speech-server launcher (uv or venv), log/status SSE, Ollama models/pull/test/start, model recommendations |
| `components/LocalSetup.tsx` | Guided local setup wizard: machine check → speech engine (install, start, mic test) → optional Ollama brain → finish |
| `.github/workflows/build-mac.yml` | CI: builds the addon without Desktop Video (`BMD_LINK_FRAMEWORK=OFF`), signs with the Developer ID cert from secrets, notarizes, staples, attaches the zip to the release |
| `server/translation-service.js` | Server-side Gemini translation with LRU cache and in-flight dedup for audience phone view |
| `server/cea708/cea608-encoder.js` | CEA-608 Roll-Up 2/3 encoder with line breaking, dedup, configurable rows |
| `server/cea708/dtvcc-encoder.js` | CEA-708 DTVCC Service 1 encoder (~200+ chars/sec throughput) |
| `server/cea708/cea708-cdp-builder.js` | SMPTE 334 CDP builder: `buildCDP()` for CEA-608, `buildCDP_DTVCC()` for dual-mode |
| `native/decklink/src/addon.cpp` | N-API bindings exposing 8 JS functions |
| `native/decklink/src/ndi_passthrough.cpp` | NDI receive → DeckLink SDI output + audio resampling + VANC (CDP queue) |
| `native/decklink/src/vanc_packet.cpp` | IDeckLinkAncillaryPacket impl (DID=0x61, SDID=0x01, line 9) |
| `native/decklink/src/output_handler.cpp` | Standalone mode (black frames + captions, CDP queue) |
| `native/decklink/src/passthrough.cpp` | SDI in → SDI out + captions (CDP queue) |
| `components/Dashboard.tsx` | Main control center: recording, live preview, relay connection, QR code modal, "Learn" pill (Auto-Learn toggle) + suggestion toasts with 10s auto-accept |
| `components/OutputSettings.tsx` | Caption Output Designer: DeckLink/NDI config, Caption Processing settings |
| `components/ContextEngine.tsx` | Context Engine UI: Municipality Wizard (SSE research with grouped, selectable results + optional deep scan of official pages), PDF/DOCX upload with preview, paste/URL extraction with preview, Quick Names, Meeting Body, dictionary management, settings with how-to guide |
| `components/AudienceView.tsx` | Phone caption viewer: auto-reconnect, dark/light mode, font sizes, fullscreen |
| `App.tsx` | Root component, audio capture, WebSocket connection, state management. Landing → deployment choice (cloud only) or straight to workflow picker (local). |
| `electron/main.js` | Electron main process, DeckLink IPC, frame loop (filters to isFinal only) |
| `types.ts` | TypeScript types including CaptionEncodingConfig, ContextSettings, DictionaryEntry |

## REST API Endpoints (port 8080)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/ip` | GET | Local IP, port, public URL, CEA-708 status |
| `/api/decklink/devices` | GET | Enumerate DeckLink devices |
| `/api/decklink/status` | GET | Current output status (mode, frames, drops) |
| `/api/decklink/start` | POST | Start standalone or passthrough output |
| `/api/decklink/stop` | POST | Stop DeckLink output |
| `/api/decklink/clear` | POST | Clear caption display |
| `/api/ndi/sources` | GET | Discover NDI video sources on network |
| `/api/ndi/start` | POST | Start NDI→SDI passthrough with captions |
| `/api/caption/config` | GET | Current caption encoding config |
| `/api/caption/config` | POST | Update encoding mode, strategy, max chars, rollup rows, polish |
| `/api/caption/metrics` | GET | Caption queue depth, encoder stats, dropped count |
| `/api/polisher/status` | GET | Polisher status (local enabled, Gemini enabled, key set) |
| `/api/polisher/toggle` | POST | Toggle Gemini AI polishing on/off |
| `/api/polisher/apikey` | POST | Set Gemini API key for summarization/polish/learning |
| `/api/audience-url` | GET | Audience view URL, backup URL, viewer count |
| `/api/context/status` | GET | Auto-learn enabled state, API key presence |
| `/api/context/enable` | POST | Toggle auto-learn on/off |
| `/api/context/suggestions` | GET | Pending auto-learned suggestions |
| `/api/context/accept` | POST | Accept an auto-learned suggestion into dictionary |
| `/api/context/dismiss` | POST | Dismiss/reject an auto-learned suggestion |
| `/api/context/names` | POST | Generate STT mishearing entries from a list of names (uses Gemini, falls back to lowercase) |
| `/api/context/capabilities` | GET | What this server can do: `{pdf, docx, upload, geminiKey, model, researchGroups}` |
| `/api/context/wizard/research` | POST (SSE) | Municipality Wizard: `{query}` → streams `status`, `sources`, `research_start`, `group` (items with ready-made entries), `done`/`error` |
| `/api/context/search-municipality` | POST | Wizard phase 1 only (official site + useful pages), non-streaming |
| `/api/context/scrape` | POST | Scrape a URL (HTML or PDF) for proper nouns; falls back to Gemini `urlContext` when the site returns 403 or is JS-only |
| `/api/context/scrape-stream` | POST (SSE) | Same as scrape with per-phase progress (`fetching`→`parsed`→`extracting`/`ai_fetch`→`entries`→`done`) |
| `/api/context/discover-links` | POST | List relevant same-site links (officials, departments, agendas…) on a page |
| `/api/context/extract` | POST | Extract proper nouns from pasted text (chunked for long documents) |
| `/api/context/upload-pdf` | POST | Upload PDF / DOCX / TXT / HTML (multipart `file`), returns entries + `preview`, `pages`, `kind` |
| `/api/context/dictionary` | GET / POST | Server-side mirror of the active dictionary (the browser POSTs it + `sensitivity` on every change; rebuilds the relay's correction index) |
| `/api/context/dictionary/export` `/import` `/delete` | GET / POST / POST | Download, merge/replace, remove one entry |
| `/api/context/apply` | POST | `{text, sensitivity?}` → what the dictionary would do to that text (`{text, applied[]}`) |
| `/api/context/profiles` | GET / POST | List named profiles / save `{name, entries, municipality?, merge?}` (name is slugified into the id) |
| `/api/context/profiles/:id` | GET / DELETE | Load one profile with its entries / delete it |
| `/api/inject/caption` | POST | `{text, isFinal?, applyDictionary?}` → feeds the SDI encoder; the relay applies the dictionary to REST-injected captions (Dashboard captions arrive already corrected) |
| `/api/youtube/caption-url` | GET | Current YouTube caption ingestion URL + last-POST status |
| `/api/youtube/caption-url` | POST | Set/clear YouTube caption ingestion URL (body: `{url: "..."}` or `{url: ""}` to clear) |

## WebSocket Paths

- **`ws://localhost:8080/`** — Main relay. Clients join with `{type:'join', sessionId, role}`. Broadcasts captions within sessions. Final captions are polished before broadcast.
- **`ws://localhost:8080/cea708`** — CEA-708 bridge endpoint. Only final captions forwarded (no interims).

## Context Engine

The Context Engine is a knowledge graph builder that teaches the captioning system local names, places, and acronyms. Accessible via the "Context Engine" button on the Dashboard.

### Tools Tab (Left Panel)
Top-to-bottom layout organized by workflow priority:

**Municipality Wizard** (inline at top) — `POST /api/context/wizard/research` (SSE)
- Type a municipality ("Brookline, MA") → the server runs two things concurrently:
  1. **Locate** (≈8s): Gemini + Google Search grounding finds the official site. Grounding returns opaque `vertexaisearch…/grounding-api-redirect/…` URLs, so the server resolves each redirect (HEAD, manual redirect) to the real page, merges URLs the model wrote in its answer, picks the official host (most frequent .gov/.us/.org), crawls the homepage for officials/departments/agenda links, fetches real `<title>`s and dedupes. Emits a `sources` event.
  2. **Research** (≈20–45s): four parallel Google-grounded Gemini calls (people, boards/organizations, places/schools, acronyms/terms) return JSON items `{name, category, detail, misheard[]}`. Each group streams as a `group` event the moment it finishes; items arrive with their dictionary `entries` already built by `itemsToEntries()`.
- UI shows a step list (official site + 4 groups with live status/elapsed), then grouped results with checkboxes (select all / per-group), "N names · M correction rules", and one "Add … to dictionary" button. Dedupes against the existing dictionary.
- "N pages" toggle reveals the official pages found; **Deep scan** runs `scrape-stream` on the selected pages 3 at a time (per-URL phase feed) for additional names from the pages themselves.
- Many CivicPlus-hosted town sites (e.g. brooklinema.gov) sit behind Cloudflare and return **HTTP 403 to any server-side fetch**. The wizard still works because research is search-grounded, and deep scan / URL scrape fall back to Gemini's `urlContext` tool, which reads the page from Google's side (works on those sites; ≈10s per page).
- Entry generation (`itemsToEntries`): lowercase form → correct form, each `misheard` variant → correct form, acronyms also get a spelled-out "d p w" variant and their expansion as a proper noun; single common English words are never used as a bare `original` (a rule "green → Greene" would rewrite every "green"); URL/domain/web-chrome names are dropped.

**Meeting Prep**
- **Quick Names**: Paste a list of names (one per line or comma-separated). AI generates STT mishearing corrections via Gemini (e.g., "Pham" → original: "fam"). Shows preview before adding to dictionary. Falls back to lowercase→original without API key.
- **Meeting Body Setup**: Structured form with Body Name, Members list, and Acronyms (format: `CIP = Capital Improvement Plan`). Parses acronyms automatically into dictionary entries.

**Document Ingestion** (every tool shows a **preview** with Add All / Discard — nothing lands in the dictionary unreviewed, and no `alert()` dialogs)
- **PDF / DOCX Upload**: Drag & drop or click. PDF via pdf-parse **v2** (`new PDFParse({data}).getText()` — the v1 `pdfParse(buffer)` call form throws "not a function"), DOCX via a built-in zip/XML reader, TXT/HTML as text. Scanned PDFs (no text layer) get a clear warning.
- **Paste Text**: Paste agenda/minutes text for AI extraction.
- **URL Scraper**: Any page or online PDF; 403/JS-only pages are read by Gemini `urlContext`.
- Long documents are split into ~24k-char chunks (max 6) extracted in parallel (3 at a time) and merged.

**Dictionary persistence**: the dictionary and engine name are saved in `localStorage` (`cc_dictionary`, `cc_context_name`) and mirrored to the relay (`POST /api/context/dictionary`, debounced) so reloads don't lose it and the learner can dedupe against it. Entries carry optional `note` (role/expansion, shown in the UI) and `source` (wizard, document, paste, url, names, manual, auto_learned, operator_edit, profile).

**Named profiles** (header → Profiles): save the current rules under the engine name on the relay (`DATA_DIR/profiles/<slug>.json`), list/load (replace) / merge / delete. Profiles are server-side so every operator machine on the LAN sees "Brookline Select Board". Loading a profile sets the engine name and the active context name.

### How corrections are applied (shared/corrections.js)
`applyCorrections(text, index, { sensitivity })` runs in the browser for every final caption (`App.processText`) and in the relay for REST-injected captions:
1. **Exact pass** — every rule's `original` as a case-insensitive word-boundary regex, longest first (the behaviour the app always had).
2. **Phonetic pass** — tokens are keyed with a Metaphone-style `phoneticKey()` ("Greene"/"green" → `KRN`, "Pearlman"/"Perlman" → `PRLMN`); windows of 1–6 words are compared against the concatenated key of each rule's `original` **and** `replacement`, so word splits don't matter ("Weintraub" ≈ "wine troub"). Gated by **Correction Sensitivity** (Context Engine → Settings): `<30` exact only · `30–69` + multi-word names · `≥70` + single names. Single-word matches never touch common English words (`COMMON_WORDS`), acronyms, or words under 4 letters. Replaced text keeps the window's punctuation.
3. Applied rules are reported as `{matched, replacement, mode: 'exact'|'phonetic'}` and shown in the Dashboard "Corrections Log" with "(sounds-like)" for phonetic hits. Settings has a "Try a sentence" box that previews the result live.

**Learn from operator edits**: when the operator edits a caption on the Dashboard, `diffForRules(old, new)` finds replaced word spans (LCS diff, expanded to adjacent capitalized words so "Greene" becomes "Bernard Greene"), skips single common words and numbers, and proposes rules as toasts ("From your edit — add a rule?"). Accepted rules get `source: 'operator_edit'`.

**Active Rules Panel** (right side)
- Entry count badge, search bar (appears at 3+ entries), color-coded type filter pills (proper noun / place / acronym / correction)
- Compact dictionary entries with type badges (PN/PL/AC/FX)
- Clear All button with confirmation (appears at 5+ entries)
- Import/Export engine as JSON

### Settings Tab
- **Gemini API Key**: Required for AI-powered extraction and auto-learn. Shows connected/not-set status. Link to get free key at aistudio.google.com/apikey
- **Auto-Learn**: Toggle to enable real-time proper noun extraction from live captions. Requires Gemini API key. Learned words appear as toast notifications with 10-second auto-approve timer
- **Profanity Filter**: Toggle to replace profanity with asterisks
- **Correction Sensitivity**: Slider (0-100%) controlling how aggressively dictionary substitutions are applied
- **Acronym Expansion**: Toggle to expand acronyms to full form
- **Domain Context**: Dropdown to select broadcast type (Municipal Government, Education, Legal, Medical, Religious, Sports) for AI prioritization
- **How-To Guide**: 5-step workflow guide for operators
- **Tips for Best Results**: Practical advice for production use

### Auto-Learn System (server/context-learner.js)
- Buffers live caption text in 30-second windows. The relay feeds every polished final caption (`learnerFeedText` in the WebSocket handler) — it used to be fed only inside the DeckLink encoder path, so Auto-Learn never saw text in browser mode.
- Sends buffer to Gemini for proper noun extraction
- Returns suggestions with original (misheard) and replacement (correct) forms
- Dashboard polls `/api/context/suggestions` every 5s while enabled and shows toast notifications in the bottom-right corner (Accept / Reject, countdown bar)
- Auto-approves after 10 seconds unless rejected; the toast header has an "auto-accept on/paused" toggle
- "Learn" pill button in Dashboard top nav bar toggles on/off (`POST /api/context/enable`) and shows the dictionary size
- **Live status in Settings**: buffer progress bar, extraction count, pending suggestions, last extraction timestamp
- Tracks `lastExtractionTime`, `extractionCount`, `isExtracting` in status API

### Quick Names API (server/context-learner.js)
- `generateMishearings(names, apiKey)` — generates STT mishearing entries for a list of names
- Uses Gemini to predict phonetic confusions (e.g., "Pham" → "Fam", "Greene" → "Green")
- Falls back to simple lowercase→original case entries without API key
- Capped at 50 names per request, 8-second timeout

### PDF/Document Extraction
- Uses `pdf-parse` **v2** (`PDFParse` class) via `extractPdfText()` in `server/context-sources.js`; DOCX via `extractDocxText()`; dispatch by filename/mimetype in `extractUploadedText()`
- Sends extracted text to Gemini (`extractDictionary`, chunked) for proper noun identification; items → entries via `itemsToEntries()`
- API key resolution for every Context endpoint: body `apiKey` → `X-Api-Key` header → server key from `.env.local` (`resolveRequestKey()` in relay.js). The browser does not need its own key when the server has one.
- **Local fallback extraction** (no API key anywhere): regex-based extraction of capitalized multi-word names, acronyms in parentheses, street addresses, organization names
- CORS headers include `X-Api-Key` for cross-origin uploads from Vite dev server

### Dictionary Format
```json
[
  { "original": "bernard green", "replacement": "Bernard W. Greene", "type": "proper_noun" },
  { "original": "ada", "replacement": "ADA", "type": "acronym" },
  { "original": "coolidge corner", "replacement": "Coolidge Corner Theatre", "type": "place" }
]
```

## Live Translation (Audience Phone View)

Server-side translation enables each audience member to independently choose their language. Translations are cached and shared across viewers requesting the same language.

### Architecture
```
Final English caption arrives at relay
  → Send English immediately to lang=en clients (zero delay)
  → Collect unique non-English languages from connected audience clients
  → For each language: translateCaption() via Gemini (cached per text+lang)
  → Route translated caption to matching audience clients
```

### Translation Service (`server/translation-service.js`)
- Uses `@google/genai` SDK with `gemini-2.5-flash` model
- LRU cache: max 500 entries, 5-minute TTL, keyed by `lang:text`
- In-flight deduplication: concurrent requests for same text+lang share one API call
- 1500ms timeout — returns original English text on failure
- API key synced from polisher/learner via `setTranslationApiKey()`

### Supported Languages
English, Spanish, Chinese (Simplified), French, Portuguese, Haitian Creole, Russian, Arabic, Vietnamese, Korean, Japanese, German, Italian, Polish, Tagalog

### WebSocket Protocol
- Client sends `{type: 'join', sessionId, role: 'audience', lang: 'es'}` on connect
- Client sends `{type: 'set_language', lang: 'zh'}` to change language
- Server sends `{...caption, payload: {..., translatedText: '...'}}` to non-English clients

### API Endpoints
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/translation/languages` | GET | List supported languages with codes |
| `/api/translation/stats` | GET | Cache stats, viewers per language |

### Audience View Language Picker
- Globe icon in header opens horizontally scrollable language pill bar
- Each language shown with flag emoji and native name
- Selected language persisted in `localStorage('cc_audience_lang')`
- Blue indicator bar shows "Translating to {language}" when non-English selected
- Translated text shown as primary (large), original English shown smaller below

## Caption Encoding Configuration

Configurable via Output Settings UI → Caption Processing section, or `POST /api/caption/config`:

```json
{
  "encodingMode": "cea608",       // "cea608" | "dtvcc"
  "captionStrategy": "truncate",  // "truncate" | "summarize" | "verbatim"
  "maxCharsPerLine": 64,          // 32-128
  "rollupRows": 2,                // 2 | 3 (CEA-608 only)
  "polishEnabled": true           // auto-capitalize, punctuate, fix contractions
}
```

**Encoding Modes**:
- **CEA-608**: ~60 chars/sec, ASCII only, universal decoder support. Roll-Up 2 or 3 rows.
- **DTVCC**: ~200+ chars/sec via CEA-708 Service 1. Also sends CEA-608 in Field 1 for backward compatibility with older decoders.

**Caption Strategies**:
- **Truncate**: Caps text at `maxCharsPerLine` at word boundary. Fast, no AI.
- **Summarize**: Gemini AI condenses speech to fit within limit. Requires API key. Falls back to truncate on timeout (800ms).
- **Verbatim**: Full text, no truncation. May lag behind fast speakers with CEA-608.

## YouTube Caption Ingestion URL

The Blackmagic Web Presenter HD/4K **does not forward SDI VANC closed captions into the H.264 SEI of its RTMP output**. Captions are detected and shown on the WP dashboard but never reach YouTube via the encoder path. The captioner ships a parallel path that POSTs captions directly to YouTube's per-stream ingestion endpoint, bypassing the encoder entirely.

### How to use
1. In YouTube Studio, edit your live stream → set **Closed Captions** to "Caption ingestion URL". YouTube displays a URL like `http://upload.youtube.com/closedcaption?cid=ABCDE-...`.
2. In the captioner UI (Caption Injection screen, scroll to bottom), paste that URL in the **YouTube caption ingestion URL** panel and hit Save. Or `POST /api/youtube/caption-url` with `{url: "..."}`.
3. Every final, polished caption from the captioner is POSTed to that URL with an incrementing `seq=N` query param and a body of:
   ```
   HH:MM:SS.mmm
   caption text
   ```
4. YouTube overlays the caption on the live stream within ~1–2 seconds of the POST.

### Implementation (server/relay.js)
- `youtubeCaptionState = { url, sessionStartMs, sequence, lastPostMs, lastError }` — module-scoped state
- `forwardToYouTube(text)` — async POST with 2s AbortController timeout; non-blocking
- Hooked at the end of the WS final-caption polish block (after `forwardToCea708` + `feedCaptionToEncoder`)
- `sessionStartMs` is set when the URL is configured; timecodes are relative to that
- Sequence number must increase monotonically across POSTs for the same stream — YouTube rejects out-of-order

## Caption Polisher (server/caption-polisher.js)

**Layer 1 — Local rules (zero latency, always active)**:
- Capitalize first letter of sentences
- Capitalize standalone "I"
- Add terminal punctuation if missing
- Fix 35+ split-contraction patterns ("do n't" → "don't")
- Normalize unicode to ASCII for CEA-608 compatibility
- Collapse whitespace

**Layer 2 — Gemini AI (optional, requires API key)**:
- Grammar/punctuation correction via Gemini Flash
- Summarization/condensation for `summarize` strategy
- 500ms timeout for polish, 800ms for summarize
- Falls back to Layer 1 on failure

## Audience Phone View

Accessible at `/?view=audience&session=demo` or via QR code from Dashboard.

**Features**:
- Auto-reconnect with exponential backoff (1s → 10s max)
- Dark/light mode toggle (persisted in localStorage)
- Three font sizes: Normal / Large / Extra Large
- Fullscreen mode
- Translated text shown below original when available
- 50-caption memory limit
- Heartbeat ping every 30s

**QR Code Modal** (Dashboard toolbar):
- Local QR generation via `qrcode.react` (works offline)
- Public URL via Cloudflare Quick Tunnel (no password, no interstitial)
- Backup URL (localhost.run, no password needed)
- Live audience viewer count

## Native Addon (C++)

**Build**: `npm run build:native` (requires cmake-js, DeckLink SDK, NDI SDK)

**Dependencies**:
- DeckLink SDK: `/Library/Frameworks/DeckLinkAPI.framework` (macOS)
- NDI SDK: `/Library/NDI SDK for Apple/` (headers + libndi.dylib)

**Exported Functions**:
- `enumerateDevices()` → `[{name, index, hasInput, hasOutput, displayModes}]`
- `startOutput(deviceIdx, displayMode)` → standalone black frames + VANC
- `startPassthrough(inIdx, outIdx, displayMode)` → SDI in→out + captions
- `startNdiPassthrough(ndiSource, outIdx, displayMode)` → NDI→SDI + captions
- `stopOutput()`
- `pushCDP(Buffer)` → enqueue CDP packet (consumed one per output frame)
- `findNdiSources(timeoutMs)` → `[{name, url}]`
- `getStatus()` → `{running, mode, framesOutput, droppedFrames}`

**Three output modes** (mutually exclusive):
1. **Standalone** — OutputHandler: black frames + scheduled VANC
2. **SDI Passthrough** — PassthroughHandler: SDI input → output + VANC overlay
3. **NDI Passthrough** — NdiPassthroughHandler: NDI receive → SDI output + audio resample (any rate → 48kHz) + VANC

**CDP Queue**: All three handlers use `std::queue<std::vector<uint8_t>> m_cdpQueue` — each CDP is pushed by JS and popped once per output frame. This prevents the repeated-character bug where a single CDP was re-attached to every frame.

### Windows-specific addon notes

Several gotchas that don't apply on macOS:

1. **COM init per-thread.** `CreateDeckLinkIterator()` (in `src/platform.h`) calls `CoInitializeEx(nullptr, COINIT_MULTITHREADED)` before `CoCreateInstance`. Without it, every code path other than `EnumerateDevices` (which has its own `ComInit` RAII) hits `CO_E_NOTINITIALIZED` and surfaces as a bogus "No driver installed" / "device in use" error.

2. **Pixel buffer access requires lock/unlock.** Windows `IDeckLinkVideoFrame` doesn't expose `GetBytes` directly — it's on a separate `IDeckLinkVideoBuffer` interface obtained via `QueryInterface`. AND the pointer is only valid between `StartAccess(flags)` and `EndAccess(flags)`. The `VideoFrameAccess` RAII helper in `platform.h` does this; on macOS it's a no-op shim that calls `GetBytes` directly.

3. **`win_delay_load_hook.cc` MUST be linked.** `CMakeLists.txt` adds `${CMAKE_JS_SRC}` to the Windows source list — without it, the addon's `/DELAYLOAD:NODE.EXE` imports can't resolve when loaded inside a pkg-bundled `CommunityCaptioner.exe` (because the host binary isn't named `node.exe`). The addon segfaults at `require()` time. Standalone `node` works without this hook by coincidence.

4. **Scheduled video playback requires audio output enabled.** Per the BMD `InputLoopThrough` SDK sample, you must `EnableAudioOutput` + `BeginAudioPreroll` + schedule audio samples before/alongside `StartScheduledPlayback`. Without it, the device's playback clock doesn't advance past the initial buffer drain and video stalls at ~35 frames (the device's pending-schedule queue limit). The passthrough handler schedules silent samples when no input audio is enabled, real samples from `EnableAudioInput` otherwise.

5. **Pre-allocate output frames; don't `CreateVideoFrame` per callback.** The DeckLink driver caps distinct in-flight frame references at ~35. Allocating a fresh `IDeckLinkMutableVideoFrame` for every input callback would exhaust that limit. `PassthroughHandler` uses a 4-frame ring buffer (`m_frames[kFrameCount]`) and gates reuse via `m_nextWriteIdx`/`m_nextCompletedIdx` so the input callback waits for a frame to complete before reusing its slot.

6. **Re-schedule the `completedFrame` argument**, not an alternating-toggle frame. `OutputHandler::ScheduledFrameCompleted` passes its `completedFrame` parameter back into `RescheduleFrame()`. The previous toggle-based approach modified VANC packets on frames that were *still queued in the device*, producing visible flashing — matches the SDK ClosedCaptions sample's pattern.

### Frame & buffer access pattern (Windows)

```cpp
{
    VideoFrameAccess in(videoFrame, bmdBufferAccessRead);
    VideoFrameAccess out(outFrame, bmdBufferAccessWrite);
    if (in.data && out.data) {
        memcpy(out.data, in.data, height * rowBytes);
    }
} // RAII unlocks both before frame is scheduled
```

Always release IDeckLinkVideoBuffer after the access scope and BEFORE handing the frame to `ScheduleVideoFrame` — the SDK rejects frames whose buffer is still locked.

## CEA-608/708 Encoding Details

### CEA-608 (cea608-encoder.js)
- Configurable Roll-Up 2 or 3 mode via `setRollupRows()`
- Row 15 PAC (0x14/0x60) — bottom of screen
- Odd parity on all bytes (bit 7)
- Control codes sent twice for error resilience
- Mode+PAC sent once per caption (not per line) to reduce overhead
- Line breaking at 32-char word boundaries
- Deduplication: skips identical text within 2 seconds
- Backlog protection: relay drops captions when queue > 120 pairs
- ~60 chars/sec throughput at 29.97fps

### DTVCC (dtvcc-encoder.js)
- Service 1 caption data with DefineWindow, SetCurrentWindow, text, CR, ETX
- Service block headers: 3-bit service number + 5-bit block size
- Multiple blocks per frame for ~200+ chars/sec throughput
- Queue cap at 60 CDPs / 200 bytes to prevent unbounded growth

### CEA-708 CDP (cea708-cdp-builder.js)
- SMPTE 334 format: header 0x9669, flags byte **0x77** (ccdata_present | svcinfo_present | svc_info_start | svc_info_complete | caption_service_active | reserved) followed by a ccsvcinfo block declaring service 1 "eng" — without it common decoders treat the CDP as having no caption services
- cc_count per rate: 23.98→25, 29.97→20, 59.94→10
- `buildCDP(cc1, cc2)`: CEA-608 only — Field 1 data, Field 2 null, DTVCC null padding
- `buildCDP_DTVCC(dtvccData, frameRate, cc1, cc2)`: Dual mode — CEA-608 in Field 1 for backward compat + DTVCC service data in remaining triplets
- CRC: mod-256 sum of all bytes = 0

## App Navigation Flow

```
Landing Page ("Start Captioning")
  ├── Local (localhost/LAN IP) → Workflow Picker (Live / Prerecorded / Local AI)
  └── Cloud (public URL)       → Deployment Choice (Desktop App vs Run in Browser)
                                   ├── Desktop App → Download instructions
                                   └── Run in Browser → Workflow Picker
```

The deployment choice screen is **skipped** when running locally (from the standalone .app/.exe or `npm run dev`) since the user is already in the desktop app. It only appears on cloud-hosted deployments where visitors may need to download the desktop app for DeckLink/SDI features.

## Common Issues & Fixes

### WebSocket not connecting in dev mode
Vite can start on ports 5173-5180 if earlier ports are busy. The `getWsUrl()` in Dashboard.tsx, AudienceView.tsx, and App.tsx maps ports 5173-5199 → relay port 8080. If Vite starts on a port outside this range, update the range check.

### DeckLink "device in use" error
Only one application can use a DeckLink output port at a time. Stop any other app using it (NDI-to-SDI bridge, OBS, etc.) before starting output. Check with: `lsof -ti :8080`

### Garbled/repeated captions on SDI output
Previously caused by the native addon using a single CDP buffer (`m_currentCDP`) that was re-attached to every frame. Fixed by switching to `std::queue<std::vector<uint8_t>> m_cdpQueue` in all three output handlers. If garbled text reappears, verify `npm run build:native` was run after the fix.

### Captions too slow / falling behind
CEA-608 can only display ~60 chars/sec. Use Caption Processing settings to:
- Switch to **Truncate** strategy with lower max chars (32-48)
- Switch to **Summarize** strategy (requires Gemini API key)
- Switch to **DTVCC** encoding mode for ~200+ chars/sec (requires DTVCC-capable decoder)

### Summarize mode not working
Requires a Gemini API key. Enter it in Context Engine → Settings → Gemini API Key, or in Output Settings → Caption Processing → Gemini API Key. The key is sent to the relay via `POST /api/polisher/apikey`. Without a key, summarize falls back to truncation.

### PDF upload says "No entries found" / "Upload failed"
- "pdfParse is not a function" in the relay log means someone reverted to the pdf-parse v1 call form. pdf-parse ≥2 exports a `PDFParse` class — always go through `extractPdfText()` in `server/context-sources.js`.
- A scanned PDF has no text layer; the endpoint returns a warning saying so. Export a text PDF from the agenda software or paste the text.
- No Gemini key on the server **and** in the browser → extraction falls back to local regex which finds fewer entries. Check Context Engine → Settings for the key status badge. The CORS headers must include `X-Api-Key`.

### Municipality Wizard finds the site but every page shows "403" / "AI read"
Expected for Cloudflare-protected municipal sites (CivicPlus hosts like brooklinema.gov block all non-browser fetches). Research results are unaffected (they come from Google Search grounding, not from fetching the pages). Deep scan and the URL scraper automatically switch to Gemini's `urlContext` page reader for those URLs (≈10s each). If the wizard returns nothing at all, the Gemini key is missing/invalid or the query is too vague — include the state ("Needham, MA").

### Auto-Learn never suggests anything in browser mode
Fixed: the relay now feeds the learner from the WebSocket final-caption handler, not only from the DeckLink encoder path. Still requires a Gemini key, the Learn pill ON, and ≥100 chars of final captions per 30s window.

## Local AI Stack (Local / Fully Local modes)

`local/whisper_server.py` is the bundled speech server (ships inside the .app/.exe under `local/`, and in the repo). `server/local-stack.js` lets the relay — which runs on the operator's machine — probe the system, install and launch the server, stream its logs, and talk to Ollama, so `components/LocalSetup.tsx` can guide the operator with real feedback.

**Speech server protocol** (`ws://127.0.0.1:9000`): client sends 16 kHz 16-bit mono PCM binary frames; server sends `{"type":"hello", backend, model, device, compute, language, interim}` on connect, `{"text", "isFinal": false}` interims (~every 2 s while speaking), `{"text", "isFinal": true, "latencyMs"}` finals (energy VAD cuts a segment after 650 ms of silence following ≥350 ms of speech, max 14 s), and `{"type":"status", state, message}`. `App.tsx` handles all of these; legacy servers that only send `{"text"}` still work (treated as final).

**Backends** (auto-picked): `mlx-whisper` on Apple Silicon (GPU; model repos `mlx-community/whisper-*`), else `faster-whisper` (CTranslate2; CPU int8 or NVIDIA float16). Model catalogue in `WHISPER_MODELS` (local-stack.js) mirrors `MODELS` in the script: `large-v3-turbo` (default on Apple Silicon ≥16 GB and NVIDIA), `distil-large-v3` (English, CPU-friendly), `small.en`/`base.en` (light), `medium.en`, `large-v3`. `recommend(info)` picks by GPU/RAM/cores. Tested 2026-10-11 on an M1 Max: base.en on CPU and on MLX both return finals ~0.8–1.1 s after the speaker stops.

**Launcher** (`POST /api/local/whisper/start {model, backend, language, interim}`): copies the script to `DATA_DIR/local/`, then runs it with **uv** if installed (`uv run --python 3.12 --with faster-whisper … whisper_server.py`), else creates `DATA_DIR/local/venv` with the best Python (3.10–3.13 preferred; 3.14 flagged) and pip-installs `numpy websockets faster-whisper [mlx-whisper]`. Models cache in `DATA_DIR/local/hf-cache`. Status lines `__WHISPER_STATUS__ {json}` from the script drive the state machine (`installing → starting → loading → ready | error`); `GET /api/local/whisper/logs` is an SSE feed of log lines + status; `/status`, `/stop`, `/hello {url}` (handshake with any server) also exist. The process is killed when the relay exits.

**Probe** (`GET /api/local/info`): platform/CPU/RAM, GPU (Apple Silicon or `nvidia-smi`), Python candidates, uv, Ollama (installed/running/models via `/api/tags`), whether port 9000 answers (+ its hello), `recommendation`, `installCommands`, `canLaunch`, and the two model catalogues. Cached 8 s; `?refresh=1` busts it. `GET /api/app/info` reports `desktopApp` (pkg or DIST_PATH) so the UI stops suggesting "download the desktop app" to people already running it; the wizard only shows that notice when the page is served from a non-local host (the relay can't install anything on the viewer's machine then).

**Ollama = the "local AI brain"** (`server/local-llm.js`). The wizard's finish step (or Settings → Local AI) POSTs `/api/local/brain {enabled, url, model}` (persisted at `DATA_DIR/local/brain.json`). While enabled, **every Context Engine extraction goes through Ollama first** — `extractEntriesAnyEngine()` in relay.js is used by `/api/context/extract`, `/upload-pdf`, `/scrape(-stream)`, and `context-learner.js` Auto-Learn — falling back to Gemini (if a key is loaded) and then to the regex extractor. Responses carry `engine: "ollama:<model>" | "gemini" | "local-regex"`, and `/api/context/capabilities` exposes `brain` + `extractionEngine` so the Context Engine banner says "Local AI brain is active". The Municipality Wizard (needs Google Search grounding), translation and caption polish stay on Gemini. `ollamaJson()` uses `format: "json"`, `num_ctx 8192`, and sends `think: false` to models whose `/api/show` capabilities include `thinking` (Qwen3, gpt-oss) so they answer directly; `<think>` blocks are stripped anyway. Long text is chunked (6k chars, max 4 chunks, sequential — one GPU).

**Nothing needs Gemini when the brain is on.** `server/local-wizard.js` gives the Municipality Wizard a local path (`researchMunicipalityLocally`): DuckDuckGo's key-free HTML results (`ddgSearch`) find the official site and pages, reachable pages are read with `fetchPage`+`htmlToText` and extracted with Ollama (sequential, one GPU), search snippets are extracted too (they survive Cloudflare blocks), and a "knowledge pass" asks the model for well-known places/schools/acronyms. It emits the same SSE events as the Gemini path, bucketed into the four groups, with `engine: "ollama:<model>"`. Bot-blocked sites (CivicPlus/Cloudflare) can't be read locally — `r.jina.ai` was tested and is blocked too — so the `crawlNote` tells the operator to upload the agenda PDF. `translation-service.js` translates through the brain (`ollamaText`, 12 s timeout, same cache) before Gemini; `/api/polisher/status` reports `translationAvailable`, and `POST /api/translate {text, lang}` serves the Dashboard's side-by-side translation so the browser needs no key. `caption-polisher.js` skips the Gemini polish/summarize layer while the brain is active (local rules still run; summarize falls back to truncate).

`/api/local/ollama/test {model}` runs the **real extraction prompt on a built-in sample Select Board agenda** and grades recall of six known names (`testOllamaExtraction`); the wizard shows the verdict, sample names, tokens/s. `/models` (tags), `/start` (spawns `ollama serve` / opens Ollama.app), `/pull` (streams Ollama's NDJSON progress as SSE). Catalog `OLLAMA_MODELS` (local-stack.js) with `tested` flags and numbers measured 2026-10-12 on the M1 Max (warm model, sample agenda, recall of six known names): **`gemma4:e2b` 100% in 5 s, 115 tok/s (the recommendation for every machine, 4.6 GB, 8 GB RAM)**, `gemma4:e4b` 100% in 14 s with a few more names and the best Haitian Creole translation (labelled "More thorough, slower", 16 GB), `gemma3:4b` 83% / 8.7 s (previous pick, smaller download), `gemma3:12b` 83% / 30 s, `qwen3.5:4b` 17% (acronyms and surnames only, misses people), `qwen3:4b` 67% / 14 s, `qwen3:8b` 67% / 18 s, `llama3.1:8b` 67% / 31 s. Ollama's Apple-Silicon `-mlx` tags were tested and rejected: `gemma4:e4b-mlx` (9.5 GB vs 6.6 GB) scored 67% vs the GGUF's 100%, `qwen3.5:4b-mlx` 33%; the standard tags are used on every platform. `translategemma:4b` gave no gain over the general models on es/zh and garbage Creole. Translation through any of these takes ~0.3 s warm per caption. Re-run `scratchpad/test-ollama-models.mjs <model…>` (uses `testOllamaExtraction`) before changing the recommendation. The wizard always shows the model chooser (even before Ollama is installed), leads with the plain installer download (ollama.com) and keeps brew/winget as "Option B" with a where-to-find-Terminal hint. Same no-Homebrew treatment for Python on the first step (python.org installer as Option A, uv one-liner as Option B). The chosen model also lives in `appState.localLlmModel` (`localStorage cc_llm_model`) for `services/localAIService.ts` (session summaries in Fully Local mode).

**Wizard flow** (`LocalSetup.tsx`): Check this machine → Speech engine (model cards with the recommendation badge, Install & start, live state/log, "Test with your microphone" through the real pipeline with per-segment latency; or "I run my own server" with a handshake check) → AI brain (optional: detect/start Ollama, download a model with progress, test extraction; or skip) → Finish (summary; completes into `local` or `fully_local` mode). The Dashboard shows a Local pill (green/red while captioning) that reopens the wizard, and Settings → Local AI has an Ollama model picker.

### Which modes send data where
- **Balanced (default)**: Web Speech API → Chrome/Edge stream microphone audio to Google's speech servers; Safari uses Apple's. Not local. Text then goes to the local relay, which sends each final line to Gemini for polish when a key is loaded and the polish toggle is on (both true by default with `.env.local`).
- **Cloud**: audio streamed to Gemini Live. Two recognizers (Settings → Cloud → "Cloud Mode Recognizer", stored in `localStorage cc_cloud_model`):
  - `transcribe-live` → **`gemini-3.5-transcribe-live`** (default). Purpose-built transcription model; config is just `{ inputAudioTranscription: {} }`. Streams `serverContent.interimInputTranscription.text` (cumulative text of the current segment, ~2/s → shown as interim) and emits `serverContent.inputTranscription.text` as a finished segment ~1.7 s after the speaker pauses (followed by `generationComplete`). Each finished segment becomes one caption line. In testing it transcribed "Brookline", "Bernard Greene" and "Coolidge Corner" correctly where the legacy model produced "Brooke Line", "Bernard Green", "coolage corner".
  - `native-audio` → `gemini-2.5-flash-native-audio-preview-12-2025` (legacy). Conversational model told to stay silent; `inputTranscription` arrives as word fragments that are buffered until `turnComplete`.
  - Batch `gemini-3.5-transcribe` returns its text in `candidates[0].content.parts[0].audioTranscription.text` (not `response.text`) and has no timestamps, so Prerecorded still uses `gemini-2.5-flash` with a JSON schema.
- **Local / Fully Local**: audio to the bundled speech server (or your own) over a WebSocket on this machine; nothing leaves the machine unless a Gemini key enables polish/translation/learning. Fully Local additionally routes the Context Engine and session analysis to Ollama.
The landing page copy reflects this (it used to claim Web Speech kept audio on-device, which is wrong).

### Dashboard metrics are measured, not simulated
- **Latency**: `App.startVad()` samples mic RMS every 60 ms (AnalyserNode) and records the last moment it exceeded 0.02; each final caption's latency = now − last speech. Shown as an EMA in seconds, "—" until the first measurement, red above 3 s. (It used to be `Math.random()`.)
- **WPM**: `rollingWpm()` = words in the final captions of the last 60 s (sampled every 5 s so the chart decays in silence). (It used to be `words × 12`.)
- **Confidence**: mean of recognizer confidences where the engine reports one (Web Speech). Gemini reports none → "—" (`confidenceSamples = 0`).

### Translation languages
`utils/languages.ts` holds the 15 languages. The Dashboard's picker (side-by-side translation of the operator's own captions, client-side `translateText` with the English language name in the prompt) and the audience view (server-side, cached) use the same list. The audience view also has a "Download transcript" button (plain text, translated + original when a language is selected).

### Auto-Learn not producing suggestions
Requires: (1) Gemini API key set, (2) Auto-Learn toggled ON, (3) Active captioning session producing final captions. The learner buffers 30 seconds of text before extracting. Check relay logs for `[Learner]` messages.

### Web presenter shows CEA-608 even in DTVCC mode
Expected behavior — DTVCC mode sends CEA-608 in Field 1 for backward compatibility. Most web presenters and consumer decoders only read CEA-608. The DTVCC data is in the remaining triplets for modern decoders.

### Web Presenter detects captions but YouTube doesn't show them
The Blackmagic Web Presenter HD/4K detects incoming VANC captions for its dashboard display but **does not embed them into the H.264 SEI of the RTMP output**. YouTube's "Embedded captions" mode therefore sees nothing. Workarounds, in order of preference:
1. Use the **YouTube Caption Ingestion URL** path (see section above) — POSTs captions to YouTube directly, independent of the encoder.
2. Replace the Web Presenter with an encoder that does forward CC into H.264 SEI: vMix (CEA-608 native), OBS with `obs-closed-captions` plugin, Wowza, Teradek hardware encoders.
3. Switch encodingMode to `dtvcc` — some encoders specifically look for digital service blocks rather than Field 1 CEA-608 (your mileage will vary by WP firmware version).

### Passthrough output stalls at exactly N frames (often ~35)
Two requirements for scheduled video playback to advance continuously on DeckLink:
1. **Audio output must be enabled** (`EnableAudioOutput` + `BeginAudioPreroll`) and audio samples scheduled alongside video — silence is fine. Without this, the playback clock doesn't advance past the initial buffer drain.
2. **Output frames must be re-used from a fixed pool**, not allocated fresh per input frame. The driver caps distinct in-flight frame refs at ~35; the passthrough handler uses a 4-frame ring buffer.

If you see exactly-N-frames-then-stall, check both of the above are in place.

### No audio in NDI→SDI passthrough
NDI sources may use non-48kHz sample rates (e.g., 44100Hz). The native addon resamples to 48kHz via linear interpolation. Audio uses `WriteAudioSamplesSync` (continuous mode), NOT `ScheduleAudioSamples`.

### Port conflicts in dev mode
`npm run dev` runs Vite and relay concurrently. The relay needs PORT=8080 (its default). If PORT env var is set to something else (e.g., by the preview tool), the relay lands on the wrong port and `getRelayUrl()` mapping breaks. Ensure PORT=8080 in the launch config (`.claude/launch.json`).

### Public tunnel not connecting
The app uses Cloudflare Quick Tunnels (trycloudflare.com) for public URL generation. On first run, it downloads the `cloudflared` binary to `~/.community-captioner/`. If the download fails (no internet, firewall), falls back to localhost.run SSH backup. Ensure outbound HTTPS and SSH are not blocked.

## Production Deployment Checklist

1. **Set Gemini API key** in Context Engine Settings or `.env.local` (`GEMINI_API_KEY`)
2. **Upload meeting agenda** PDF before broadcast for proper noun corrections
3. **Enable Auto-Learn** for real-time dictionary building during broadcast
4. **Configure caption strategy** — Truncate for fast/reliable, Summarize for cleaner text, Verbatim for full accuracy
5. **Test SDI output** — Start NDI/SDI passthrough, verify captions appear on downstream monitor
6. **Share audience URL** — Open QR Code modal, share the link or display QR code in the room
7. **Monitor queue depth** — If captions fall behind, switch to Truncate or lower maxCharsPerLine
8. **Export the context engine** after the broadcast to reuse the dictionary next time

## Environment

- **macOS** (arm64) primary target
- **Node.js** with native C++ addon (cmake-js)
- **DeckLink 8K Pro** hardware (4 independent SDI I/O ports)
- **ATEM Mini Extreme ISO G2** (additional DeckLink device)
- **NDI SDK** for IP video receive
- `.env.local` contains `GEMINI_API_KEY` (also settable via UI)
- `cloudflared` for Cloudflare Quick Tunnel (public URL, no password interstitial)
- `qrcode.react` for offline QR code generation
- `pdf-parse` for server-side PDF text extraction
- `multer` for multipart file upload handling
- `@google/genai` SDK for Gemini API calls (server-side)
