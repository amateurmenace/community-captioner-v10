import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import localtunnel from 'localtunnel';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);

// CLOUD FIX: Use the environment variable PORT if available, otherwise default to 8080
const PORT = process.env.PORT || 8080;
let publicTunnelUrl = null;

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
    const resolvedPublicUrl = publicTunnelUrl || fullUrl;

    res.json({ 
        ip: localIP, 
        port: PORT,
        url: fullUrl,
        publicUrl: resolvedPublicUrl 
    });
});

if (fs.existsSync(distPath)) {
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
    });
} else {
    app.get('/', (req, res) => {
        res.send('Frontend build not found. Please run "npm run build"');
    });
}

const wss = new WebSocketServer({ server });
const sessions = new Map(); 

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

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`✅ Server starting on port ${PORT}`);
  
  // CLOUD FIX: Only run localtunnel if NOT in production cloud environment
  if (process.env.NODE_ENV !== 'production') {
      try {
          console.log("[Dev] Initializing Public Tunnel...");
          const tunnel = await localtunnel({ port: PORT });
          publicTunnelUrl = tunnel.url;
          console.log(`> Tunnel: ${publicTunnelUrl}`);
      } catch (err) {
          console.warn("[Dev] Failed to start tunnel:", err.message);
      }
  }
});