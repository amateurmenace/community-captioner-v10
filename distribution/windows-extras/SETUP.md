# Community Captioner — Windows Setup

## Quick start (most users)

1. **Run the app.** Double-click `CommunityCaptioner.exe`. Your browser opens to the app.
2. **Try captioning.** Live Session, Audience phone view, Context Engine, and translations all work immediately. The bundled `.env.local` already includes a Gemini API key.

That's it for the standard features. Stop here if you don't need SDI hardware caption injection.

---

## Embedded SDI captions (DeckLink users)

Caption Injection — embedding CEA-608/708 captions into a live SDI feed for a web presenter to pass through to YouTube — needs a tiny native driver (`decklink_addon.node`) that we couldn't bundle in the Windows installer because it has to be compiled on Windows itself.

You have **three ways** to get it working:

### Option 1 — Run the setup script (easiest)

If a prebuilt Windows addon has been published for your version:

1. Double-click **`setup-decklink.bat`** (next to this file).
2. It downloads the addon from the GitHub release and places it correctly.
3. Restart the app.

The script will tell you clearly if there's no prebuilt version yet.

### Option 2 — Download manually

1. Go to https://github.com/amateurmenace/community-captioner-v10/releases/latest
2. Look for a file named `decklink_addon-windows-x64.node`
3. Download it
4. Rename it to `decklink_addon.node` (drop the `-windows-x64` suffix)
5. Place it in the **same folder** as `CommunityCaptioner.exe`
6. Restart the app

### Option 3 — Build from source (developer)

If no prebuilt is available you can compile it yourself:

1. Install [Node.js 20](https://nodejs.org/)
2. Install [Visual Studio 2022 Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) — pick the "Desktop development with C++" workload
3. Register at [blackmagicdesign.com/developer](https://www.blackmagicdesign.com/developer/) and download the **DeckLink SDK**
4. Unzip the SDK somewhere, e.g. `C:\BMD-SDK`
5. Clone the repo:
   ```
   git clone https://github.com/amateurmenace/community-captioner-v10.git
   cd community-captioner-v10
   npm install
   ```
6. Build:
   ```
   npx cmake-js compile --directory native/decklink ^
     --CDBMD_SDK_DIR="C:\BMD-SDK\Win\include" --config Release
   ```
7. Copy `native\decklink\build\Release\decklink_addon.node` next to `CommunityCaptioner.exe`
8. Restart the app

---

## Required anyway: Blackmagic Desktop Video drivers

Even with the addon installed, Windows still needs Blackmagic's drivers to talk to the DeckLink hardware.

- Download: https://www.blackmagicdesign.com/support/family/capture-and-playback
- Install "Desktop Video" (you don't need DaVinci Resolve or the full suite)
- Reboot if prompted

---

## How do I know it worked?

Open the app, click **Caption Injection** from the workflow picker.

- If the addon is loaded, you'll see a normal 3-step setup screen with your DeckLink devices listed.
- If the addon is missing, you'll see a yellow "Setup Required" screen with download links and instructions.

If you have a DeckLink card connected and "Caption Injection" still shows the setup screen, double-check that:

1. The file is named exactly `decklink_addon.node` (no extra extension or suffix)
2. It sits in the **same folder** as `CommunityCaptioner.exe`
3. You restarted the app fully (close the terminal window, then re-launch the .exe)
4. Blackmagic Desktop Video shows your card in its Status panel

---

## What works without the addon

- Live Session captioning (browser microphone + Web Speech / Gemini)
- Audience phone view (QR-code access, translation, dark mode)
- Context Engine (PDF agenda upload, municipality wizard, dictionary)
- Real-time translations to 15 languages
- OBS / vMix overlay output

Only the SDI hardware caption injection step needs the addon.
