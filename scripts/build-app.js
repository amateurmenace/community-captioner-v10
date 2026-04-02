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

  // Move binary into MacOS/
  fs.renameSync(binaryPath, path.join(macosDir, 'CommunityCaptioner'));
  fs.chmodSync(path.join(macosDir, 'CommunityCaptioner'), 0o755);

  // Copy dist/ into Resources/
  const distSrc = path.join(ROOT, 'dist');
  fs.cpSync(distSrc, path.join(resourcesDir, 'dist'), { recursive: true });

  return appDir;
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

  // 4. Copy dist/ into build/ so pkg can snapshot it
  console.log('\n=== Copying dist/ into build/ ===');
  fs.cpSync(path.join(ROOT, 'dist'), path.join(BUILD, 'dist'), { recursive: true });

  // 5. Write pkg config (shared) — dist included as snapshot asset
  const pkgConfigBase = {
    name: 'community-captioner',
    version,
    main: 'launcher.cjs',
    pkg: {
      assets: ['server.cjs', 'dist/**/*'],
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
      `npx @yao-pkg/pkg ${path.join(BUILD, 'launcher.cjs')} ` +
      `--target node20-macos-arm64 ` +
      `--output ${macBin} ` +
      `--config ${path.join(BUILD, 'package.json')}`,
      'pkg → macOS arm64'
    );

    console.log('\n=== Creating .app bundle ===');
    const appDir = buildMacApp(macBin, version);
    const size = getTotalSize(appDir);
    console.log(`\n  Built: ${appDir} (${size})`);
    console.log(`\n  To use on macOS:`);
    console.log(`    1. Double-click "Community Captioner.app"`);
    console.log(`    2. Browser opens automatically to http://localhost:8080`);
    console.log(`    3. Close the terminal window or press Ctrl+C to stop\n`);
  }

  if (buildWin) {
    console.log('\n=== Packaging Windows .exe (pkg) ===');
    const winExe = path.join(BUILD, 'CommunityCaptioner.exe');
    run(
      `npx @yao-pkg/pkg ${path.join(BUILD, 'launcher.cjs')} ` +
      `--target node20-win-x64 ` +
      `--output ${winExe} ` +
      `--config ${path.join(BUILD, 'package.json')}`,
      'pkg → Windows x64'
    );

    if (fs.existsSync(winExe)) {
      const size = (fs.statSync(winExe).size / 1024 / 1024).toFixed(1);
      console.log(`\n  Built: ${winExe} (${size} MB)`);
      console.log(`\n  To deploy on Windows:`);
      console.log(`    1. Copy CommunityCaptioner.exe to the target machine`);
      console.log(`    2. Double-click the .exe — browser opens automatically`);
      console.log(`    3. No Node.js installation required\n`);
    }
  }

  // Cleanup intermediate files
  for (const f of ['launcher.cjs', 'server.cjs', 'package.json']) {
    const p = path.join(BUILD, f);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  // Remove dist/ from build dir — it's embedded in the binaries
  const buildDist = path.join(BUILD, 'dist');
  if (fs.existsSync(buildDist)) fs.rmSync(buildDist, { recursive: true });

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
