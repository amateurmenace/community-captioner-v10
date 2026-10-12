# Mac handoff: add NDI → SDI to the macOS build

This is a brief for a Claude Code session running **on the Mac** (the machine that builds and notarizes the Mac release). The Windows build got NDI on 2026-10-12 (commit `d914dc6`, shipped in the Windows 6.10.6 zip on the `Community Captioner v10.1` release). Your job is to give the macOS addon the same feature, test it on real hardware, ship it in the signed Mac zip, and report back.

Read `CLAUDE.md` first: "Standalone Desktop Builds" (signing, notarization, the `Contents/MacOS` stray rule), "Native Addon (C++)" (the NDI paragraph) and "Windows-specific addon notes" item 7 (how Windows does it). Do not change the Windows branch of `native/decklink/CMakeLists.txt` or the `#ifdef _WIN32` code in `ndi_passthrough.cpp`; the Windows build is released and tested.

## Why the Mac has no NDI today

`ndi_passthrough.cpp` has been in the tree for a long time, but until `d914dc6` it was never compiled (it is not in `COMMON_SOURCES`) and `addon.cpp` never exported `findNdiSources` / `startNdiPassthrough`. So no addon built from this repo, Mac or Windows, ever had NDI, even though older CLAUDE.md text listed those exports. Caption Injection shows "NDI: Not available" and `/api/ndi/sources` answers `"NDI not available in addon"` whenever the functions are missing. The relay and the UI need no changes: they switch NDI on as soon as the addon exports the two functions.

## What is already in place (shared code, from the Windows work)

- `native/decklink/src/addon.cpp`: everything NDI is behind `#ifdef HAVE_NDI`. With it defined, the addon exports `findNdiSources(timeoutMs)` → `[{name, url}]` and `startNdiPassthrough(sourceName, outputDevice, displayMode)` → `boolean`, routes `stopOutput`, `pushCDP` and `getStatus` (mode `"ndi"`, plus `ndiSource`) to the NDI handler, and exports a string `ndiRuntime`. **The two functions are only exported when `NdiPassthroughHandler::RuntimeAvailable()` returns true at module init.**
- `native/decklink/src/ndi_passthrough.cpp/.h`: already cross-platform apart from the runtime loader. It uses `CreateDeckLinkIterator()` (on the Mac that is `CreateDeckLinkIteratorInstance()`), `ComInit` (a no-op on the Mac) and `VideoFrameAccess` (a `GetBytes` shim on the Mac). It requests whole frames (`allow_video_fields = false`) and converts BGRA/BGRX sources (alpha) to UYVY instead of sending black.
- **`RuntimeAvailable()` on non-Windows currently just returns `true` ("linked").** That is only safe with a hard link to `libndi.dylib`. If you link weakly (recommended below) you must replace it with a real check, or the first NDI call on a Mac without NDI will crash the relay.

## Prerequisites (ask the user to install anything missing; do not install system software yourself)

| Need | Check |
|---|---|
| NDI SDK for Apple | `ls "/Library/NDI SDK for Apple/include/Processing.NDI.Lib.h"` and `ls "/Library/NDI SDK for Apple/lib/macOS/"` (expect `libndi.dylib`). The default `BMD_SDK_DIR` in CMakeLists already points inside this SDK, so it is probably installed. |
| NDI runtime for testing "installed elsewhere" | NDI Tools for Mac (optional). Find what is on this machine: `mdfind -name libndi.dylib`, `ls /usr/local/lib/libndi*`, `echo $NDI_RUNTIME_DIR_V6`. |
| DeckLink SDK Mac headers | as for the current Mac build (`BMD_SDK_DIR`). The draft release `sdk-internal-do-not-publish` only has `Win/include`. |
| Blackmagic Desktop Video + a DeckLink card | `system_profiler SPPCIDataType` or Desktop Video Setup |
| NDI sources on the network | `/api/ndi/sources` once built |

Inspect the SDK's dylib before deciding how to link: `otool -D "<sdk>/lib/macOS/libndi.dylib"` (install name, probably `@rpath/libndi.dylib`), `otool -L` (its own dependencies), `codesign -dv` (who signed it), `lipo -info` (arm64 / universal).

## Steps

### 1. CMake (APPLE branch only)

Mirror the Windows pattern so NDI stays optional (CI and machines without the SDK must still build the plain addon):

- `NDI_SDK_DIR`: `-DNDI_SDK_DIR=…` → `$ENV{NDI_SDK_DIR}` → default `/Library/NDI SDK for Apple`. Build NDI only if `${NDI_SDK_DIR}/include/Processing.NDI.Lib.h` exists; print which way it went (`message(STATUS …)`).
- When found: add `src/ndi_passthrough.cpp` to the library sources, `target_include_directories(... "${NDI_SDK_DIR}/include")`, `target_compile_definitions(... HAVE_NDI)`.
- **Link weakly** so the addon still loads when `libndi.dylib` is absent: `target_link_options(${PROJECT_NAME} PRIVATE "LINKER:-weak_library,${NDI_SDK_DIR}/lib/macOS/libndi.dylib")` (the `LINKER:` form keeps the path, which contains spaces, in one argument; check the real link line). With a weak link, missing symbols resolve to NULL instead of failing `require()`.
- **rpaths** (in this order): `@loader_path/../Frameworks` (a bundled copy, see step 3), `@loader_path` (dev/test), `/usr/local/lib` (NDI Tools; confirm the real location on this Mac), `${NDI_SDK_DIR}/lib/macOS` (the SDK). Use `BUILD_RPATH`/`INSTALL_RPATH` or `-Wl,-rpath,…`; verify afterwards with `otool -l decklink_addon.node | grep -A2 LC_RPATH`.

### 2. `RuntimeAvailable()` on macOS (`ndi_passthrough.cpp`, the `#else` branch only)

Replace `return true` with a real check:

1. If `NDI_RUNTIME_DIR_V6` / `NDI_RUNTIME_DIR_V5` is set, try `dlopen("<dir>/libndi.dylib", RTLD_NOW | RTLD_GLOBAL)` first (that is how NDI tells apps where its runtime is).
2. Then check at runtime that the weak import resolved: `void* sym = dlsym(RTLD_DEFAULT, "NDIlib_initialize");` and treat `nullptr` as unavailable, with a `where` message like "libndi.dylib not found: install NDI Tools (ndi.video) or use the bundled copy". Do not test `&NDIlib_initialize == nullptr`: the header does not declare it `weak_import`, so clang may fold that comparison to false and the check would never fire.
3. Report the loaded path with `dladdr(sym, &info)` → `info.dli_fname`, cache the result in a static like the Windows code, and log `[NDI] Runtime loaded: …` / `unavailable: …` once.

Check: `nm -m native/decklink/build/Release/decklink_addon.node | grep NDIlib_initialize` must show the symbol as a weak reference (`(weak)` / `weak external`).

### 3. Runtime: bundle it or require NDI Tools? (ask the user)

- **Bundle** (works out of the box): copy the SDK's `libndi.dylib` to `Community Captioner.app/Contents/Frameworks/libndi.dylib` in `buildMacApp()` (scripts/build-app.js) and sign it in `signMacApp()` **before** the addon and the bundle (inner code first), with the hardened runtime and a timestamp. Do **not** put it in `Contents/MacOS/`: `signMacApp()` deletes every file there except `decklink_addon.node`, `CommunityCaptioner-bin` and `CommunityCaptioner`. Notarization will reject an unsigned or un-timestamped dylib. **Licensing:** read the NDI SDK license that ships with the SDK (redistribution of the runtime library and the required "NDI® is a registered trademark of Vizrt NDI AB" attribution / license text) and confirm with the user before shipping it; if bundled, add the required notice to `README-MAC.txt` in the zip.
- **Require NDI Tools**: nothing to bundle; the rpaths find the installed runtime; Caption Injection says "NDI: Not available" until it is installed. Say so in `README-MAC.txt` and the Help guide.

`electron/entitlements.mac.plist` already has `disable-library-validation`, so a Vizrt-signed dylib from `/usr/local/lib` loads under the hardened runtime.

### 4. Build and check the addon

```bash
npx cmake-js compile --directory native/decklink --CDBMD_SDK_DIR="$BMD_SDK_DIR" --config Release
node -e "const a=require('./native/decklink/build/Release/decklink_addon.node'); console.log(Object.keys(a)); console.log(a.ndiRuntime); console.log(a.findNdiSources(4000))"
node test/test-corrections.mjs && node test/test-cea708.mjs
```

Expect 6 + 2 functions plus `ndiRuntime`, and your network's NDI sources. Then prove the "no NDI" case: the addon must still load with the six SDI functions when `libndi.dylib` cannot be found. Do not move or delete system files to test this; use a scratch copy of the addon with a different rpath, or a second Mac/user without NDI, or ask the user.

### 5. NDI → SDI on real hardware (ask the user first)

This puts a live NDI picture with test captions on a physical SDI output. **Ask the user which DeckLink output is safe, which NDI source and which format**, and whether they can watch the output or a caption decoder. Then, against the **packaged** binary (not dev mode):

```bash
PORT=8090 "build/Community Captioner.app/Contents/MacOS/CommunityCaptioner-bin" &
curl -s http://localhost:8090/api/inject/status        # "addonLoaded":true, "ndiAvailable":true
curl -s "http://localhost:8090/api/ndi/sources?timeout=3000&max=20"
curl -s -X POST http://localhost:8090/api/inject/start -H "Content-Type: application/json" \
  -d '{"sourceKind":"ndi","ndiSource":"<exact source name>","outputDevice":<index>,"displayMode":<mode from /api/decklink/devices>,"frameRate":"29.97","encodingMode":"cea608"}'
# every ~3 s for a minute:
curl -s -X POST http://localhost:8090/api/inject/caption -H "Content-Type: application/json" -d '{"text":"Caption test over NDI to SDI.","isFinal":true}'
curl -s http://localhost:8090/api/inject/status        # framesOutput rising at the output rate, droppedFrames ~0, encoderQueueDepth drains to 0
curl -s -X POST http://localhost:8090/api/inject/stop
```

The Windows reference result: 15 NDI|HX cameras found in 40 ms; a 1080p59.94 UYVY camera → 1080p29.97 SDI for 75 s gave 2208 frames at 30.0/s, 0 dropped, 25 captions encoded, the CDP queue draining after each caption. That camera had no NDI audio, so **NDI audio was not tested on Windows; please test it on the Mac** with a source that carries audio (the handler resamples to 48 kHz and uses `WriteAudioSamplesSync`). If the user can watch, confirm the captions on a decoder.

### 6. Ship

- `npm run build:mac:notarized` (or `build:mac` + the notarize flags as usual). Then `codesign --verify --deep --strict "build/Community Captioner.app"`, `spctl --assess --type execute --verbose=2 "build/Community Captioner.app"`, and `otool -L "build/Community Captioner.app/Contents/MacOS/decklink_addon.node"`.
- Re-run the step 5 probes against the packaged app, then launch it the normal way (double-click) and open Caption Injection: NDI must be selectable and list sources.
- Replace the Mac zip on `v10.1` (`gh release upload v10.1 <zip> --clobber` if the version is unchanged; if you bump the version, delete the old Mac asset and tell the user that the Windows zip stays at 6.10.6). Update the release notes so the NDI sentence covers both platforms. Leave the Windows assets alone.
- Docs: in `CLAUDE.md` change "NDI is Windows-only in the addon today" to describe both platforms and add a macOS item next to the Windows one (how the runtime is found, bundled or not, the test result); in `components/HelpGuide.tsx` (Caption Injection) say what the Mac needs; `README-MAC.txt` (built by `scripts/build-app.js`) if the runtime is required or bundled. Commit small, push to `main`.

## Report back

Which way the runtime is provided (bundled or NDI Tools) and why; `otool -L` / `LC_RPATH` of the shipped addon; NDI sources found; the NDI → SDI result (frames/s, dropped, caption queue, whether captions were seen on a decoder, whether audio passed); the no-NDI load test; zip name, size and SHA256; notarization/`spctl` result; anything in this brief that was wrong.
