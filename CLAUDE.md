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

### macOS .app Bundle Structure
```
Community Captioner.app/
  Contents/
    Info.plist
    MacOS/CommunityCaptioner  (pkg binary)
    Resources/dist/           (frontend assets)
```

### Important Notes

- Each build wipes intermediate files but preserves other platform outputs in `build/`
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
Audio → Gemini/Whisper/WebSpeech → Text
  → Context Engine (dictionary substitutions, profanity filter, auto-learned corrections)
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
| `server/relay.js` | Express + WebSocket relay, DeckLink REST API, caption config, encoder orchestration, local proper noun extraction fallback |
| `server/caption-polisher.js` | Two-layer text cleanup: local rules (capitalize, contractions) + Gemini AI (grammar, summarize) |
| `server/context-learner.js` | Auto-Learn engine: buffers live captions, extracts proper nouns via Gemini, manages suggestions with accept/dismiss |
| `server/translation-service.js` | Server-side Gemini translation with LRU cache and in-flight dedup for audience phone view |
| `server/cea708/cea608-encoder.js` | CEA-608 Roll-Up 2/3 encoder with line breaking, dedup, configurable rows |
| `server/cea708/dtvcc-encoder.js` | CEA-708 DTVCC Service 1 encoder (~200+ chars/sec throughput) |
| `server/cea708/cea708-cdp-builder.js` | SMPTE 334 CDP builder: `buildCDP()` for CEA-608, `buildCDP_DTVCC()` for dual-mode |
| `native/decklink/src/addon.cpp` | N-API bindings exposing 8 JS functions |
| `native/decklink/src/ndi_passthrough.cpp` | NDI receive → DeckLink SDI output + audio resampling + VANC (CDP queue) |
| `native/decklink/src/vanc_packet.cpp` | IDeckLinkAncillaryPacket impl (DID=0x61, SDID=0x01, line 9) |
| `native/decklink/src/output_handler.cpp` | Standalone mode (black frames + captions, CDP queue) |
| `native/decklink/src/passthrough.cpp` | SDI in → SDI out + captions (CDP queue) |
| `components/Dashboard.tsx` | Main control center: recording, live preview, relay connection, QR code modal, Auto-Learn toggle + notification toasts |
| `components/OutputSettings.tsx` | Caption Output Designer: DeckLink/NDI config, Caption Processing settings |
| `components/ContextEngine.tsx` | Context Engine UI: PDF upload, URL scraping, municipality wizard, dictionary management, settings with how-to guide |
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
| `/api/context/scrape` | POST | Scrape a URL for proper nouns (requires Gemini API key) |
| `/api/context/extract` | POST | Extract proper nouns from pasted text |
| `/api/context/upload-pdf` | POST | Upload PDF/text file, extract proper nouns (multipart form) |

## WebSocket Paths

- **`ws://localhost:8080/`** — Main relay. Clients join with `{type:'join', sessionId, role}`. Broadcasts captions within sessions. Final captions are polished before broadcast.
- **`ws://localhost:8080/cea708`** — CEA-708 bridge endpoint. Only final captions forwarded (no interims).

## Context Engine

The Context Engine is a knowledge graph builder that teaches the captioning system local names, places, and acronyms. Accessible via the "Context Engine" button on the Dashboard.

### Tools Tab (Left Panel)
Top-to-bottom layout organized by workflow priority:

**Municipality Wizard** (inline at top)
- Search for a municipality name — AI finds official web pages via Google Search grounding
- Results appear inline with checkboxes and clickable source URLs
- Scraping runs in background while user fills out Meeting Prep below
- Capped at 8 sources max, progress shown with per-URL status

**Meeting Prep**
- **Quick Names**: Paste a list of names (one per line or comma-separated). AI generates STT mishearing corrections via Gemini (e.g., "Pham" → original: "fam"). Shows preview before adding to dictionary. Falls back to lowercase→original without API key.
- **Meeting Body Setup**: Structured form with Body Name, Members list, and Acronyms (format: `CIP = Capital Improvement Plan`). Parses acronyms automatically into dictionary entries.

**Document Ingestion**
- **Paste Text**: Paste meeting agenda text for AI extraction. Now shows **preview** of found entries before adding — user can review and discard.
- **PDF Upload**: Drag & drop agenda PDFs for extraction
- **URL Scraper**: Paste a direct URL to scrape for proper nouns

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
- Buffers live caption text in 30-second windows
- Sends buffer to Gemini for proper noun extraction
- Returns suggestions with original (misheard) and replacement (correct) forms
- Dashboard shows toast notifications in bottom-right corner
- Auto-approves after 10 seconds if user doesn't reject
- "Learn" pill button in Dashboard top nav bar toggles on/off
- **Live status in Settings**: buffer progress bar, extraction count, pending suggestions, last extraction timestamp
- Tracks `lastExtractionTime`, `extractionCount`, `isExtracting` in status API

### Quick Names API (server/context-learner.js)
- `generateMishearings(names, apiKey)` — generates STT mishearing entries for a list of names
- Uses Gemini to predict phonetic confusions (e.g., "Pham" → "Fam", "Greene" → "Green")
- Falls back to simple lowercase→original case entries without API key
- Capped at 50 names per request, 8-second timeout

### PDF/Document Extraction
- Uses `pdf-parse` npm package for PDF text extraction
- Sends extracted text to Gemini for proper noun identification
- **Local fallback extraction** (no API key needed): regex-based extraction of capitalized multi-word names, acronyms in parentheses, street addresses, organization names
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
- SMPTE 334 format: header 0x9669, flags byte 0x43
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

### PDF upload says "No entries found"
Most likely the Gemini API key is not set or invalid. Check Context Engine → Settings for the API key status badge. Without an API key, extraction falls back to local regex which finds fewer entries. The CORS headers must include `X-Api-Key` — this was fixed by adding it to the `Access-Control-Allow-Headers` in relay.js.

### Auto-Learn not producing suggestions
Requires: (1) Gemini API key set, (2) Auto-Learn toggled ON, (3) Active captioning session producing final captions. The learner buffers 30 seconds of text before extracting. Check relay logs for `[Learner]` messages.

### Web presenter shows CEA-608 even in DTVCC mode
Expected behavior — DTVCC mode sends CEA-608 in Field 1 for backward compatibility. Most web presenters and consumer decoders only read CEA-608. The DTVCC data is in the remaining triplets for modern decoders.

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
