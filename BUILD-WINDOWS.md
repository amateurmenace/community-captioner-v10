# Building the DeckLink native addon on Windows

This is the step-by-step recipe for compiling `decklink_addon.node` on a Windows machine so SDI caption injection works in `CommunityCaptioner.exe`. **The macOS build is unaffected — this file is only for Windows.**

## Prerequisites (install these once)

| What | Why | Link |
|---|---|---|
| **Node.js 20** | Runs cmake-js | https://nodejs.org/ — pick the LTS Windows installer |
| **Visual Studio Build Tools 2022** | Provides MSVC + Windows SDK + midl.exe | https://visualstudio.microsoft.com/visual-cpp-build-tools/ — during install, check **"Desktop development with C++"** |
| **DeckLink SDK** | Headers + IDL for the Blackmagic API | https://www.blackmagicdesign.com/developer/ — free registration; pick "Blackmagic DeckLink SDK" (current is 12.4+) and download the .zip |
| **Git** | To clone the repo | https://git-scm.com/download/win |
| **GitHub CLI** *(optional)* | To upload the built addon to the release | https://cli.github.com/ — `gh auth login` once |
| **Blackmagic Desktop Video** | Driver for the DeckLink card itself (runtime, not build-time) | https://www.blackmagicdesign.com/support/family/capture-and-playback |

## Build steps

1. **Unpack the DeckLink SDK** somewhere simple, e.g. `C:\BMD-SDK\`. The script needs the path to `…\Win\include\` — it should contain `DeckLinkAPI.idl`.

2. **Clone the repo**:
   ```powershell
   git clone https://github.com/amateurmenace/community-captioner-v10.git
   cd community-captioner-v10
   ```

3. **Open the right shell.** MSVC needs its env vars on PATH. Easiest:
   - Start menu → **"x64 Native Tools Command Prompt for VS 2022"**
   - Then type `powershell` to get a PowerShell prompt with MSVC in scope.

4. **Run the build script:**
   ```powershell
   pwsh scripts/build-decklink-windows.ps1 -SdkPath "C:\BMD-SDK\Win\include"
   ```
   (Adjust the SDK path to wherever you unpacked it.)

   The script will check prerequisites, run MIDL on `DeckLinkAPI.idl`, run cmake-js, and on success drop the build at `build\decklink_addon-windows-x64.node`.

5. **Test locally:**
   - Copy `build\decklink_addon-windows-x64.node` next to `CommunityCaptioner.exe`
   - Rename it to **`decklink_addon.node`** (drop the `-windows-x64` suffix)
   - Restart `CommunityCaptioner.exe`
   - Open **Caption Injection** in the app — the setup screen should be gone and you should see your DeckLink devices listed.

6. **Publish so other Windows users can grab it.** Two ways:

   **Easiest (gh CLI):**
   ```powershell
   gh release upload v6.3.1 build\decklink_addon-windows-x64.node --clobber
   ```

   **Browser:**
   - Go to https://github.com/amateurmenace/community-captioner-v10/releases/tag/v6.3.1
   - Click "Edit" → drag `decklink_addon-windows-x64.node` into the file list → Save

   Once published, other Windows users will be able to run `setup-decklink.bat` from the Windows zip and have it auto-fetch.

## Troubleshooting

### "cl.exe not found"
You opened a regular cmd/PowerShell instead of the Native Tools Command Prompt. Close it, open **x64 Native Tools Command Prompt for VS 2022** from the Start menu, then type `powershell` and re-run.

### "DeckLinkAPI.idl not found"
Your `-SdkPath` is wrong. Open Explorer to the path you passed; if you don't see `DeckLinkAPI.idl`, look one level deeper or higher. You want the directory that has `.idl` and `.h` files directly inside it (typically `…\DeckLink SDK 12.x\Win\include`).

### "midl: error MIDL2025: syntax error"
You're probably running a too-old Windows SDK. The DeckLink SDK 12.x requires Windows SDK 10.0.17763 or newer. Open Visual Studio Installer → modify → make sure a recent Windows 10/11 SDK is selected under the C++ workload's optional components.

### Link errors about `IDeckLink*` symbols
The MIDL step didn't produce `DeckLinkAPI_i.c`. Look in `native\decklink\build\bmd_gen\` — it should be there. If not, run MIDL manually:
```powershell
midl /win64 /h DeckLinkAPI_h.h /iid DeckLinkAPI_i.c /out . "C:\BMD-SDK\Win\include\DeckLinkAPI.idl"
```

### "The system cannot find the file decklink_addon.node" at runtime
Make sure you renamed it (drop the `-windows-x64` suffix) AND placed it in the same folder as the .exe — not in a subfolder.

### Built fine but the app still shows "DeckLink Addon Not Loaded"
- Confirm Blackmagic Desktop Video is installed (this is the *runtime* driver, separate from the build-time SDK)
- Confirm the DeckLink card shows up in Blackmagic's Status panel
- Close the app fully (the launcher window), then re-launch from the .exe
