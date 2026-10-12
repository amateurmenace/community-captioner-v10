#!/usr/bin/env node
/**
 * Unified build script: standalone Mac .app and Windows .exe for Community Captioner.
 *
 * Usage:
 *   node scripts/build-app.js                  # build for current platform
 *   node scripts/build-app.js --platform mac   # macOS .app bundle
 *   node scripts/build-app.js --platform win   # Windows .exe
 *   node scripts/build-app.js --platform all   # both
 *
 * Pipeline:
 *   1. vite build        → dist/           (frontend)
 *   2. esbuild bundle    → build/server.cjs (server in one CJS file)
 *   3. write launcher.cjs                   (entry: starts server, opens browser)
 *   4. pkg               → standalone binary
 *   5. (mac) wrap in .app bundle
 */

import { execSync } from 'child_process';
import { build } from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BUILD = path.join(ROOT, 'build');

// ---------------------------------------------------------------------------
// Parse --platform flag
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
let platformFlag = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--platform' && args[i + 1]) {
    platformFlag = args[i + 1].toLowerCase();
  }
}

const currentPlatform = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux';
if (!platformFlag) platformFlag = currentPlatform;

const buildMac = platformFlag === 'mac' || platformFlag === 'all';
const buildWin = platformFlag === 'win' || platformFlag === 'all';
// --notarize (or NOTARIZE=1): submit the signed .app to Apple and staple the ticket
const notarize = args.includes('--notarize') || /^(1|true|yes)$/i.test(process.env.NOTARIZE || '');

if (!buildMac && !buildWin) {
  console.error(`Unknown platform "${platformFlag}". Use: mac, win, or all`);
  process.exit(1);
}

console.log(`\nBuilding for: ${[buildMac && 'macOS', buildWin && 'Windows'].filter(Boolean).join(' + ')}\n`);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function run(cmd, label) {
  console.log(`\n=== ${label} ===`);
  execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
}

function readPkgVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  return pkg.version || '1.0.0';
}

// ---------------------------------------------------------------------------
// Launcher code (embedded in the binary by pkg)
// ---------------------------------------------------------------------------
function getLauncherCode() {
  return `#!/usr/bin/env node
// Community Captioner — standalone launcher
// Starts the relay server and opens the system browser.

const path = require('path');
const { exec } = require('child_process');

process.env.NODE_ENV = 'production';
process.env.PORT = process.env.PORT || '8080';

// Polyfill browser globals that pdf-parse/pdfjs-dist expects (canvas rendering)
if (typeof globalThis.DOMMatrix === 'undefined') {
  globalThis.DOMMatrix = class DOMMatrix {
    constructor() { this.a=1;this.b=0;this.c=0;this.d=1;this.e=0;this.f=0; }
    isIdentity = true;
    translate() { return new DOMMatrix(); }
    scale() { return new DOMMatrix(); }
    inverse() { return new DOMMatrix(); }
    multiply() { return new DOMMatrix(); }
    transformPoint(p) { return p || {x:0,y:0}; }
  };
}
if (typeof globalThis.ImageData === 'undefined') {
  globalThis.ImageData = class ImageData { constructor(w,h) { this.width=w;this.height=h;this.data=new Uint8ClampedArray(w*h*4); } };
}
if (typeof globalThis.Path2D === 'undefined') {
  globalThis.Path2D = class Path2D { constructor(){} addPath(){} closePath(){} moveTo(){} lineTo(){} bezierCurveTo(){} rect(){} arc(){} };
}

// Resolve base directory depending on packaging context
const isPkg = typeof process.pkg !== 'undefined';
let baseDir;

if (isPkg) {
  const execDir = path.dirname(process.execPath);

  // Detect macOS .app bundle: …/Community Captioner.app/Contents/MacOS/CommunityCaptioner
  if (execDir.endsWith(path.join('Contents', 'MacOS'))) {
    // Resources dir is sibling of MacOS inside Contents/
    baseDir = path.join(execDir, '..', 'Resources');
  } else {
    // Windows / plain binary — dist/ is embedded in the pkg snapshot
    baseDir = __dirname;
  }
} else {
  baseDir = path.resolve(__dirname, '..');
}

// Tell the bundled server where to find the frontend build
process.env.DIST_PATH = path.join(baseDir, 'dist');

// Show a native OS dialog (non-blocking, fire-and-forget)
function showDialog(title, msg) {
  const plat = process.platform;
  if (plat === 'darwin') {
    exec('osascript -e ' + JSON.stringify(
      'display dialog ' + JSON.stringify(msg) + ' with title ' + JSON.stringify(title) + ' buttons {"OK"} default button "OK"'
    ));
  } else if (plat === 'win32') {
    exec('mshta "javascript:var sh=new ActiveXObject(\\'WScript.Shell\\');sh.Popup(' + JSON.stringify(msg).replace(/"/g, '\\'') + ',0,' + JSON.stringify(title).replace(/"/g, '\\'') + ',64);close()"');
  }
}

// Open a URL in the default browser
function openBrowser(url) {
  const plat = process.platform;
  let cmd;
  if (plat === 'win32') {
    cmd = 'start "" "' + url + '"';
  } else if (plat === 'darwin') {
    cmd = 'open "' + url + '"';
  } else {
    cmd = 'xdg-open "' + url + '"';
  }
  exec(cmd, (err) => {
    if (err) console.log('Could not open browser automatically. Visit ' + url);
  });
}

// Banner
const defaultUrl = 'http://localhost:' + process.env.PORT;
console.log('');
console.log('  ┌─────────────────────────────────────────┐');
console.log('  │         Community Captioner              │');
console.log('  │                                          │');
console.log('  │  Starting server...                      │');
console.log('  │  Press Ctrl+C to stop                    │');
console.log('  └─────────────────────────────────────────┘');
console.log('');

// Intercept stdout to detect the server ready signal
const origWrite = process.stdout.write.bind(process.stdout);
let browserOpened = false;
process.stdout.write = function(chunk, encoding, callback) {
  const text = typeof chunk === 'string' ? chunk : chunk.toString();
  // Server emits "__SERVER_READY__ http://localhost:XXXX" when listening
  const match = text.match(/__SERVER_READY__\\s+(https?:\\/\\/[^\\s]+)/);
  if (match && !browserOpened) {
    browserOpened = true;
    const serverUrl = match[1];
    console.log('  Opening browser at ' + serverUrl);
    openBrowser(serverUrl);
    // Don't print the signal itself
    return typeof callback === 'function' ? callback() : true;
  }
  return origWrite(chunk, encoding, callback);
};

// Catch fatal errors and show a dialog so the user knows what happened
process.on('uncaughtException', (err) => {
  const msg = err.message || String(err);
  console.error('Fatal error:', msg);
  showDialog('Community Captioner — Error', msg);
  // Don't exit immediately so the dialog has time to show
  setTimeout(() => process.exit(1), 5000);
});

// Start server
require('./server.cjs');

// Fallback: if no ready signal after 15s, try opening default URL anyway
setTimeout(() => {
  if (!browserOpened) {
    browserOpened = true;
    console.log('  (Ready signal not detected, opening default URL)');
    openBrowser(defaultUrl);
  }
}, 15000);

// Graceful shutdown
function shutdown() {
  console.log('\\nShutting down…');
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
`;
}

// ---------------------------------------------------------------------------
// Mac .app bundle helpers
// ---------------------------------------------------------------------------
function createInfoPlist(version) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Community Captioner</string>
  <key>CFBundleDisplayName</key>
  <string>Community Captioner</string>
  <key>CFBundleIdentifier</key>
  <string>com.community.captioner</string>
  <key>CFBundleVersion</key>
  <string>${version}</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
  <key>CFBundleExecutable</key>
  <string>CommunityCaptioner</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleSignature</key>
  <string>????</string>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>LSUIElement</key>
  <false/>
  <key>NSMicrophoneUsageDescription</key>
  <string>Community Captioner needs microphone access for live captioning.</string>
</dict>
</plist>`;
}

function buildMacApp(binaryPath, version) {
  const appName = 'Community Captioner.app';
  const appDir = path.join(BUILD, appName);
  const contentsDir = path.join(appDir, 'Contents');
  const macosDir = path.join(contentsDir, 'MacOS');
  const resourcesDir = path.join(contentsDir, 'Resources');

  // Create structure
  fs.mkdirSync(macosDir, { recursive: true });
  fs.mkdirSync(resourcesDir, { recursive: true });

  // Info.plist
  fs.writeFileSync(path.join(contentsDir, 'Info.plist'), createInfoPlist(version));

  // Move the pkg binary into MacOS/ as the actual server process
  fs.renameSync(binaryPath, path.join(macosDir, 'CommunityCaptioner-bin'));
  fs.chmodSync(path.join(macosDir, 'CommunityCaptioner-bin'), 0o755);

  // Write a shell script that opens Terminal.app running the binary.
  // This ensures the user sees server logs when double-clicking the .app.
  // If Terminal automation is denied (or osascript fails), run the binary
  // directly so the app still starts and opens the browser.
  const launchScript = `#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
BIN="$DIR/CommunityCaptioner-bin"
osascript - "$BIN" <<'END_SCRIPT' || exec "$BIN"
on run argv
  set binPath to item 1 of argv
  tell application "Terminal"
    activate
    do script "clear; exec " & quoted form of binPath
  end tell
end run
END_SCRIPT
`;
  fs.writeFileSync(path.join(macosDir, 'CommunityCaptioner'), launchScript);
  fs.chmodSync(path.join(macosDir, 'CommunityCaptioner'), 0o755);

  // App icon (assets/icon.icns, generated from assets/icon.svg with iconutil)
  const icns = path.join(ROOT, 'assets', 'icon.icns');
  if (fs.existsSync(icns)) {
    fs.copyFileSync(icns, path.join(resourcesDir, 'AppIcon.icns'));
  } else {
    console.warn('  WARNING: assets/icon.icns missing — the app will show the generic icon');
  }

  // Copy dist/ (frontend) and local/ (speech server script) into Resources/
  const distSrc = path.join(ROOT, 'dist');
  fs.cpSync(distSrc, path.join(resourcesDir, 'dist'), { recursive: true });
  if (fs.existsSync(path.join(ROOT, 'local'))) fs.cpSync(path.join(ROOT, 'local'), path.join(resourcesDir, 'local'), { recursive: true });

  // Bundle the macOS DeckLink addon next to the binary. relay.js falls back to
  // <exe dir>/decklink_addon.node when the in-tree path isn't available (pkg).
  const macAddon = path.join(ROOT, 'native', 'decklink', 'build', 'Release', 'decklink_addon.node');
  if (fs.existsSync(macAddon)) {
    fs.copyFileSync(macAddon, path.join(macosDir, 'decklink_addon.node'));
    console.log('  Bundled macOS DeckLink addon (native/decklink/build/Release/decklink_addon.node)');
  } else {
    console.warn('  WARNING: no macOS DeckLink addon found — run "npm run build:native" first for SDI caption injection.');
  }

  // Optional: bundle the NDI runtime (libndi.dylib from the NDI SDK for Apple) so
  // NDI → SDI works without NDI Tools installed. Off by default; enable with
  // BUNDLE_NDI=1 (or --bundle-ndi). The addon's first rpath is
  // @loader_path/../Frameworks, so Contents/Frameworks/libndi.dylib wins over
  // /usr/local/lib. Redistribution is subject to the NDI SDK license: the SDK's
  // libndi_licenses.txt must ship with the binary and the README carries the
  // trademark attribution (see createMacReadme).
  const ndiSdk = process.env.NDI_SDK_DIR || '/Library/NDI SDK for Apple';
  const ndiDylibSrc = path.join(ndiSdk, 'lib', 'macOS', 'libndi.dylib');
  // Bundled by default when the SDK is present (decision 2026-10-12); BUNDLE_NDI=0
  // or --no-bundle-ndi leaves it out and the app then needs NDI Tools for Mac.
  const bundleNdi = process.env.BUNDLE_NDI !== '0' && !process.argv.includes('--no-bundle-ndi') && fs.existsSync(ndiDylibSrc);
  if (bundleNdi) {
    const licenses = path.join(ndiSdk, 'lib', 'macOS', 'libndi_licenses.txt');
    const fwDir = path.join(contentsDir, 'Frameworks');
    fs.mkdirSync(fwDir, { recursive: true });
    const dst = path.join(fwDir, 'libndi.dylib');
    fs.copyFileSync(ndiDylibSrc, dst);
    // The app is arm64-only; drop the x86_64 slice (29 MB → ~15 MB). The file is
    // re-signed with our identity in signMacApp, so the SDK's signature going
    // stale here does not matter.
    try {
      const archs = execSync(`lipo -archs "${dst}"`, { encoding: 'utf8' }).trim();
      if (archs.includes('x86_64') && archs.includes('arm64')) {
        execSync(`lipo -thin arm64 "${dst}" -output "${dst}.arm64"`, { stdio: 'inherit' });
        fs.renameSync(`${dst}.arm64`, dst);
      }
    } catch (e) { console.warn('  Could not thin libndi.dylib to arm64 (kept universal):', e.message); }
    if (fs.existsSync(licenses)) fs.copyFileSync(licenses, path.join(resourcesDir, 'libndi_licenses.txt'));
    console.log(`  Bundled NDI runtime (${ndiDylibSrc}) into Contents/Frameworks/libndi.dylib (${(fs.statSync(dst).size / 1e6).toFixed(1)} MB)`);
  } else if (process.env.BUNDLE_NDI === '0' || process.argv.includes('--no-bundle-ndi')) {
    console.log('  NDI runtime not bundled (BUNDLE_NDI=0): the app will need NDI Tools for Mac for NDI → SDI');
  } else {
    console.warn(`  WARNING: ${ndiDylibSrc} not found — NDI runtime not bundled; the app will need NDI Tools for Mac for NDI → SDI`);
  }

  // Bundle .env.local (Gemini key) so the Context Engine works out-of-box,
  // mirroring the Windows bundle. It lives in Resources/ (not MacOS/) because
  // codesign refuses non-code files inside Contents/MacOS. relay.js checks
  // <Resources>/.env.local (the parent of DIST_PATH) as well as <exe dir>.
  const envSrc = path.join(ROOT, '.env.local');
  if (fs.existsSync(envSrc)) {
    fs.copyFileSync(envSrc, path.join(resourcesDir, '.env.local'));
    console.log('  Bundled .env.local (Gemini API key) into Resources/ — anyone with this build can use that key.');
  }

  // Operator-facing readme shipped next to the .app in the zip
  fs.writeFileSync(path.join(BUILD, 'README-MAC.txt'), createMacReadme(version));

  return appDir;
}

function createMacReadme(version) {
  const bundledNdi = fs.existsSync(path.join(BUILD, 'Community Captioner.app', 'Contents', 'Frameworks', 'libndi.dylib'));
  const ndiNote = bundledNdi
    ? `NDI
---
NDI → SDI passthrough (Caption Injection) uses the NDI runtime bundled in the app
(Contents/Frameworks/libndi.dylib, © Vizrt NDI AB; see libndi_licenses.txt in the
app's Resources). NDI® is a registered trademark of Vizrt NDI AB. This app is
compatible with NDI and is not a product of NDI.
`
    : `NDI
---
NDI → SDI passthrough (Caption Injection) needs the NDI runtime, which the free
NDI Tools for Mac install (https://ndi.video/tools/). Without it the NDI option
shows "Not available"; everything else works. NDI® is a registered trademark of
Vizrt NDI AB.
`;
  return `Community Captioner ${version} — macOS (Apple Silicon)
=====================================================
${ndiNote}

FIRST LAUNCH
  macOS blocks apps downloaded outside the App Store the first time.
  Either: right-click "Community Captioner.app" → Open → Open,
  or: System Settings → Privacy & Security → scroll down → "Open Anyway".
  (The app is signed but not notarized; this prompt appears once.)

WHAT HAPPENS
  1. A Terminal window opens showing the relay server log.
  2. Your browser opens http://localhost:8080 automatically.
  3. Close the Terminal window (or press Ctrl+C in it) to stop.
  The app asks for Microphone access the first time you press Start.

SDI CAPTION INJECTION (DeckLink)
  Install Blackmagic Desktop Video 12+ first (free, blackmagicdesign.com/support).
  The DeckLink addon is bundled inside the app; the Caption Injection screen
  shows "driver loaded" when a device is detected.

GEMINI API KEY
  Needed for the Municipality Wizard, PDF extraction, Auto-Learn, Summarize
  mode and translation. Enter it in Context Engine → Settings, or edit the
  .env.local file inside "Community Captioner.app/Contents/Resources/".

PHONE / AUDIENCE VIEW
  Press the QR button on the dashboard. A public link (Cloudflare tunnel) is
  created automatically when the machine has internet access.
`;
}

/**
 * Sign the .app so Apple Silicon will run it. Uses the "Developer ID
 * Application" identity from the keychain when present, otherwise ad-hoc.
 * Inner Mach-O binaries are signed first, then the bundle. With a Developer ID
 * the hardened runtime is enabled (required for notarization) using
 * electron/entitlements.mac.plist, which allows JIT (Node), loading the
 * DeckLink framework signed by Blackmagic, microphone and network.
 * Returns the identity used.
 */
function signMacApp(appDir) {
  let identity = '-';
  try {
    const out = execSync('security find-identity -v -p codesigning', { encoding: 'utf8' });
    const m = out.match(/"(Developer ID Application: [^"]+)"/);
    if (m) identity = m[1];
  } catch {}

  const macosDir = path.join(appDir, 'Contents', 'MacOS');
  const entitlements = path.join(ROOT, 'electron', 'entitlements.mac.plist');
  const addon = path.join(macosDir, 'decklink_addon.node');
  const bin = path.join(macosDir, 'CommunityCaptioner-bin');

  // Anything that is not code inside Contents/MacOS breaks the bundle seal
  // (e.g. a .data folder left behind by a test launch of the binary).
  for (const entry of fs.readdirSync(macosDir)) {
    if (!['decklink_addon.node', 'CommunityCaptioner-bin', 'CommunityCaptioner'].includes(entry)) {
      fs.rmSync(path.join(macosDir, entry), { recursive: true, force: true });
      console.log(`  Removed stray ${entry} from Contents/MacOS before signing`);
    }
  }

  const signWith = (id) => {
    const devId = id !== '-';
    const ts = devId ? '--timestamp' : '';
    const runtime = devId ? '--options runtime' : '';
    const ent = devId && fs.existsSync(entitlements) ? `--entitlements "${entitlements}"` : '';
    const ndiDylib = path.join(appDir, 'Contents', 'Frameworks', 'libndi.dylib');
    if (fs.existsSync(ndiDylib)) execSync(`codesign --force --sign "${id}" ${runtime} ${ts} "${ndiDylib}"`, { stdio: 'inherit' });
    if (fs.existsSync(addon)) execSync(`codesign --force --sign "${id}" ${runtime} ${ts} "${addon}"`, { stdio: 'inherit' });
    if (fs.existsSync(bin)) execSync(`codesign --force --sign "${id}" ${runtime} ${ent} ${ts} "${bin}"`, { stdio: 'inherit' });
    execSync(`codesign --force --sign "${id}" ${runtime} ${ent} ${ts} "${appDir}"`, { stdio: 'inherit' });
  };

  let used = identity;
  try {
    signWith(identity);
    console.log(`  Signed with: ${identity === '-' ? 'ad-hoc signature (no Developer ID in keychain)' : `${identity} (hardened runtime)`}`);
  } catch (e) {
    console.warn('  Code signing with identity failed:', e.message);
    if (identity !== '-') {
      try { signWith('-'); used = '-'; console.log('  Fell back to ad-hoc signature'); } catch (e2) { console.warn('  Ad-hoc signing failed too:', e2.message); }
    }
  }
  try {
    execSync(`codesign --verify --deep --strict "${appDir}"`, { stdio: 'inherit' });
    console.log('  Signature verified');
  } catch { console.warn('  Signature verification failed (app may still run locally)'); }
  return used;
}

/**
 * Notarize the signed .app with Apple and staple the ticket, so Gatekeeper
 * opens it without the "unidentified developer" prompt.
 *
 * Credentials (first match wins):
 *   1. NOTARY_PROFILE            keychain profile created once with
 *                                `xcrun notarytool store-credentials <name> --apple-id … --team-id … --password <app-specific>`
 *                                (default profile name: "community-captioner")
 *   2. APPLE_API_KEY (.p8 path) + APPLE_API_KEY_ID + APPLE_API_ISSUER   App Store Connect API key
 *   3. APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID             Apple ID
 * Returns true on success. Throws if credentials are missing or Apple rejects the build.
 */
function notarizeMacApp(appDir) {
  const profile = process.env.NOTARY_PROFILE || 'community-captioner';
  let auth = null;
  const hasProfile = (() => {
    try { execSync(`xcrun notarytool history --keychain-profile "${profile}"`, { stdio: 'pipe' }); return true; } catch { return false; }
  })();
  if (hasProfile) auth = `--keychain-profile "${profile}"`;
  else if (process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER)
    auth = `--key "${process.env.APPLE_API_KEY}" --key-id "${process.env.APPLE_API_KEY_ID}" --issuer "${process.env.APPLE_API_ISSUER}"`;
  else if (process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID)
    auth = `--apple-id "${process.env.APPLE_ID}" --password "${process.env.APPLE_APP_SPECIFIC_PASSWORD}" --team-id "${process.env.APPLE_TEAM_ID}"`;
  if (!auth) {
    throw new Error(
      `No notarization credentials. Run once:\n` +
      `    xcrun notarytool store-credentials ${profile} --apple-id <your Apple ID email> --team-id 6M536MV7GT --password <app-specific password>\n` +
      `  (create the app-specific password at https://account.apple.com → Sign-In and Security → App-Specific Passwords),\n` +
      `  or set APPLE_API_KEY/APPLE_API_KEY_ID/APPLE_API_ISSUER, or APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID.`
    );
  }

  const tmpZip = path.join(BUILD, '_notarize-upload.zip');
  if (fs.existsSync(tmpZip)) fs.rmSync(tmpZip);
  execSync(`ditto -c -k --sequesterRsrc --keepParent "${appDir}" "${tmpZip}"`, { stdio: 'inherit' });
  console.log(`  Submitting ${(fs.statSync(tmpZip).size / 1024 / 1024).toFixed(1)} MB to Apple notary service (usually 1–10 minutes)…`);

  let submitOut = '';
  try {
    submitOut = execSync(`xcrun notarytool submit "${tmpZip}" ${auth} --wait --timeout 45m --output-format json`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  } catch (e) {
    submitOut = (e.stdout || '').toString();
    if (!submitOut) throw new Error(`notarytool submit failed: ${e.message}`);
  } finally {
    if (fs.existsSync(tmpZip)) fs.rmSync(tmpZip);
  }

  let result = {};
  try { result = JSON.parse(submitOut); } catch { throw new Error(`Unexpected notarytool output: ${submitOut.slice(0, 400)}`); }
  console.log(`  Submission ${result.id || '?'}: ${result.status || 'unknown'}`);
  if (result.status !== 'Accepted') {
    if (result.id) {
      try {
        const log = execSync(`xcrun notarytool log "${result.id}" ${auth}`, { encoding: 'utf8' });
        console.error('  Notary log:\n' + log.split('\n').map(l => '    ' + l).join('\n'));
      } catch {}
    }
    throw new Error(`Apple did not accept the build (status: ${result.status || 'unknown'})`);
  }

  execSync(`xcrun stapler staple "${appDir}"`, { stdio: 'inherit' });
  execSync(`xcrun stapler validate "${appDir}"`, { stdio: 'inherit' });
  try {
    execSync(`spctl --assess --type execute --verbose=2 "${appDir}"`, { stdio: 'inherit' });
    console.log('  Gatekeeper assessment: accepted (notarized + stapled)');
  } catch { console.warn('  Gatekeeper assessment did not pass — the ticket is stapled but spctl rejected it; check the output above'); }
  return true;
}

function zipMacApp(appDir, version, notarized = false) {
  const zipPath = path.join(BUILD, `Community-Captioner-${version}-mac-arm64.zip`);
  if (fs.existsSync(zipPath)) fs.rmSync(zipPath);
  // Stage app + readme in a temp folder so the zip has both at the top level
  const stage = path.join(BUILD, '_mac-stage');
  if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true });
  fs.mkdirSync(stage, { recursive: true });
  fs.cpSync(appDir, path.join(stage, path.basename(appDir)), { recursive: true });
  let readme = fs.readFileSync(path.join(BUILD, 'README-MAC.txt'), 'utf8');
  if (notarized) {
    readme = readme.replace(/FIRST LAUNCH[\s\S]*?\n\n/, 'FIRST LAUNCH\n  Double-click "Community Captioner.app". The app is signed and notarized by Apple,\n  so macOS opens it without a security prompt.\n\n');
  }
  fs.writeFileSync(path.join(stage, 'README-MAC.txt'), readme);
  // ditto preserves symlinks, permissions and signatures (zip -r would not)
  execSync(`ditto -c -k --sequesterRsrc --keepParent "${stage}" "${zipPath}"`, { stdio: 'inherit' });
  // --keepParent nests under "_mac-stage/"; rebuild without the parent folder instead
  fs.rmSync(zipPath);
  execSync(`cd "${stage}" && ditto -c -k --sequesterRsrc . "${zipPath}"`, { stdio: 'inherit' });
  fs.rmSync(stage, { recursive: true });
  return zipPath;
}

// ---------------------------------------------------------------------------
// Main build pipeline
// ---------------------------------------------------------------------------
async function main() {
  const version = readPkgVersion();

  // Clean only intermediate files, preserve platform outputs
  for (const f of ['launcher.cjs', 'server.cjs', 'package.json', '_entry.js', 'dist']) {
    const p = path.join(BUILD, f);
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
  }
  fs.mkdirSync(BUILD, { recursive: true });

  // 1. Build frontend
  run('npx vite build', 'Building frontend (Vite)');

  // 2. Bundle server with esbuild
  console.log('\n=== Bundling server (esbuild) ===');
  const shimPath = path.join(BUILD, '_entry.js');
  fs.writeFileSync(shimPath, `
// Force esbuild to bundle dynamically-imported deps
import 'multer';
import 'pdf-parse';
import '@google/genai';
import 'cloudflared';
import '../server/relay.js';
`);

  await build({
    entryPoints: [shimPath],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile: path.join(BUILD, 'server.cjs'),
    external: [
      '*.node',
      'cpu-features',
      '@napi-rs/canvas',
      'canvas',
    ],
    define: {
      'import.meta.url': '__importMetaUrl',
      'process.env.CC_APP_VERSION': JSON.stringify(version),
    },
    banner: {
      js: [
        '// Community Captioner — bundled server',
        'const __importMetaUrl = require("url").pathToFileURL(__filename).href;',
      ].join('\n'),
    },
    logLevel: 'info',
  });

  fs.unlinkSync(shimPath);

  // 3. Write launcher
  console.log('\n=== Writing launcher ===');
  fs.writeFileSync(path.join(BUILD, 'launcher.cjs'), getLauncherCode());

  // 4. Copy dist/ and local/ (speech server script) into build/ so pkg can snapshot them
  console.log('\n=== Copying dist/ and local/ into build/ ===');
  fs.cpSync(path.join(ROOT, 'dist'), path.join(BUILD, 'dist'), { recursive: true });
  if (fs.existsSync(path.join(ROOT, 'local'))) fs.cpSync(path.join(ROOT, 'local'), path.join(BUILD, 'local'), { recursive: true });

  // 5. Write pkg config (shared) — dist + local included as snapshot assets
  const pkgConfigBase = {
    name: 'community-captioner',
    version,
    main: 'launcher.cjs',
    pkg: {
      assets: ['server.cjs', 'dist/**/*', 'local/**/*'],
    },
  };
  fs.writeFileSync(
    path.join(BUILD, 'package.json'),
    JSON.stringify(pkgConfigBase, null, 2)
  );

  // 5. Build per platform
  if (buildMac) {
    console.log('\n=== Packaging macOS binary (pkg) ===');
    const macBin = path.join(BUILD, 'CommunityCaptioner-mac');
    run(
      `npx @yao-pkg/pkg "${path.join(BUILD, 'launcher.cjs')}" ` +
      `--target node20-macos-arm64 ` +
      `--output "${macBin}" ` +
      `--config "${path.join(BUILD, 'package.json')}"`,
      'pkg → macOS arm64'
    );

    console.log('\n=== Creating .app bundle ===');
    const appDir = path.join(BUILD, 'Community Captioner.app');
    if (fs.existsSync(appDir)) fs.rmSync(appDir, { recursive: true, force: true });
    buildMacApp(macBin, version);

    console.log('\n=== Signing .app ===');
    const identityUsed = signMacApp(appDir);

    let notarized = false;
    if (notarize) {
      console.log('\n=== Notarizing .app ===');
      if (identityUsed === '-') {
        console.error('  Cannot notarize an ad-hoc signed app — a "Developer ID Application" identity is required in the keychain.');
        process.exit(1);
      }
      try {
        notarized = notarizeMacApp(appDir);
      } catch (e) {
        console.error(`\n  Notarization failed: ${e.message}\n`);
        process.exit(1);
      }
    } else {
      console.log('\n  (Not notarized — pass --notarize or set NOTARIZE=1 to submit to Apple; first launch will need right-click → Open.)');
    }

    console.log('\n=== Zipping for release ===');
    const zipPath = zipMacApp(appDir, version, notarized);

    const size = getTotalSize(appDir);
    console.log(`\n  Built: ${appDir} (${size})`);
    console.log(`  Release zip: ${zipPath} (${(fs.statSync(zipPath).size / 1024 / 1024).toFixed(1)} MB)`);
    console.log(`\n  To use on macOS:`);
    console.log(`    1. Unzip, right-click "Community Captioner.app" → Open (first time only)`);
    console.log(`    2. Browser opens automatically to http://localhost:8080`);
    console.log(`    3. Close the terminal window or press Ctrl+C to stop\n`);
  }

  if (buildWin) {
    console.log('\n=== Packaging Windows .exe (pkg) ===');
    const winExe = path.join(BUILD, 'CommunityCaptioner.exe');
    // Quoted: Windows checkouts often live under a profile path with a space
    // (C:\Users\First Last\...), which pkg would otherwise split into extra entries.
    run(
      `npx @yao-pkg/pkg "${path.join(BUILD, 'launcher.cjs')}" ` +
      `--target node20-win-x64 ` +
      `--output "${winExe}" ` +
      `--config "${path.join(BUILD, 'package.json')}"`,
      'pkg → Windows x64'
    );

    if (fs.existsSync(winExe)) {
      // Stage a distribution folder so users get .exe + helpers + .env.local
      // together in one zip.
      const winBundle = path.join(BUILD, 'windows-bundle');
      if (fs.existsSync(winBundle)) fs.rmSync(winBundle, { recursive: true });
      fs.mkdirSync(winBundle, { recursive: true });

      fs.copyFileSync(winExe, path.join(winBundle, 'CommunityCaptioner.exe'));

      // Bundle .env.local (Gemini key) so the Context Engine works out-of-box
      const envSrc = path.join(ROOT, '.env.local');
      if (fs.existsSync(envSrc)) {
        fs.copyFileSync(envSrc, path.join(winBundle, '.env.local'));
      }

      // Bundle Windows setup helpers (SETUP.md, setup-decklink.bat) so
      // DeckLink users have a clear path to enable SDI injection.
      const extrasDir = path.join(ROOT, 'distribution', 'windows-extras');
      if (fs.existsSync(extrasDir)) {
        for (const f of fs.readdirSync(extrasDir)) {
          fs.copyFileSync(path.join(extrasDir, f), path.join(winBundle, f));
        }
      }

      // Bundle a Windows-built decklink_addon.node if one exists: built in-tree
      // on this Windows machine (npm run build:native), dropped into prebuilt/,
      // or downloaded from the CI workflow. Otherwise leave it out — the in-app
      // setup card explains how to fetch it.
      const winAddonCandidates = [
        process.platform === 'win32' ? path.join(ROOT, 'native', 'decklink', 'build', 'Release', 'decklink_addon.node') : null,
        path.join(ROOT, 'native', 'decklink', 'prebuilt', 'decklink_addon-windows-x64.node'),
        path.join(ROOT, 'decklink_addon-windows-x64.node'),
      ].filter(Boolean);
      let bundledAddon = false;
      for (const c of winAddonCandidates) {
        if (fs.existsSync(c)) {
          fs.copyFileSync(c, path.join(winBundle, 'decklink_addon.node'));
          console.log(`  Bundled Windows DeckLink addon from ${c}`);
          bundledAddon = true;
          break;
        }
      }
      if (!bundledAddon) console.warn('  WARNING: no Windows DeckLink addon found — SDI caption injection will need setup-decklink.bat on the target machine.');

      // Zip the bundle on Windows (Compress-Archive ships with PowerShell) so the
      // release asset name matches utils/appLinks.ts. On other platforms, zip by hand.
      const winZip = path.join(BUILD, `Community-Captioner-${version}-windows-x64.zip`);
      if (process.platform === 'win32') {
        if (fs.existsSync(winZip)) fs.rmSync(winZip);
        try {
          execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${winBundle}\\*' -DestinationPath '${winZip}' -CompressionLevel Optimal"`, { stdio: 'inherit' });
          console.log(`  Release zip: ${winZip} (${(fs.statSync(winZip).size / 1024 / 1024).toFixed(1)} MB)`);
        } catch (e) {
          console.warn('  Could not zip the bundle automatically:', e.message);
        }
      }

      const size = (fs.statSync(winExe).size / 1024 / 1024).toFixed(1);
      console.log(`\n  Built: ${winExe} (${size} MB)`);
      console.log(`  Staged bundle: ${winBundle}/`);
      console.log(`\n  To deploy on Windows:`);
      console.log(`    1. ${process.platform === 'win32' ? `Upload ${path.basename(winZip)} to the GitHub release` : 'Zip the windows-bundle/ folder as ' + path.basename(winZip)}`);
      console.log(`    2. Recipient unzips and double-clicks CommunityCaptioner.exe`);
      console.log(`    3. For SDI injection without a bundled addon: run setup-decklink.bat (downloads the prebuilt addon)\n`);
    }
  }

  // Cleanup intermediate files
  for (const f of ['launcher.cjs', 'server.cjs', 'package.json', 'README-MAC.txt']) {
    const p = path.join(BUILD, f);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  // Remove dist/ and local/ from build dir — they're embedded in the binaries
  for (const d of ['dist', 'local']) {
    const p = path.join(BUILD, d);
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true });
  }

  console.log('\n=== Build complete ===\n');
}

function getTotalSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += getTotalSizeRaw(full);
    } else {
      total += fs.statSync(full).size;
    }
  }
  return (total / 1024 / 1024).toFixed(1) + ' MB';
}

function getTotalSizeRaw(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += getTotalSizeRaw(full);
    } else {
      total += fs.statSync(full).size;
    }
  }
  return total;
}

main().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
