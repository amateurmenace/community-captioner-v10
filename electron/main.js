import { app, BrowserWindow, shell, session } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { fork } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow;
let serverProcess;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    title: "Community Captioner",
    // In prod, public assets move to dist. In dev, they stay in public.
    // Since we copy dist/**/* to the app root, the icon is at ../dist/icon.ico relative to this file.
    icon: path.join(__dirname, '../dist/icon.ico'), 
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
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

app.whenReady().then(() => {
  startServer();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    if (serverProcess) serverProcess.kill();
    app.quit();
  }
});

app.on('before-quit', () => {
  if (serverProcess) serverProcess.kill();
});