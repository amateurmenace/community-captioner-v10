import { app, BrowserWindow, shell, session, ipcMain } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { fork } from 'child_process';
import { createRequire } from 'module';
import { WebSocket } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

let mainWindow;
let serverProcess;

// --- DeckLink Native Addon ---
let decklink = null;
try {
    decklink = require('../native/decklink/build/Release/decklink_addon.node');
    console.log('[DeckLink] Native addon loaded successfully');
} catch (e) {
    console.warn('[DeckLink] Native addon not available:', e.message);
}

// --- CEA-608/708 Encoder ---
let cea608Encoder = null;
let cea708Builder = null;
let captionFrameInterval = null;
let internalWs = null;

async function initCaptionEncoder() {
    try {
        const { Cea608Encoder } = await import('../server/cea708/cea608-encoder.js');
        const { Cea708CdpBuilder } = await import('../server/cea708/cea708-cdp-builder.js');
        cea608Encoder = new Cea608Encoder();
        cea708Builder = new Cea708CdpBuilder();
        console.log('[CEA-708] Encoder initialized');
    } catch (e) {
        console.warn('[CEA-708] Encoder failed to load:', e.message);
    }
}

/**
 * Start the per-frame CDP generation loop.
 * Runs at frame rate and pushes CDPs to the native addon.
 */
function startFrameLoop(frameRate = '29.97') {
    if (captionFrameInterval) return;

    const fpsMap = { '23.98': 23.98, '24': 24, '25': 25, '29.97': 29.97, '30': 30, '59.94': 59.94, '60': 60 };
    const fps = fpsMap[frameRate] || 29.97;
    const intervalMs = 1000.0 / fps;

    captionFrameInterval = setInterval(() => {
        if (!cea608Encoder || !cea708Builder || !decklink) return;

        const pair = cea608Encoder.drainPair();
        const cdp = cea708Builder.buildCDP(pair.cc1, pair.cc2, frameRate);

        try {
            decklink.pushCDP(Buffer.from(cdp));
        } catch (e) {
            // Silently ignore if output stopped between check and push
        }
    }, intervalMs);

    console.log(`[CEA-708] Frame loop started at ${fps}fps (${intervalMs.toFixed(2)}ms interval)`);
}

function stopFrameLoop() {
    if (captionFrameInterval) {
        clearInterval(captionFrameInterval);
        captionFrameInterval = null;
        console.log('[CEA-708] Frame loop stopped');
    }
}

/**
 * Connect to the relay's /cea708 WebSocket as an internal client
 * to receive caption text for encoding.
 */
function connectToRelay() {
    if (internalWs) return;

    const url = 'ws://localhost:8080/cea708-internal';

    // Actually connect to the main relay WS to receive caption messages
    const ws = new WebSocket('ws://localhost:8080');
    internalWs = ws;

    ws.on('open', () => {
        console.log('[CEA-708] Connected to relay as internal client');
        ws.send(JSON.stringify({ type: 'join', sessionId: 'demo', role: 'cea708-encoder' }));
    });

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'caption' && cea608Encoder) {
                const text = (typeof msg.payload === 'string')
                    ? msg.payload
                    : (msg.payload?.text || '');
                if (text) {
                    cea608Encoder.enqueueText(text, !!msg.isFinal);
                }
            } else if (msg.type === 'cea708_clear' && cea608Encoder) {
                cea608Encoder.enqueueClear();
            }
        } catch (e) {}
    });

    ws.on('close', () => {
        internalWs = null;
        // Reconnect after delay
        setTimeout(connectToRelay, 2000);
    });

    ws.on('error', () => {
        ws.close();
    });
}

function disconnectFromRelay() {
    if (internalWs) {
        internalWs.close();
        internalWs = null;
    }
}

// --- IPC Handlers ---
function setupIpcHandlers() {
    if (!decklink) return;

    ipcMain.handle('decklink:enumerate', () => {
        return decklink.enumerateDevices();
    });

    ipcMain.handle('decklink:startOutput', async (event, opts) => {
        const { deviceIndex, displayMode, frameRate } = opts;
        const ok = decklink.startOutput(deviceIndex, displayMode);
        if (ok) {
            if (!cea608Encoder) await initCaptionEncoder();
            startFrameLoop(frameRate || '29.97');
            connectToRelay();
        }
        return ok;
    });

    ipcMain.handle('decklink:startPassthrough', async (event, opts) => {
        const { inputDevice, outputDevice, displayMode, frameRate } = opts;
        const ok = decklink.startPassthrough(inputDevice, outputDevice, displayMode);
        if (ok) {
            if (!cea608Encoder) await initCaptionEncoder();
            startFrameLoop(frameRate || '29.97');
            connectToRelay();
        }
        return ok;
    });

    ipcMain.handle('decklink:stop', () => {
        stopFrameLoop();
        disconnectFromRelay();
        decklink.stopOutput();
        if (cea608Encoder) cea608Encoder.reset();
        if (cea708Builder) cea708Builder.reset();
    });

    ipcMain.handle('decklink:status', () => {
        return decklink.getStatus();
    });

    ipcMain.handle('decklink:pushCDP', (event, buffer) => {
        decklink.pushCDP(Buffer.from(buffer));
    });

    ipcMain.handle('decklink:clearCaptions', () => {
        if (cea608Encoder) {
            cea608Encoder.enqueueClear();
        }
    });
}

// --- Window & Server ---
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    title: "Community Captioner",
    icon: path.join(__dirname, '../dist/icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // Grant permissions for microphone/audio capture automatically
  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowedPermissions = ['media', 'audioCapture', 'notifications'];
    if (allowedPermissions.includes(permission)) {
      callback(true);
    } else {
      callback(false);
    }
  });

  // 1. Wait briefly for server to boot
  // 2. Load localhost (served by relay.js)
  setTimeout(() => {
      mainWindow.loadURL('http://localhost:8080');
  }, 1500);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
}

function startServer() {
  // In production (asar=false), the structure is resources/app/server/relay.js
  const scriptPath = path.join(__dirname, '../server/relay.js');

  console.log(`Starting Relay Server from: ${scriptPath}`);

  serverProcess = fork(scriptPath, [], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc']
  });

  serverProcess.stdout.on('data', (data) => console.log(`[Relay]: ${data}`));
  serverProcess.stderr.on('data', (data) => console.error(`[Relay Error]: ${data}`));
}

app.whenReady().then(async () => {
  startServer();
  await initCaptionEncoder();
  setupIpcHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    stopFrameLoop();
    disconnectFromRelay();
    if (serverProcess) serverProcess.kill();
    app.quit();
  }
});

app.on('before-quit', () => {
  stopFrameLoop();
  disconnectFromRelay();
  if (decklink) {
      try { decklink.stopOutput(); } catch(e) {}
  }
  if (serverProcess) serverProcess.kill();
});
