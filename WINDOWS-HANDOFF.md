# Windows release handoff

> **Current task: bring Windows to 6.10.6** — read the "v6.8.0 update" and "v6.10.0 update" sections (still valid), then the "v6.10.6 update" section at the very end, which adds what changed since 6.10.0. The v6.4.0 brief below still describes the DeckLink SDK, addon build and packaged-exe probes, which have not changed.

# v6.4.0 brief (DeckLink addon + packaging)

This is a brief for a Claude Code session running **on a Windows machine**. The macOS side of v6.4.0 is done (signed .app on the draft release). Your job is to produce the matching Windows build with the DeckLink addon bundled, verify it, attach it to the release, and update the download link.

Read `CLAUDE.md` first (especially "Standalone Desktop Builds" and "Windows-specific addon notes"), then `BUILD-WINDOWS.md`. Do not change the macOS build path in `scripts/build-app.js`.

## What "done" looks like

1. `native\decklink\build\Release\decklink_addon.node` compiled on this machine and loading in Node.
2. `build\Community-Captioner-6.4.0-windows-x64.zip` built by `npm run build:windows`, containing `CommunityCaptioner.exe`, `decklink_addon.node`, `.env.local`, `SETUP.md`, `setup-decklink.bat`.
3. The packaged `.exe` launch-tested: uploads + PDF parsing available, dictionary corrections working, addon loaded.
4. Both assets attached to the GitHub release `v6.4.0` (draft is fine): the zip, and the addon as `decklink_addon-windows-x64.node`.
5. `utils/appLinks.ts` → `WINDOWS_DOWNLOAD_URL` pointing at the v6.4.0 zip, committed and pushed.
6. A short report back: file sizes, SHA256 of both assets, what you tested, anything that differed from this brief.

## Prerequisites (ask the user to install anything missing — do not install system software yourself)

| Need | Check |
|---|---|
| Node.js 20 or newer | `node --version` |
| Visual Studio 2022 Build Tools with "Desktop development with C++" (MSVC, Windows SDK, `midl.exe`) | open **x64 Native Tools Command Prompt for VS 2022**, run `cl` and `midl` |
| Git + GitHub CLI, authenticated to `amateurmenace/community-captioner-v10` | `gh auth status` |
| Blackmagic Desktop Video (runtime driver) | Blackmagic Desktop Video Setup shows the card; needed to *test* SDI, not to compile |
| DeckLink SDK (Win\include with `DeckLinkAPI.idl`) | see below — it is in a private draft release, do not look for it on the public internet |
| Gemini API key for `.env.local` | ask the user; the file is gitignored and ships inside the zip on purpose |

**Work from the Native Tools prompt.** MSVC and MIDL must be on PATH for cmake-js: Start menu → "x64 Native Tools Command Prompt for VS 2022" → type `powershell`.

## Steps

```powershell
# 1. Clone and install
git clone https://github.com/amateurmenace/community-captioner-v10.git
cd community-captioner-v10
npm ci

# 2. Get the DeckLink SDK headers from the repo's private draft release
#    (Blackmagic's EULA forbids redistribution; the draft is only visible to collaborators)
gh release download sdk-internal-do-not-publish --pattern "*.zip" --output bmd-sdk.zip
Expand-Archive bmd-sdk.zip -DestinationPath bmd-sdk -Force
$sdk = (Get-ChildItem bmd-sdk -Recurse -Filter DeckLinkAPI.idl | Select-Object -First 1).DirectoryName
Write-Host "SDK include dir: $sdk"      # must contain DeckLinkAPI.idl and DeckLinkAPI.h

# 3. Build the native addon (MIDL generates the COM headers, then MSVC compiles)
npx cmake-js compile --directory native/decklink --CDBMD_SDK_DIR="$sdk" --config Release
node -e "const a=require('./native/decklink/build/Release/decklink_addon.node'); console.log(Object.keys(a)); console.log(a.enumerateDevices())"
#    Expect the 6 exports (enumerateDevices, startOutput, startPassthrough, stopOutput, pushCDP, getStatus)
#    and your DeckLink device(s) listed if Desktop Video is installed. An empty array is fine without a card.

# 4. Gemini key (ask the user for the value — never paste it into chat or commit it)
Set-Content -Path .env.local -Value "GEMINI_API_KEY=<key from the user>"

# 5. Tests (the CEA-708 suite also loads the addon)
node test/test-corrections.mjs
node test/test-cea708.mjs

# 6. Build the standalone exe + zip (vite → esbuild → pkg → windows-bundle\ → zip)
npm run build:windows
#    Look for "Bundled Windows DeckLink addon from ...native\decklink\build\Release\decklink_addon.node"
#    and "Release zip: ...Community-Captioner-6.4.0-windows-x64.zip". If it says no addon was found, step 3 did not succeed.
```

## Verify the packaged exe (this is where past releases were silently broken)

Dev mode hides packaging problems. Launch the *built* exe on a spare port and probe it:

```powershell
$env:PORT = "8090"
Start-Process -FilePath "build\windows-bundle\CommunityCaptioner.exe" -WorkingDirectory "build\windows-bundle"
Start-Sleep 8
curl.exe -s http://localhost:8090/api/context/capabilities
#   must show "pdf":true,"docx":true,"upload":true,"geminiKey":true
curl.exe -s http://localhost:8090/api/inject/status
#   must show "addonLoaded":true
curl.exe -s -F "file=@C:\path\to\any-text.pdf" http://localhost:8090/api/context/upload-pdf
#   must return ok:true with entries (not "pdfParse is not a function", not "Setting up fake worker failed")
curl.exe -s -X POST http://localhost:8090/api/context/dictionary -H "Content-Type: application/json" -d "{\"dictionary\":[{\"original\":\"bernard green\",\"replacement\":\"Bernard Greene\",\"type\":\"proper_noun\"}]}"
curl.exe -s -X POST http://localhost:8090/api/context/apply -H "Content-Type: application/json" -d "{\"text\":\"thanks to bernard grene\"}"
#   must return "thanks to Bernard Greene" with mode "phonetic"
```

Then open http://localhost:8090 in a browser: Landing → Launch App → **Caption Injection** should list DeckLink devices (not the yellow "Setup required" card); Context Engine → drop a PDF → entries preview appears; Municipality Wizard research runs (needs internet + the key). Close the exe window when done (`Stop-Process -Name CommunityCaptioner`).

Data written by the packaged exe goes to `%USERPROFILE%\.community-captioner\data\` (dictionary, profiles). It must not write next to the exe.

## Publish

```powershell
Copy-Item native\decklink\build\Release\decklink_addon.node build\decklink_addon-windows-x64.node
Get-FileHash build\Community-Captioner-6.4.0-windows-x64.zip, build\decklink_addon-windows-x64.node -Algorithm SHA256

gh release upload v6.4.0 build\Community-Captioner-6.4.0-windows-x64.zip --clobber
gh release upload v6.4.0 build\decklink_addon-windows-x64.node --clobber
gh release view v6.4.0 --json assets -q ".assets[].name"
```

The release `v6.4.0` already exists as a draft with the macOS zip; `--clobber` only replaces same-named assets. Do not publish the draft and do not delete other assets.

Then update the link and commit:

```powershell
# utils/appLinks.ts — change the WINDOWS_DOWNLOAD_URL to the v6.4.0 asset and fix the comment above it
#   export const WINDOWS_DOWNLOAD_URL = `${GITHUB_REPO_URL}/releases/download/v6.4.0/Community-Captioner-6.4.0-windows-x64.zip`;
git add utils/appLinks.ts
git commit -m "Windows 6.4.0 build: point download link at the new release asset"
git push origin main
```

If `build/` or `.env.local` show up in `git status`, stop — they are gitignored and must never be committed.

## Known Windows gotchas (all already handled in code; listed so you recognize them)

- **COM must be initialized per thread** (`CoInitializeEx` in `native/decklink/src/platform.h`). Symptom if broken: bogus "No driver installed" / "device in use".
- **Frame pixel access needs `StartAccess`/`EndAccess`** via `IDeckLinkVideoBuffer` (`VideoFrameAccess` RAII helper). Release the buffer before `ScheduleVideoFrame`.
- **`win_delay_load_hook.cc` must be linked** (`${CMAKE_JS_SRC}` in CMakeLists). Without it the addon segfaults on `require()` inside the pkg exe because the host is not named `node.exe`. Standalone `node` works by coincidence, so test the *exe*.
- **Scheduled playback needs audio output enabled** or video stalls after ~35 frames; the passthrough handler schedules silence when no input audio.
- **Output frames come from a 4-frame ring buffer**, never allocated per callback.
- **Packaging:** server dependencies must be static `import`s (a runtime `createRequire` is invisible to esbuild and unresolvable in the pkg snapshot) and pdfjs's worker is preloaded as `globalThis.pdfjsWorker`. Both are in place; the capabilities/upload probes above prove it.
- **MIDL errors** usually mean an old Windows SDK; the DeckLink SDK needs Windows SDK 10.0.17763 or newer (Visual Studio Installer → modify → add a current Windows 10/11 SDK).
- `BUILD-WINDOWS.md` has more troubleshooting (cl.exe not found, link errors about `IDeckLink*`, addon not loaded at runtime).

## Report back

Post: the two SHA256 hashes, zip size, exe size, whether a DeckLink card was present and what `enumerateDevices()` returned, the four curl results, and anything in this brief that was wrong or out of date so it can be fixed.


# v6.8.0 update — bring the Windows build up to the Mac build

The Mac build on the `Community Captioner v10.1` release is 6.8.0; the Windows zip there is still 6.4.0. Everything since 6.4.0 is in `main` (commit 443bf71 or later) and is pure JS/TS/Python: no native changes, so the addon from 6.4.0 is still valid (rebuild it anyway with the steps above if `native\decklink\build\Release\decklink_addon.node` is missing on this machine).

What changed since 6.4.0 and what is **untested on Windows** (your job is to test and fix):

| Area | Where | Windows-specific code to verify |
|---|---|---|
| Local AI wizard | `components/LocalSetup.tsx`, `server/local-stack.js` | Python detection via `py -3.13/-3.12/-3.11/-3.10`, `python`; venv at `%USERPROFILE%\.community-captioner\data\local\venv\Scripts\python.exe`; pip install of `numpy websockets faster-whisper`; the "Install Python" Option A link (python.org) and the where-to-find-Terminal hint |
| Speech server | `local/whisper_server.py` | faster-whisper on CPU (int8) must start; on NVIDIA the auto device picks CUDA via ctranslate2 — if the CUDA DLLs are missing the model load must fall back to CPU instead of dying (add the fallback if it does not). `--interim-model auto` loads `base.en` as a second model on CPU: check memory and that interims arrive every ~1 s |
| Replace a stale server | `killPortListener()` in local-stack.js | `netstat -ano -p tcp` + `taskkill /PID … /T /F`; the wizard shows "An older speech server is running on port 9000" with a Replace button when a server without `scriptVersion` 3 answers |
| Ollama brain | local-stack.js `probeSystem`, `ollamaStart`, `ollamaPull` | `where ollama`, `winget install Ollama.Ollama`, the installer link `https://ollama.com/download/windows`, model download progress panel (it was broken everywhere before 6.6.0), `/api/local/ollama/test` |
| Machine stats | `server/system-metrics.js` | memory via `os.freemem()`, network via `netstat -e`, GPU via `nvidia-smi` (absent → "not reported"), process chips via `tasklist /FO CSV /NH` (memory only, CPU null) |
| Bundled script | `findScriptSource()` in local-stack.js | in the pkg exe the script lives in the snapshot at `build/local/whisper_server.py`; `GET /api/local/info` must report `scriptBundled: true` and `canLaunch: true` |
| Streamed uploads | `POST /api/context/upload-stream` | SSE through the packaged exe (6 events for a short text file) |
| Dashboard header | `components/Dashboard.tsx` | two rows; Start/Stop always visible at 1366×768 |

## Steps

```powershell
cd community-captioner-v10
git pull origin main
npm ci
# addon (only if native\decklinkuild\Release\decklink_addon.node is missing): steps 2–3 of the v6.4.0 brief
node test/test-corrections.mjs
node test/test-cea708.mjs
npm run build:windows          # → build\Community-Captioner-6.8.0-windows-x64.zip (version comes from package.json)
```

## Verify the packaged exe (all of these, not just the 6.4.0 probes)

```powershell
$env:PORT = "8090"
Start-Process -FilePath "build\windows-bundle\CommunityCaptioner.exe" -WorkingDirectory "build\windows-bundle"
Start-Sleep 8
curl.exe -s http://localhost:8090/api/app/info                # version 6.8.0, desktopApp true, addonLoaded true
curl.exe -s http://localhost:8090/api/context/capabilities    # pdf, docx, upload true
curl.exe -s http://localhost:8090/api/local/info              # scriptBundled true, canLaunch true, python[] lists a working 3.10–3.13, ollama.installed
curl.exe -s http://localhost:8090/api/system/metrics          # cpu.percent, memory, network.downKBps numbers; gpu.available true only with nvidia-smi
curl.exe -s -F "file=@C:\path\to\agenda.txt" http://localhost:8090/api/context/upload-stream   # data: lines received/parsing/parsed/extracting/engine_done/done
```

Then in the browser at http://localhost:8090: Launch App → **Local AI** card (should look like the other three) → the wizard:
1. Check this machine: Python found (or the python.org Option A shown), GPU line correct.
2. Speech engine: pick the recommended model, **Install & start**, watch the log; "Speech server ready"; **Test with your microphone** shows interims within ~1 s of speaking and finals ~1 s after a pause. Then stop it, start the *old* script (`git show 1a65eab:local/whisper_server.py > old.py`, run it with the venv python on port 9000) and confirm the wizard says "An older speech server is running" and **Replace with the new version** works.
3. AI brain: with Ollama installed, pick Gemma 4 E2B, **Download** must show live progress and finish; **Test with the app** returns a verdict.
4. Finish → Dashboard: header on two rows, Start visible, "This machine" strip with numbers and sparklines (GPU "not reported" without NVIDIA is expected); Context Engine → drop a PDF → job card with progress, then grouped review → Add.

Fix what fails (keep the macOS paths intact), commit small, push.

## Publish (replace the 6.4.0 Windows asset in place, same pattern as the Mac side)

```powershell
Get-FileHash build\Community-Captioner-6.8.0-windows-x64.zip -Algorithm SHA256
gh release delete-asset v10.1 Community-Captioner-6.4.0-windows-x64.zip -y
gh release upload v10.1 build\Community-Captioner-6.8.0-windows-x64.zip
gh release view v10.1 --json assets -q ".assets[].name"      # 6.8.0 windows zip, 6.8.0 mac zip, decklink_addon-windows-x64.node
gh release view v10.1 --json body -q .body > notes.md
#   edit notes.md: the intro line and the Downloads table row say the Windows build is 6.4.0 — make it 6.8.0;
#   change "The Windows zip is still 6.4.0 … will follow." to one line saying the Windows 6.8.0 build has the same features and was tested on this machine (say which GPU/CPU).
gh release edit v10.1 --notes-file notes.md
```

Leave `decklink_addon-windows-x64.node` alone unless you rebuilt the addon from changed native code (you did not).

Then `utils/appLinks.ts`: `WINDOWS_DOWNLOAD_URL` → `Community-Captioner-6.8.0-windows-x64.zip` and fix the two comment lines above it ("Windows: app 6.4.0 …"); also in `CLAUDE.md` add a line under "Windows-specific" for anything you had to fix. Commit and push.

## Report back

Zip size and SHA256, CPU/GPU of the test machine, which Whisper model and backend ran and the measured interim/final timing from the mic test, whether the stale-server replace worked, whether the Ollama download panel worked, and every brief line above that was wrong.


# v6.10.0 update — parity with the Mac build (read after the v6.8.0 section)

Everything below shipped on the Mac between 6.8.0 and 6.10.0 (commits after 443bf71 on `main`). Still no native changes, so the DeckLink addon from 6.4.0 remains valid. Build and verify exactly as in the v6.8.0 section, with these additions.

## What changed and what is untested on Windows

| Area | Where | Verify on Windows |
|---|---|---|
| Prerecorded → "On this computer" | `components/PrerecordedStudio.tsx`, relay `POST /api/local/transcribe-file`, `GET /api/local/jobs/:id/events`, `local/whisper_server.py` (`decode_media`, `split_utterances`, SCRIPT_VERSION 4) | Upload a 1–5 minute MP4/MOV/MP3 through the packaged exe: progress bar, timed lines appearing, done state with corrections count. Decoding uses PyAV (`av`), which faster-whisper installs; confirm `import av` works in the venv. Speed will be lower on CPU; report the × real time figure. |
| Speech server starts itself | `ensureWhisper()` in `server/local-stack.js`, `POST /api/local/whisper/ensure`, `DATA_DIR\local\whisper.json` (written on every successful wizard start) | Set up Local AI once, quit, relaunch, go straight to Prerecorded or live local mode: the server must start on its own with the status visible ("Setting up the speech engine" / "Loading the model") and the Local pill mirroring it. Never set up → the card offers the wizard instead of hanging. |
| First-run visibility | same | On a machine with no venv: during pip/model download the job card must show the phase, the live log tail and the first-run note, and the bar must move (22/26/30 %). The wizard's Install & start returns within 3 s (`pending: true`) and the log feed carries on. |
| pip only when needed | `startWhisper()` import check | Second start must log "Speech packages already installed; skipping pip" and must work with Wi-Fi off. |
| Replace a stale server | `killPortListener()` → `netstat -ano -p tcp` + `taskkill /PID … /T /F` | Start the old script (`git show 1a65eab:local/whisper_server.py`) on 9000, open the wizard: "An older speech server is running" → Replace works. |
| YouTube on the local engine | `downloadYoutubeAudio()` in local-stack.js → `python -m yt_dlp` in the venv (pip-installed on first use) | Paste a short public YouTube link in Prerecorded → YouTube link → Transcribe. First use installs yt-dlp. |
| Dashboard header | `components/Dashboard.tsx` | Three rows: controls (one line, Start always visible), session line, full-width hairline graphs. GPU graph appears only with `nvidia-smi`; RAM uses `os.freemem()`; network uses `netstat -e`; process chips come from `tasklist` (memory only, no CPU %). Check at 1366×768 and 1920×1080. |
| Help & Settings | `components/HelpGuide.tsx` | The floating button opens the Help tab; read it for anything that is wrong on Windows (paths, commands) and fix the text. |
| Landing page, bottom Start/End, workspace picker | `components/LandingPage.tsx`, `Dashboard.tsx`, `App.tsx` | Visual check only. |

## Build, verify, publish

Same commands as the v6.8.0 section; the zip is `build\Community-Captioner-6.10.0-windows-x64.zip` (version from package.json). Add to the packaged-exe probes:

```powershell
curl.exe -s -F "file=@C:\path\to\clip.mp4" http://localhost:8090/api/local/transcribe-file     # {"ok":true,"jobId":...}
curl.exe -s -N http://localhost:8090/api/local/jobs/<jobId>/events                               # snapshot → job → segment … → done
curl.exe -s -X POST http://localhost:8090/api/local/whisper/ensure -H "Content-Type: application/json" -d "{}"   # ok:true (or needsSetup:true before the wizard ran)
```

Publish by replacing the 6.4.0 Windows asset on the `v10.1` release with the 6.10.0 zip, update the notes (the intro line, the Downloads row and the "Windows zip is still 6.4.0" line), point `WINDOWS_DOWNLOAD_URL` in `utils/appLinks.ts` at the new asset, note any Windows-specific fixes in `CLAUDE.md` and in the Help guide, commit small, push.

## Report back

Zip size and SHA256, CPU/GPU, which Whisper backend ran, the prerecorded speed (× real time) for your test clip, whether the auto-start, the first-run display, the stale-server replace and the YouTube path worked, and every line of this brief that was wrong.


# v6.10.6 update — parity with the Mac build (read after the v6.10.0 section)

Everything below shipped on the Mac between 6.10.0 and 6.10.6 (commits after 67f54a4 on `main`, through 0478121). Still no native changes. Build, verify and publish as in the earlier sections; the zip is `build\Community-Captioner-6.10.6-windows-x64.zip`.

## What changed and what to verify on Windows

| Area | Where | Verify on Windows |
|---|---|---|
| Browser speech (Balanced / Resilience) | `App.tsx`, `components/GlobalSettings.tsx` ("Spoken language"), `types.ts` `BrowserEngineInfo` | The recognizer language is `localStorage cc_speech_lang` (default en-US), no longer the translation picker. In Chrome and Edge: press Start, the header pill must go "waiting for text…" → "listening" when you speak. Pick Español in the translation picker: English speech must still be recognised. Unplug the network and press Start: pill "no text" with the network message. |
| Start failing silently | `App.tsx` `startRecording` catch; mic fallback | With the browser's microphone permission blocked for the site: a red "Problem" banner must explain it (Windows: Settings → Privacy & security → Microphone must allow desktop apps / the browser). Pick a device in the bottom bar, then run the app on another profile/machine where that device id does not exist: it must fall back to the default input and say so. |
| Diagnostics | `utils/diagnostics.ts`, Help & Settings → Diagnostics | Run checks: micPermission, audioInputs, relay, local speech server and the relay log lines appear; Copy report works. Fix any Windows-only wording. |
| Session log | Dashboard "Log" button, `utils/diagnostics.ts` (localStorage `cc_diag_log`) | Entries appear for session start, microphone, engines, relay; persist after a page reload; Download produces a .txt; "Relay log" opens the file. |
| Relay log | `server/relay.js` top: console wrap → ring buffer + `DATA_DIR\logs\relay.log` (5 MB cap); `GET /api/logs?n=`, `GET /api/logs/download` | File lands at `%USERPROFILE%\.community-captioner\data\logs\relay.log`; both endpoints answer from the packaged exe; the Help guide / Diagnostics text names the Windows path correctly (fix if it only says `~/.community-captioner`). |
| Dashboard scrolling | `components/Dashboard.tsx` (`min-h-0` chain, flex-row columns) | Produce 40+ captions (speak, or paste text via Caption Injection): both columns must scroll; with a translation language selected the right column follows. |
| Side-by-side translation | `server/translation-service.js` timeouts (4 s audience, 10 s Dashboard), `translationFailed` | With a Gemini key: lines translate; a line that times out shows grey "not translated" rather than English pretending to be Spanish. |
| Landing page | `components/LandingPage.tsx` + keyframes in `index.css` | Visual check: animated diagrams (routing, pipeline, utterance, phonetic keys, SDI conveyor) run smoothly in Edge; the footer has three links. |
| Help guide | `components/HelpGuide.tsx` | Read it on Windows and correct anything Mac-specific (paths, "System Settings → Privacy & Security" → the Windows equivalent). |

Packaged-exe probes to add to the earlier ones:

```powershell
curl.exe -s "http://localhost:8090/api/logs?n=5"            # {"ok":true,"lines":[...],"file":"C:\Users\...\.community-captioner\data\logs\relay.log"}
curl.exe -s -o relay.log -w "%{http_code}`n" http://localhost:8090/api/logs/download   # 200
```

Publish by replacing the 6.4.0 Windows asset on `v10.1` with the 6.10.6 zip, update the notes (intro line, Downloads row, the "Windows zip is still 6.4.0" line), point `WINDOWS_DOWNLOAD_URL` in `utils/appLinks.ts` at it, note Windows-specific fixes in `CLAUDE.md` and the Help guide, commit small, push.

## Report back

Zip size and SHA256, CPU/GPU, browser(s) tested, Whisper backend, prerecorded speed, and which of these worked: browser-speech pill, spoken-language setting, mic-blocked banner, device fallback, Diagnostics, session log persistence, relay log file and endpoints, scrolling, translation tags, auto-start, stale-server replace, YouTube path, Ollama download panel. Plus every line of the brief that was wrong.

# v6.14.0 update (2026-10-13)

Built and verified on the Windows rig in the control-encoder session (CLAUDE.md addon note 20). Nothing changed in the
addon; the exe was built with the in-tree `decklink_addon.node`. Verification that was run on the packaged exe
(`Desktop\CommunityCaptioner-6.14.0`, `PORT=8091` → it fell back to 8092 because a leftover dev relay held 8091):
`/api/app/info` 6.14.0 + desktopApp true, `/api/context/capabilities` pdf/docx/upload/geminiKey true with model
gemini-3.8-flash, `/api/inject/status` addonLoaded + ndiAvailable, `/api/gemini/key` ok from 127.0.0.1 and 403 from the
LAN address, `/api/obs/status`, `/api/caption/config` cea608Style rollup_pac, a TXT upload extracted with Gemini, and
`node tools/e2e/cloud-e2e.mjs http://localhost:8092 speech.wav` (fresh Chrome profile, fake microphone): Gemini Live
connected in 2 s on gemini-3.5-transcribe-live, the spoken sentence on the Dashboard in 6 s, no key typed.
