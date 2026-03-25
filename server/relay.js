import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import localtunnel from 'localtunnel';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);

// CLOUD FIX: Use the environment variable PORT if available, otherwise default to 8080
const PORT = process.env.PORT || 8080;
let publicTunnelUrl = null;
let backupTunnelUrl = null;

// Utility to find Local IP
function getLocalIp() {
    const interfaces = os.networkInterfaces();
    const priority = ['en0', 'eth0', 'wlan0'];
    for (const name of priority) {
        if (interfaces[name]) {
            const ipv4 = interfaces[name].find(i => i.family === 'IPv4' && !i.internal);
            if (ipv4) return ipv4.address;
        }
    }
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

const localIP = getLocalIp();

// Point to the Vite build output (dist)
const distPath = path.join(__dirname, '../dist');
const indexHtmlPath = path.join(distPath, 'index.html');

// Trust proxies (Required for Cloud Run / Heroku / Load Balancers)
app.set('trust proxy', true);

app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});

// New Endpoint: Return the IP config
app.get('/api/ip', (req, res) => {
    // CLOUD FIX: Detect protocol from Load Balancer headers
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.get('host'); // includes domain and port
    const fullUrl = `${protocol}://${host}`;

    // Determine the Public URL:
    // 1. If we have a localtunnel (Dev mode), use that.
    // 2. Otherwise, assume the request host is the public URL (Production/Cloud Run).
    const resolvedPublicUrl = publicTunnelUrl || backupTunnelUrl || fullUrl;

    res.json({
        ip: localIP,
        port: PORT,
        url: fullUrl,
        publicUrl: resolvedPublicUrl,
        cea708: {
            url: `ws://${localIP}:${PORT}/cea708`,
            localUrl: `ws://localhost:${PORT}/cea708`,
            connectedBridges: cea708Clients.size
        }
    });
});

// CEA-708 Bridge Status Endpoint
app.get('/api/cea708', (req, res) => {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.get('host');
    const wsProtocol = protocol === 'https' ? 'wss' : 'ws';
    res.json({
        endpoint: `${wsProtocol}://${host}/cea708`,
        localEndpoint: `ws://localhost:${PORT}/cea708`,
        networkEndpoint: `ws://${localIP}:${PORT}/cea708`,
        connectedBridges: cea708Clients.size,
        status: cea708Clients.size > 0 ? 'active' : 'waiting'
    });
});

if (fs.existsSync(distPath)) {
    // Critical Check: Does index.html exist?
    if (!fs.existsSync(indexHtmlPath)) {
        console.error('\n\x1b[31m%s\x1b[0m', "❌ ERROR: 'dist/index.html' is missing!");
        console.error('\x1b[33m%s\x1b[0m', "👉 You must run 'npm run build' before 'npm start'.\n");
    }

    // console.log(`Serving static files from: ${distPath}`);
    app.use(express.static(distPath));
    
    // Catch-all for SPA routing
    app.get('*', (req, res) => {
        if (fs.existsSync(indexHtmlPath)) {
            res.sendFile(indexHtmlPath);
        } else {
            res.status(500).send('Frontend build not found. Run "npm run build" first.');
        }
    });
} else {
    console.error('\n\x1b[31m%s\x1b[0m', `❌ ERROR: 'dist' folder not found at ${distPath}`);
    console.error('\x1b[33m%s\x1b[0m', "👉 You must run 'npm run build' before 'npm start'.\n");
    
    app.get('/', (req, res) => {
        res.status(500).send('Frontend build not found. Please check deployment logs or run "npm run build" locally.');
    });
}

// --- Main Caption Relay WebSocket ---
const wss = new WebSocketServer({ noServer: true });
const sessions = new Map();

// --- CEA-708 SDI Bridge WebSocket ---
const cea708Wss = new WebSocketServer({ noServer: true });
const cea708Clients = new Set();
let cea708LastInterim = ''; // Track for delta computation (Option A from spec)

// Forward caption data to all connected CEA-708 bridge clients
function forwardToCea708(captionData) {
    if (cea708Clients.size === 0) return;

    let cea708Msg;

    if (captionData.type === 'caption') {
        if (captionData.isFinal) {
            // Final caption — send only new text since last interim, then CR
            const fullText = (typeof captionData.payload === 'string')
                ? captionData.payload
                : (captionData.payload.text || '');
            const newText = (cea708LastInterim && fullText.startsWith(cea708LastInterim))
                ? fullText.slice(cea708LastInterim.length)
                : fullText;
            cea708Msg = JSON.stringify({ text: newText || fullText, isFinal: true });
            cea708LastInterim = ''; // Reset for next utterance
        } else {
            // Interim — send only new characters since last send
            const currentText = (typeof captionData.payload === 'string')
                ? captionData.payload
                : (captionData.payload.text || '');
            const newText = (cea708LastInterim && currentText.startsWith(cea708LastInterim))
                ? currentText.slice(cea708LastInterim.length)
                : currentText;
            if (!newText) return; // No new characters
            cea708Msg = JSON.stringify({ text: newText, isFinal: false });
            cea708LastInterim = currentText;
        }
    } else if (captionData.type === 'cea708_clear') {
        cea708Msg = JSON.stringify({ clear: true });
        cea708LastInterim = '';
    } else {
        return; // Ignore settings and other message types
    }

    for (const client of cea708Clients) {
        if (client.readyState === 1) {
            client.send(cea708Msg);
        }
    }
}

// CEA-708 bridge connections (receive-only clients per spec)
cea708Wss.on('connection', (ws, req) => {
    cea708Clients.add(ws);
    console.log(`[CEA-708] Bridge connected (${cea708Clients.size} active)`);

    ws.on('message', (message) => {
        // Bridge may send control messages (e.g., clear request)
        try {
            const data = JSON.parse(message);
            if (data.clear) {
                cea708LastInterim = '';
            }
        } catch(e) {}
    });

    ws.on('close', () => {
        cea708Clients.delete(ws);
        console.log(`[CEA-708] Bridge disconnected (${cea708Clients.size} active)`);
    });

    ws.on('error', () => {
        cea708Clients.delete(ws);
    });
});

// Main relay connections
wss.on('connection', (ws, req) => {
  let currentSessionId = null;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      if (data.type === 'join') {
        currentSessionId = data.sessionId;
        if (!sessions.has(currentSessionId)) {
          sessions.set(currentSessionId, new Set());
        }
        sessions.get(currentSessionId).add(ws);
      }

      if ((data.type === 'caption' || data.type === 'settings') && currentSessionId && sessions.has(currentSessionId)) {
        const clients = sessions.get(currentSessionId);
        clients.forEach(client => {
          if (client !== ws && client.readyState === 1) {
            client.send(JSON.stringify(data));
          }
        });

        // Forward captions to CEA-708 bridge clients
        if (data.type === 'caption') {
            forwardToCea708(data);
        }
      }

      // Handle explicit CEA-708 clear command from frontend
      if (data.type === 'cea708_clear') {
          forwardToCea708(data);
      }
    } catch (e) {
      console.error("Parse error", e);
    }
  });

  ws.on('close', () => {
    if (currentSessionId && sessions.has(currentSessionId)) {
      sessions.get(currentSessionId).delete(ws);
      if (sessions.get(currentSessionId).size === 0) {
        sessions.delete(currentSessionId);
      }
    }
  });
});

// Route WebSocket upgrades by URL path
server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;

    if (pathname === '/cea708') {
        cea708Wss.handleUpgrade(request, socket, head, (ws) => {
            cea708Wss.emit('connection', ws, request);
        });
    } else {
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
        });
    }
});

// Add error handling for port conflicts
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error('\n\x1b[31m%s\x1b[0m', '-------------------------------------------------------');
    console.error('\x1b[31m%s\x1b[0m', `❌ ERROR: Port ${PORT} is already in use.`);
    console.error('\x1b[33m%s\x1b[0m', `👉 Action Required: Stop the other process or run:`);
    console.error('\x1b[37m%s\x1b[0m', `   lsof -ti :${PORT} | xargs kill -9`);
    console.error('\x1b[31m%s\x1b[0m', '-------------------------------------------------------');
    process.exit(1);
  } else {
    console.error('Server error:', e);
  }
});

server.listen(PORT, '0.0.0.0', async () => {
  const isProd = process.env.NODE_ENV === 'production';

  console.log('\n' + '\x1b[32m%s\x1b[0m', '='.repeat(50));
  console.log('\x1b[32m%s\x1b[0m', `🚀 Server started successfully!`);
  console.log('\x1b[32m%s\x1b[0m', '='.repeat(50));
  console.log(`\n📍 Local:   \x1b[36mhttp://localhost:${PORT}\x1b[0m`);
  console.log(`📍 Network: \x1b[36mhttp://${localIP}:${PORT}\x1b[0m`);
  console.log(`📍 CEA-708: \x1b[36mws://${localIP}:${PORT}/cea708\x1b[0m (SDI Bridge Endpoint)`);
  
  // CLOUD FIX: Only run localtunnel if NOT in production cloud environment
  if (!isProd) {
      // 1. Primary Tunnel (LocalTunnel)
      try {
          console.log("\n[Dev] Initializing Primary Tunnel...");
          // FIX: Explicitly bind to 127.0.0.1 to avoid 503s on some networks
          const tunnel = await localtunnel({ port: PORT, local_host: '127.0.0.1' });
          publicTunnelUrl = tunnel.url;
          console.log(`📍 Primary: \x1b[35m${publicTunnelUrl}\x1b[0m`);

          // Fetch Password for LocalTunnel
          try {
              const response = await fetch('https://api.ipify.org?format=json');
              const data = await response.json();
              console.log(`   └─ Password: \x1b[33m${data.ip}\x1b[0m (If asked)`);
          } catch(e) {}

      } catch (err) {
          console.warn("[Dev] Primary tunnel failed:", err.message);
      }

      // 2. Backup Tunnel (SSH to localhost.run) - No password required, usually more stable
      try {
          console.log("\n[Dev] Initializing Backup Tunnel (localhost.run)...");
          const ssh = spawn('ssh', [
              '-R', `80:localhost:${PORT}`, 
              'nokey@localhost.run',
              '-o', 'StrictHostKeyChecking=no' // Prevent interactive prompt
          ]);
          
          const handleOutput = (data) => {
              const text = data.toString();
              // localhost.run outputs "Connect to your tunnel at https://..."
              const urlMatch = text.match(/https:\/\/[^\s]+/);
              if (urlMatch) {
                   backupTunnelUrl = urlMatch[0];
                   console.log(`📍 Backup:  \x1b[36m${backupTunnelUrl}\x1b[0m (No password needed)`);
                   console.log(`   └─ Use this if Primary fails (503 error)`);
              }
          };

          ssh.stdout.on('data', handleOutput);
          ssh.stderr.on('data', handleOutput);

          // Cleanup SSH process on exit
          const cleanup = () => { try { ssh.kill(); } catch(e){} };
          process.on('exit', cleanup);
          process.on('SIGINT', () => { cleanup(); process.exit(); });
          
      } catch (e) {
          console.log("   (Backup tunnel skipped: SSH not found)");
      }
      
      console.log(`\n⚠️  NOTE: You are running in 'production preview' mode.`);
      console.log(`   For hot-reloading development, use: \x1b[33mnpm run dev\x1b[0m`);
  }
  
  console.log(`\n(Press Ctrl+C to stop)`);
});