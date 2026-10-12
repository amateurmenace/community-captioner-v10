import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import { install as installCloudflared } from 'cloudflared';
import { spawn } from 'child_process';
import { polish, localPolish, summarize, truncateAtWord, setApiKey as setPolisherApiKey, toggleGemini as togglePolisherGemini, getStatus as getPolisherStatus } from './caption-polisher.js';
import { feedText as learnerFeedText, setApiKey as setLearnerApiKey, setEnabled as setLearnerEnabled, getSuggestions, acceptSuggestion, dismissSuggestion, setDictionary as setLearnerDictionary, getDictionary as getLearnerDictionary, extractDictionary, generateMishearings, getStatus as getLearnerStatus } from './context-learner.js';
import { translateCaption, setApiKey as setTranslationApiKey, getSupportedLanguages, getCacheStats as getTranslationStats, translationAvailable } from './translation-service.js';
import { getSystemMetrics } from './system-metrics.js';
import { appendFileSync as fsAppendFileSync, statSync as fsStatSync, truncateSync as fsTruncateSync, readFileSync as fsReadFileSync } from 'fs';

// ---------------------------------------------------------------------------
// Relay log: everything the relay prints also goes to a ring buffer (for
// GET /api/logs and the Diagnostics report) and to DATA_DIR/logs/relay.log
// (capped at 5 MB) so there is something to read after the Terminal is gone.
// ---------------------------------------------------------------------------
const RELAY_LOG_DIR = join(LOCAL_DIR, '..', 'logs');
const RELAY_LOG_FILE = join(RELAY_LOG_DIR, 'relay.log');
const relayLogRing = [];
const RELAY_LOG_MAX = 500;
function relayLogWrite(level, args) {
    let text;
    try { text = args.map(a => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' '); } catch { text = String(args); }
    text = text.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+$/, '');
    if (!text.trim()) return;
    const line = `${new Date().toISOString()} ${level.padEnd(5)} ${text}`;
    relayLogRing.push(line);
    if (relayLogRing.length > RELAY_LOG_MAX) relayLogRing.splice(0, relayLogRing.length - RELAY_LOG_MAX);
    try {
        fsMkdirSync(RELAY_LOG_DIR, { recursive: true });
        try { if (fsStatSync(RELAY_LOG_FILE).size > 5 * 1024 * 1024) fsTruncateSync(RELAY_LOG_FILE, 0); } catch {}
        fsAppendFileSync(RELAY_LOG_FILE, line + '\n');
    } catch {}
}
for (const level of ['log', 'info', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => { relayLogWrite(level === 'log' ? 'info' : level, args); orig(...args); };
}
process.on('uncaughtException', (e) => { relayLogWrite('error', [`uncaughtException: ${e?.stack || e}`]); });
process.on('unhandledRejection', (e) => { relayLogWrite('error', [`unhandledRejection: ${e?.stack || e}`]); });

import { fetchPage, htmlToText, extractPdfText, extractUploadedText, pdfSupportAvailable, discoverLinks, locateMunicipalitySources, researchMunicipality, extractDictionaryFromUrl, itemsToEntries, getResearchGroups, GEMINI_TEXT_MODEL } from './context-sources.js';
import { listProfiles, getProfile, saveProfile, deleteProfile } from './profiles.js';
import { buildCorrectionIndex, applyCorrections } from '../shared/corrections.js';
import { probeSystem, invalidateProbe, startWhisper, stopWhisper, getWhisperStatus, subscribeLogs, readScript, readHello, ollamaModels, ollamaPull, ollamaStart, WHISPER_MODELS, OLLAMA_MODELS, ensureWhisper, transcribeFileWithServer, downloadYoutubeAudio, LOCAL_DIR } from './local-stack.js';
import { getBrainConfig, setBrainConfig, brainActive, extractEntriesWithOllama, extractItemsWithOllama, testOllamaExtraction } from './local-llm.js';
import { locateMunicipalityLocally, researchMunicipalityLocally } from './local-wizard.js';
import { createRequire as _pkgRequire } from 'module';
// Version: injected by esbuild in packaged builds (package.json isn't in the pkg snapshot), read from disk in dev
const APP_VERSION = process.env.CC_APP_VERSION || (() => { try { return _pkgRequire(import.meta.url)('../package.json').version; } catch { return 'dev'; } })();
// Static import so esbuild bundles multer into the standalone binary. A runtime
// createRequire('multer') cannot be resolved inside the pkg snapshot, which left
// file uploads silently disabled in every packaged .app/.exe build.
import multer from 'multer';
import { join, extname } from 'path';
import { statSync, unlinkSync, mkdirSync as fsMkdirSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
const server = createServer(app);

// CLOUD FIX: Use the environment variable PORT if available, otherwise default to 8080
let PORT = process.env.PORT || 8080;
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
// In pkg builds, dist/ is next to the executable, not relative to __dirname
const baseDir = typeof process.pkg !== 'undefined'
  ? path.dirname(process.execPath)
  : path.join(__dirname, '..');
const distPath = process.env.DIST_PATH || path.join(baseDir, 'dist');
const indexHtmlPath = path.join(distPath, 'index.html');

// Trust proxies (Required for Cloud Run / Heroku / Load Balancers)
app.set('trust proxy', true);

app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, X-Api-Key");
    res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    if (req.method === 'OPTIONS') return res.sendStatus(200);
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

// --- DeckLink Native Addon (Server-Side) ---
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

let decklink = null;
let cea608Encoder = null;
let dtvccEncoder = null;
let cea708Builder = null;
let captionFrameInterval = null;
let deckLinkRunning = false;
let deckLinkMode = null; // 'standalone' | 'passthrough'
let deckLinkFrameRate = '29.97';

// Caption encoding configuration (updated via /api/caption/config)
let captionConfig = {
    encodingMode: 'cea608',        // 'cea608' | 'dtvcc'
    captionStrategy: 'truncate',   // 'truncate' | 'summarize' | 'verbatim'
    maxCharsPerLine: 64,           // 32-128
    rollupRows: 2,                 // 2 | 3
    polishEnabled: true,           // auto-punctuate, capitalize, fix contractions
    profanityFilter: false,        // bleep profanity with ***
};

// YouTube Live caption ingestion. When the user enables "Closed Captions:
// Caption ingestion URL" in YouTube Studio for a live stream, YouTube gives
// them an upload.youtube.com URL with a cid query parameter. POSTing
// timecoded caption text to it overlays captions on the broadcast — this
// bypasses the RTMP encoder entirely, which matters because the Blackmagic
// Web Presenter HD/4K does NOT forward SDI VANC captions into the H.264 SEI
// of its RTMP output. The ingestion-URL path is the only working way to get
// captions on YouTube when streaming through a Web Presenter.
let youtubeCaptionState = {
    url: null,            // full upload.youtube.com URL including ?cid=...
    sessionStartMs: null, // wall-clock when URL was set; used to compute relative timecodes
    sequence: 1,          // monotonic counter incremented per POST (YT requires &seq= to increase)
    lastPostMs: 0,        // throttle stats
    lastError: null,
};

function formatYouTubeTimecode(ms) {
    // YouTube accepts "HH:MM:SS.mmm" relative to stream start.
    const totalMs = Math.max(0, ms);
    const hours = Math.floor(totalMs / 3600000);
    const minutes = Math.floor((totalMs % 3600000) / 60000);
    const seconds = Math.floor((totalMs % 60000) / 1000);
    const millis = totalMs % 1000;
    const pad = (n, w = 2) => n.toString().padStart(w, '0');
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(millis, 3)}`;
}

async function forwardToYouTube(text) {
    if (!youtubeCaptionState.url || !text) return;
    try {
        const now = Date.now();
        if (!youtubeCaptionState.sessionStartMs) youtubeCaptionState.sessionStartMs = now;
        const offset = now - youtubeCaptionState.sessionStartMs;
        const seq = youtubeCaptionState.sequence++;
        // Build URL with &seq= appended (replace if already present)
        const baseUrl = youtubeCaptionState.url.replace(/[?&]seq=\d+/, '');
        const sep = baseUrl.includes('?') ? '&' : '?';
        const url = `${baseUrl}${sep}seq=${seq}`;
        const body = `${formatYouTubeTimecode(offset)}\n${text}\n`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2000);
        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body,
            signal: controller.signal,
        });
        clearTimeout(timer);
        if (!resp.ok) {
            youtubeCaptionState.lastError = `HTTP ${resp.status}`;
            console.warn(`[YouTube CC] POST failed: ${resp.status} ${resp.statusText}`);
        } else {
            youtubeCaptionState.lastError = null;
            youtubeCaptionState.lastPostMs = now;
        }
    } catch (e) {
        youtubeCaptionState.lastError = e.message;
        console.warn(`[YouTube CC] POST error: ${e.message}`);
    }
}

// Caption history for SRT export (stores all final captions with timestamps)
let captionHistory = [];
let captionSessionStart = null;

function recordCaption(text) {
    if (!text || typeof text !== 'string') return;
    if (!captionSessionStart) captionSessionStart = Date.now();
    captionHistory.push({
        text: text.trim(),
        timestamp: Date.now(),
        offset: Date.now() - captionSessionStart,
    });
}

function generateSRT() {
    return captionHistory.map((c, i) => {
        const start = formatSrtTime(c.offset);
        const end = formatSrtTime(c.offset + 3000); // 3 second display duration
        return `${i + 1}\n${start} --> ${end}\n${c.text}\n`;
    }).join('\n');
}

function formatSrtTime(ms) {
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const msRem = ms % 1000;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(msRem).padStart(3,'0')}`;
}

// Caption metrics for operator monitoring
let captionMetrics = {
    totalEncoded: 0,
    totalDropped: 0,
    totalSummarized: 0,
    avgLatencyMs: 0,
    _latencySum: 0,
    _latencyCount: 0,
    lastQueueDepth: 0,
    startTime: Date.now(),
};

// Load Gemini API key — check env var, .env.local, then built-in default.
// Tracks the source so the UI can show users where the active key came from.
let geminiKeySource = 'none'; // 'env' | 'env_local' | 'builtin' | 'runtime' | 'none'
let geminiKeyActive = '';

function loadGeminiApiKey() {
    // 1. Environment variable (highest priority)
    if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'PLACEHOLDER_API_KEY') {
        geminiKeySource = 'env';
        return process.env.GEMINI_API_KEY.trim();
    }
    // 2. .env.local file — project root / next to the executable (Windows bundle),
    //    the macOS .app Resources folder (parent of DIST_PATH), or the process cwd
    const candidatePaths = [
        path.join(baseDir, '.env.local'),
        path.join(path.dirname(distPath), '.env.local'),
        path.join(process.cwd(), '.env.local'),
    ];
    for (const envPath of candidatePaths) {
        try {
            if (fs.existsSync(envPath)) {
                const envContent = fs.readFileSync(envPath, 'utf-8');
                const match = envContent.match(/GEMINI_API_KEY\s*=\s*(.+)/);
                if (match && match[1]) {
                    const trimmed = match[1].trim().replace(/^["']|["']$/g, '');
                    if (trimmed && trimmed !== 'PLACEHOLDER_API_KEY') {
                        geminiKeySource = 'env_local';
                        return trimmed;
                    }
                }
            }
        } catch (e) {}
    }
    // 3. No key found — surface this in the UI rather than embedding a key
    //    in source. Distributed binaries ship with .env.local next to them.
    geminiKeySource = 'none';
    return '';
}

geminiKeyActive = loadGeminiApiKey();
if (geminiKeyActive) {
    setPolisherApiKey(geminiKeyActive);
    setLearnerApiKey(geminiKeyActive);
    setTranslationApiKey(geminiKeyActive);
    console.log(`[Config] Gemini API key loaded (source: ${geminiKeySource}, length: ${geminiKeyActive.length})`);
} else {
    console.log(`[Config] No Gemini API key found — set one in the Context Engine UI or place a .env.local next to the executable.`);
}

// Update the in-memory key + source when a client provides one at runtime.
function applyRuntimeApiKey(key) {
    if (!key || typeof key !== 'string') return false;
    const trimmed = key.trim();
    if (trimmed.length < 10) return false;
    geminiKeyActive = trimmed;
    geminiKeySource = 'runtime';
    setPolisherApiKey(trimmed);
    setLearnerApiKey(trimmed);
    setTranslationApiKey(trimmed);
    return true;
}

function maskKey(k) {
    if (!k) return '';
    if (k.length <= 8) return '****';
    return k.slice(0, 4) + '…' + k.slice(-4);
}

// Profanity word list (word-boundary matched — won't hit "assemble", "class", etc.)
const PROFANITY_WORDS = [
    'damn', 'damned', 'dammit', 'hell', 'crap', 'crappy',
    'shit', 'shitty', 'bullshit',
    'fuck', 'fucking', 'fucked', 'fucker',
    'bitch', 'bitchy', 'bitches',
    'ass', 'asshole', 'assholes',
    'bastard', 'bastards',
    'goddamn', 'goddammit',
    'piss', 'pissed',
];
function filterProfanity(text) {
    const pattern = new RegExp(`\\b(${PROFANITY_WORDS.join('|')})\\b`, 'gi');
    return text.replace(pattern, (match) => '*'.repeat(match.length));
}

try {
    decklink = require('../native/decklink/build/Release/decklink_addon.node');
    console.log('[DeckLink] Native addon loaded in relay server');
} catch (e) {
    // Fallback: look for addon next to the executable (standalone builds)
    try {
        const addonPath = path.join(path.dirname(process.execPath), 'decklink_addon.node');
        decklink = require(addonPath);
        console.log('[DeckLink] Native addon loaded from', addonPath);
    } catch (e2) {
        console.warn('[DeckLink] Native addon not available:', e.message);
    }
}

async function initCaptionEncoder() {
    if (cea608Encoder) return;
    try {
        const { Cea608Encoder } = await import('./cea708/cea608-encoder.js');
        const { DtvccEncoder } = await import('./cea708/dtvcc-encoder.js');
        const { Cea708CdpBuilder } = await import('./cea708/cea708-cdp-builder.js');
        cea608Encoder = new Cea608Encoder();
        dtvccEncoder = new DtvccEncoder();
        cea708Builder = new Cea708CdpBuilder();
        console.log('[CEA-708] Encoders initialized (CEA-608 + DTVCC)');
    } catch (e) {
        console.warn('[CEA-708] Encoder init failed:', e.message);
    }
}

function startFrameLoop(frameRate = '29.97') {
    if (captionFrameInterval) return;
    const fpsMap = { '23.98': 23.98, '24': 24, '25': 25, '29.97': 29.97, '30': 30, '59.94': 59.94, '60': 60 };
    const fps = fpsMap[frameRate] || 29.97;
    const intervalMs = 1000.0 / fps;

    let debugCounter = 0;
    let activeFrames = 0;
    captionFrameInterval = setInterval(() => {
        if (!cea708Builder || !decklink) return;

        let cdp;
        let isActive = false;

        if (captionConfig.encodingMode === 'dtvcc' && dtvccEncoder) {
            // DTVCC mode: drain both encoders — DTVCC for modern decoders,
            // CEA-608 in Field 1 for backward compatibility with older decoders
            const dtvccData = dtvccEncoder.drainFrame(36);
            const pair = cea608Encoder ? cea608Encoder.drainPair() : { cc1: 0x80, cc2: 0x80 };
            cdp = cea708Builder.buildCDP_DTVCC(dtvccData, frameRate, pair.cc1, pair.cc2);
            isActive = !!dtvccData || (pair.cc1 !== 0x80 || pair.cc2 !== 0x80);
        } else if (cea608Encoder) {
            // CEA-608 mode: drain one CC pair per frame
            const pair = cea608Encoder.drainPair();
            cdp = cea708Builder.buildCDP(pair.cc1, pair.cc2, frameRate);
            isActive = (pair.cc1 !== 0x80 || pair.cc2 !== 0x80);
        } else {
            return;
        }

        if (isActive) activeFrames++;
        try { decklink.pushCDP(Buffer.from(cdp)); } catch (e) {}
        debugCounter++;
        if (debugCounter % (Math.round(fps) * 5) === 0) {
            const qLen = captionConfig.encodingMode === 'dtvcc'
                ? (dtvccEncoder?.queueLength || 0)
                : (cea608Encoder?.queueLength || 0);
            console.log(`[CEA-708 Loop] ${debugCounter} frames, ${activeFrames} active, queue=${qLen}, mode=${captionConfig.encodingMode}`);
            activeFrames = 0;
        }
    }, intervalMs);

    console.log(`[CEA-708] Frame loop started at ${fps}fps, mode=${captionConfig.encodingMode}`);
}

function stopFrameLoop() {
    if (captionFrameInterval) {
        clearInterval(captionFrameInterval);
        captionFrameInterval = null;
        console.log('[CEA-708] Frame loop stopped');
    }
}

// Feed caption text into the active encoder based on captionConfig.
function feedCaptionToEncoder(captionData) {
    if (!deckLinkRunning) return;

    const encoder = captionConfig.encodingMode === 'dtvcc' ? dtvccEncoder : cea608Encoder;
    if (!encoder) return;

    if (captionData.type === 'caption') {
        if (!captionData.isFinal) return;

        const text = (typeof captionData.payload === 'string')
            ? captionData.payload
            : (captionData.payload?.text || '');
        if (!text) return;

        // Backlog protection
        const maxBacklog = captionConfig.encodingMode === 'dtvcc' ? 400 : 120;
        if (encoder.queueLength > maxBacklog) {
            console.log(`[CEA-708 DROP] Queue too deep (${encoder.queueLength}), skipping`);
            captionMetrics.totalDropped++;
            return;
        }

        // Apply strategy
        const strategy = captionConfig.captionStrategy;
        const maxChars = captionConfig.maxCharsPerLine;
        const startMs = Date.now();

        (async () => {
            let processed = text.trim();

            // Profanity filter
            if (captionConfig.profanityFilter) {
                processed = filterProfanity(processed);
            }

            if (strategy === 'summarize') {
                processed = await summarize(processed, maxChars);
                captionMetrics.totalSummarized++;
            } else if (strategy === 'truncate') {
                if (captionConfig.polishEnabled) {
                    processed = await polish(processed);
                }
                processed = truncateAtWord(processed, maxChars);
            } else {
                // verbatim
                if (captionConfig.polishEnabled) {
                    processed = await polish(processed);
                }
            }

            // Track metrics
            const latency = Date.now() - startMs;
            captionMetrics._latencySum += latency;
            captionMetrics._latencyCount++;
            captionMetrics.totalEncoded++;

            if (processed) {
                // In DTVCC mode, feed BOTH encoders for backward compatibility
                if (captionConfig.encodingMode === 'dtvcc') {
                    if (dtvccEncoder) dtvccEncoder.enqueueText(processed);
                    if (cea608Encoder) cea608Encoder.enqueueText(truncateAtWord(processed, captionConfig.maxCharsPerLine));
                } else {
                    if (cea608Encoder) cea608Encoder.enqueueText(processed);
                }
                console.log(`[CEA-708 ENCODE] [${captionConfig.encodingMode}/${strategy}] "${processed.slice(0,80)}"`);
            }
        })();
    } else if (captionData.type === 'cea708_clear') {
        if (cea608Encoder) cea608Encoder.enqueueClear();
        if (dtvccEncoder) dtvccEncoder.enqueueClear();
    }
}

// --- DeckLink REST API ---
app.get('/api/decklink/devices', (req, res) => {
    // isDesktopApp = running from standalone exe/app (not a cloud deploy)
    const isDesktopApp = !!process.env.DIST_PATH || typeof process.pkg !== 'undefined';
    if (!decklink) {
        return res.json({ available: false, isDesktopApp, devices: [], error: 'DeckLink addon not loaded. Place decklink_addon.node next to the executable.' });
    }
    try {
        const raw = decklink.enumerateDevices();
        res.json({ available: true, isDesktopApp, devices: raw });
    } catch (e) {
        res.json({ available: false, isDesktopApp, devices: [], error: e.message });
    }
});

app.get('/api/decklink/status', (req, res) => {
    if (!decklink) {
        return res.json({ available: false, running: false });
    }
    try {
        const status = decklink.getStatus();
        res.json({
            available: true,
            running: deckLinkRunning,
            mode: deckLinkMode,
            frameRate: deckLinkFrameRate,
            ...status
        });
    } catch (e) {
        res.json({ available: true, running: deckLinkRunning, error: e.message });
    }
});

app.post('/api/decklink/start', async (req, res) => {
    if (!decklink) {
        return res.status(400).json({ ok: false, error: 'DeckLink addon not loaded' });
    }
    const { mode, deviceIndex, inputDevice, outputDevice, displayMode, frameRate } = req.body;

    console.log('[DeckLink API] Start request:', JSON.stringify(req.body));

    // Stop any existing output first
    try {
        if (deckLinkRunning) {
            console.log('[DeckLink API] Stopping existing output...');
            stopFrameLoop();
            decklink.stopOutput();
            deckLinkRunning = false;
            if (cea608Encoder) cea608Encoder.reset();
            if (dtvccEncoder) dtvccEncoder.reset();
            if (cea708Builder) cea708Builder.reset();
        }
    } catch (e) {
        console.warn('[DeckLink API] Stop during restart failed:', e.message);
    }

    try {
        await initCaptionEncoder();
        let ok = false;
        if (mode === 'passthrough') {
            const inDev = inputDevice ?? 0;
            const outDev = outputDevice ?? deviceIndex ?? 0;
            const dm = displayMode ?? 0;
            console.log(`[DeckLink API] startPassthrough(in=${inDev}, out=${outDev}, mode=${dm})`);
            ok = decklink.startPassthrough(inDev, outDev, dm);
            deckLinkMode = 'passthrough';
        } else {
            const devIdx = deviceIndex ?? 0;
            const dm = displayMode ?? 0;
            console.log(`[DeckLink API] startOutput(device=${devIdx}, mode=${dm})`);
            ok = decklink.startOutput(devIdx, dm);
            deckLinkMode = 'standalone';
        }
        console.log(`[DeckLink API] Result: ${ok ? 'SUCCESS' : 'FAILED'}`);
        if (ok) {
            deckLinkRunning = true;
            deckLinkFrameRate = frameRate || '29.97';
            startFrameLoop(deckLinkFrameRate);
            res.json({ ok, mode: deckLinkMode, frameRate: deckLinkFrameRate });
        } else {
            res.json({ ok: false, error: 'EnableVideoOutput failed — device may be in use by another application (e.g. ATEM Software Control, DaVinci Resolve). Try a different DeckLink sub-device.' });
        }
    } catch (e) {
        console.error('[DeckLink API] Exception:', e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
});

app.post('/api/decklink/stop', (req, res) => {
    if (!decklink) {
        return res.status(400).json({ ok: false, error: 'DeckLink addon not loaded' });
    }
    try {
        stopFrameLoop();
        decklink.stopOutput();
        deckLinkRunning = false;
        deckLinkMode = null;
        if (cea608Encoder) cea608Encoder.reset();
        if (cea708Builder) cea708Builder.reset();
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// --- NDI Source Discovery ---
app.get('/api/ndi/sources', (req, res) => {
    if (!decklink || !decklink.findNdiSources) {
        return res.json({ available: false, sources: [], error: 'NDI not available in addon' });
    }
    try {
        const timeout = parseInt(req.query.timeout) || 2000;
        const maxSources = parseInt(req.query.max) || 8;
        const sources = decklink.findNdiSources(timeout).slice(0, maxSources);
        res.json({ available: true, sources });
    } catch (e) {
        res.json({ available: false, sources: [], error: e.message });
    }
});

// --- NDI→SDI Passthrough Start ---
app.post('/api/ndi/start', async (req, res) => {
    if (!decklink || !decklink.startNdiPassthrough) {
        return res.status(400).json({ ok: false, error: 'NDI passthrough not available in addon' });
    }
    const { ndiSource, outputDevice, displayMode, frameRate } = req.body;

    console.log('[NDI→SDI API] Start request:', JSON.stringify(req.body));

    // Stop any existing output first
    try {
        if (deckLinkRunning) {
            console.log('[NDI→SDI API] Stopping existing output...');
            stopFrameLoop();
            decklink.stopOutput();
            deckLinkRunning = false;
            if (cea608Encoder) cea608Encoder.reset();
            if (dtvccEncoder) dtvccEncoder.reset();
            if (cea708Builder) cea708Builder.reset();
        }
    } catch (e) {
        console.warn('[NDI→SDI API] Stop during restart failed:', e.message);
    }

    try {
        await initCaptionEncoder();
        const outDev = outputDevice ?? 0;
        const dm = displayMode ?? 0;
        console.log(`[NDI→SDI API] startNdiPassthrough("${ndiSource}", out=${outDev}, mode=${dm})`);

        const ok = decklink.startNdiPassthrough(ndiSource, outDev, dm);
        console.log(`[NDI→SDI API] Result: ${ok ? 'SUCCESS' : 'FAILED'}`);

        if (ok) {
            deckLinkRunning = true;
            deckLinkMode = 'ndi_passthrough';
            deckLinkFrameRate = frameRate || '29.97';
            startFrameLoop(deckLinkFrameRate);
            res.json({ ok: true, mode: 'ndi_passthrough' });
        } else {
            res.json({ ok: false, error: 'Failed to start NDI→SDI passthrough. Check that the NDI source exists and the DeckLink device is not in use.' });
        }
    } catch (e) {
        console.error('[NDI→SDI API] Exception:', e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
});

app.post('/api/decklink/clear', (req, res) => {
    if (cea608Encoder) {
        cea608Encoder.enqueueClear();
        res.json({ ok: true });
    } else {
        res.status(400).json({ ok: false, error: 'Encoder not initialized' });
    }
});

// --- Caption Injection Mode ---
// Unified entry point: the UI describes the source kind and the server
// routes to the right native handler (DeckLink passthrough, NDI passthrough,
// or standalone). The whole point of this mode is to take a live video
// source and embed CEA-608/708 captions in the outgoing SDI so a downstream
// web presenter (Wowza, Resi, Streamlabs, etc.) can pass them through to
// YouTube as broadcast captions.
//
// Body: {
//   sourceKind: 'sdi' | 'ndi' | 'standalone',
//   inputDevice?: number,   // for sdi
//   ndiSource?: string,     // for ndi
//   outputDevice: number,
//   displayMode: number,
//   frameRate?: string,
//   encodingMode?: 'cea608' | 'dtvcc',
// }
app.post('/api/inject/start', async (req, res) => {
    if (!decklink) {
        return res.status(400).json({ ok: false, error: 'DeckLink addon not loaded — install Blackmagic Desktop Video and place decklink_addon.node next to the executable.' });
    }
    const {
        sourceKind = 'sdi',
        inputDevice = 0,
        ndiSource,
        outputDevice = 0,
        displayMode = 0,
        frameRate = '29.97',
        encodingMode,
    } = req.body || {};

    console.log('[Inject] Start:', JSON.stringify(req.body));

    if (encodingMode && ['cea608', 'dtvcc'].includes(encodingMode)) {
        captionConfig.encodingMode = encodingMode;
    }

    try {
        if (deckLinkRunning) {
            stopFrameLoop();
            decklink.stopOutput();
            deckLinkRunning = false;
            if (cea608Encoder) cea608Encoder.reset();
            if (dtvccEncoder) dtvccEncoder.reset();
            if (cea708Builder) cea708Builder.reset();
        }
    } catch (e) {
        console.warn('[Inject] Stop during restart failed:', e.message);
    }

    try {
        await initCaptionEncoder();
        let ok = false;
        let mode = '';

        if (sourceKind === 'ndi') {
            if (!decklink.startNdiPassthrough) {
                return res.status(400).json({ ok: false, error: 'NDI passthrough not built into this addon. Use SDI input instead, or rebuild the native addon with NDI SDK.' });
            }
            if (!ndiSource) {
                return res.status(400).json({ ok: false, error: 'ndiSource required for NDI mode' });
            }
            ok = decklink.startNdiPassthrough(ndiSource, outputDevice, displayMode);
            mode = 'inject_ndi';
        } else if (sourceKind === 'standalone') {
            // Black frames + captions — useful when the video pipeline is elsewhere
            // and you want captions on a dedicated SDI feed for the presenter.
            ok = decklink.startOutput(outputDevice, displayMode);
            mode = 'inject_standalone';
        } else {
            // SDI input → SDI output + captions (the canonical injection mode)
            ok = decklink.startPassthrough(inputDevice, outputDevice, displayMode);
            mode = 'inject_sdi';
        }

        if (!ok) {
            return res.json({ ok: false, error: 'Failed to start output. The DeckLink port may be in use by another app (ATEM Software, OBS, Resolve).' });
        }

        deckLinkRunning = true;
        deckLinkMode = mode;
        deckLinkFrameRate = frameRate;
        startFrameLoop(deckLinkFrameRate);

        res.json({
            ok: true,
            mode,
            sourceKind,
            encodingMode: captionConfig.encodingMode,
            frameRate: deckLinkFrameRate,
        });
    } catch (e) {
        console.error('[Inject] Exception:', e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
});

app.post('/api/inject/stop', (req, res) => {
    if (!decklink) return res.status(400).json({ ok: false, error: 'DeckLink addon not loaded' });
    try {
        stopFrameLoop();
        decklink.stopOutput();
        deckLinkRunning = false;
        deckLinkMode = null;
        if (cea608Encoder) cea608Encoder.reset();
        if (dtvccEncoder) dtvccEncoder.reset();
        if (cea708Builder) cea708Builder.reset();
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

app.get('/api/inject/status', (req, res) => {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.get('host');
    const presenterUrl = publicTunnelUrl || backupTunnelUrl || `${protocol}://${host}`;
    let nativeStatus = { running: false, mode: 'stopped', framesOutput: 0, droppedFrames: 0 };
    try { if (decklink) nativeStatus = decklink.getStatus(); } catch {}

    res.json({
        running: deckLinkRunning && /^inject_/.test(deckLinkMode || ''),
        mode: deckLinkMode,
        frameRate: deckLinkFrameRate,
        encodingMode: captionConfig.encodingMode,
        framesOutput: nativeStatus.framesOutput || 0,
        droppedFrames: nativeStatus.droppedFrames || 0,
        encoderQueueDepth: (captionConfig.encodingMode === 'dtvcc' ? dtvccEncoder?.queueLength : cea608Encoder?.queueLength) || 0,
        cea708BridgeClients: cea708Clients.size,
        presenterUrl: `${presenterUrl}/?view=audience&session=demo`,
        addonLoaded: !!decklink,
        ndiAvailable: !!(decklink && decklink.startNdiPassthrough),
        ndiRuntime: decklink && typeof decklink.ndiRuntime === 'string' ? decklink.ndiRuntime : null,
    });
});

// Direct caption push into the encoder (so the injection panel can send
// captions without going through the main session WebSocket).
// Server-side correction index — rebuilt whenever the mirrored dictionary changes.
// Captions from the Dashboard arrive already corrected; this covers captions
// injected over REST from other tools.
let correctionIndex = buildCorrectionIndex(getLearnerDictionary());
let correctionSensitivity = 80;
function refreshCorrectionIndex() { correctionIndex = buildCorrectionIndex(getLearnerDictionary()); }

app.post('/api/inject/caption', (req, res) => {
    const { text, isFinal = true, applyDictionary = true } = req.body || {};
    if (!text || typeof text !== 'string') return res.status(400).json({ ok: false, error: 'text required' });
    let processed = text;
    let applied = [];
    if (applyDictionary && isFinal) {
        const r = applyCorrections(text, correctionIndex, { sensitivity: correctionSensitivity });
        processed = r.text; applied = r.applied;
    }
    feedCaptionToEncoder({ type: 'caption', isFinal: !!isFinal, payload: { text: processed } });
    res.json({ ok: true, text: processed, applied });
});

// Preview what the dictionary would do to a piece of text (used by the UI "test a sentence" box)
app.post('/api/context/apply', (req, res) => {
    const { text, sensitivity } = req.body || {};
    if (!text || typeof text !== 'string') return res.status(400).json({ ok: false, error: 'text required' });
    const r = applyCorrections(text, correctionIndex, { sensitivity: typeof sensitivity === 'number' ? sensitivity : correctionSensitivity });
    res.json({ ok: true, ...r });
});

// --- Caption Encoding Config API ---
app.get('/api/caption/config', (req, res) => {
    res.json(captionConfig);
});

app.post('/api/caption/config', (req, res) => {
    const { encodingMode, captionStrategy, maxCharsPerLine, rollupRows, polishEnabled, profanityFilter } = req.body;

    if (encodingMode && ['cea608', 'dtvcc'].includes(encodingMode)) {
        captionConfig.encodingMode = encodingMode;
    }
    if (captionStrategy && ['truncate', 'summarize', 'verbatim'].includes(captionStrategy)) {
        captionConfig.captionStrategy = captionStrategy;
    }
    if (maxCharsPerLine !== undefined) {
        captionConfig.maxCharsPerLine = Math.max(32, Math.min(128, parseInt(maxCharsPerLine) || 64));
    }
    if (rollupRows !== undefined) {
        captionConfig.rollupRows = rollupRows === 3 ? 3 : 2;
        if (cea608Encoder) cea608Encoder.setRollupRows(captionConfig.rollupRows);
    }
    if (polishEnabled !== undefined) {
        captionConfig.polishEnabled = !!polishEnabled;
    }
    if (profanityFilter !== undefined) {
        captionConfig.profanityFilter = !!profanityFilter;
    }

    console.log(`[Caption Config] Updated:`, captionConfig);
    res.json(captionConfig);
});

// --- Caption Metrics API ---
app.get('/api/caption/metrics', (req, res) => {
    const encoder = captionConfig.encodingMode === 'dtvcc' ? dtvccEncoder : cea608Encoder;
    captionMetrics.lastQueueDepth = encoder?.queueLength || 0;
    captionMetrics.avgLatencyMs = captionMetrics._latencyCount > 0
        ? Math.round(captionMetrics._latencySum / captionMetrics._latencyCount)
        : 0;
    res.json({
        totalEncoded: captionMetrics.totalEncoded,
        totalDropped: captionMetrics.totalDropped,
        totalSummarized: captionMetrics.totalSummarized,
        avgLatencyMs: captionMetrics.avgLatencyMs,
        queueDepth: captionMetrics.lastQueueDepth,
        uptimeSeconds: Math.round((Date.now() - captionMetrics.startTime) / 1000),
        encodingMode: captionConfig.encodingMode,
        strategy: captionConfig.captionStrategy,
    });
});

// --- SRT Export ---
app.get('/api/caption/export/srt', (req, res) => {
    const srt = generateSRT();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    res.setHeader('Content-Type', 'text/srt');
    res.setHeader('Content-Disposition', `attachment; filename="captions-${timestamp}.srt"`);
    res.send(srt);
});

app.get('/api/caption/history', (req, res) => {
    res.json({
        count: captionHistory.length,
        sessionStart: captionSessionStart,
        durationMs: captionSessionStart ? Date.now() - captionSessionStart : 0,
    });
});

app.post('/api/caption/history/clear', (req, res) => {
    captionHistory = [];
    captionSessionStart = null;
    res.json({ ok: true });
});

// --- Pre-broadcast checklist status ---
app.get('/api/checklist', async (req, res) => {
    const checks = {
        relayOnline: true,
        decklinkAddon: !!decklink,
        decklinkDevices: decklink ? (() => { try { return decklink.enumerateDevices().length > 0; } catch { return false; } })() : false,
        decklinkRunning: deckLinkRunning,
        geminiKeySet: !!captionConfig._geminiKeySet || !!process.env.GEMINI_API_KEY,
        dictionaryLoaded: getLearnerDictionary().length > 0,
        autoLearnEnabled: getLearnerStatus().enabled,
        encodingMode: captionConfig.encodingMode,
        captionStrategy: captionConfig.captionStrategy,
        captionHistoryCount: captionHistory.length,
    };
    // Check Gemini key from polisher
    try { checks.geminiKeySet = getPolisherStatus().geminiKeySet; } catch {}
    res.json(checks);
});

// --- Caption Polisher API ---
// Live machine stats for the Dashboard: CPU, RAM, GPU, network and what the local
// models cost. Sampling starts on first request and idles out 20 s after the last.
// Recent relay log lines (ring buffer) and the full file, for Diagnostics and support.
app.get('/api/logs', (req, res) => {
    const n = Math.max(1, Math.min(RELAY_LOG_MAX, Number(req.query.n) || 100));
    res.json({ ok: true, lines: relayLogRing.slice(-n), file: RELAY_LOG_FILE });
});
app.get('/api/logs/download', (req, res) => {
    try {
        const text = fsReadFileSync(RELAY_LOG_FILE, 'utf-8');
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="community-captioner-relay-${new Date().toISOString().slice(0, 10)}.log"`);
        res.send(text);
    } catch (e) {
        res.status(404).send(`No relay log yet (${e.message})`);
    }
});

app.get('/api/system/metrics', async (req, res) => {
    try {
        res.json({ ok: true, ...(await getSystemMetrics()) });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

app.get('/api/polisher/status', async (req, res) => {
    res.json({ ...getPolisherStatus(), localBrain: brainActive(), translationAvailable: await translationAvailable() });
});

// Translate one caption with whatever engine is active (local brain first, then Gemini).
// Used by the Dashboard's side-by-side translation so the browser never needs its own key.
app.post('/api/translate', async (req, res) => {
    const { text, lang } = req.body || {};
    if (!text || typeof text !== 'string') return res.status(400).json({ ok: false, error: 'text required' });
    if (!lang || typeof lang !== 'string' || lang === 'en') return res.json({ ok: true, translated: text, engine: 'none' });
    try {
        const translated = await translateCaption(text, lang, { timeoutMs: 10000 });
        res.json({ ok: true, translated, engine: brainActive() ? `ollama:${getBrainConfig().model}` : geminiKeyActive ? 'gemini' : 'none', changed: translated !== text });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

app.post('/api/polisher/toggle', (req, res) => {
    const enabled = togglePolisherGemini();
    res.json({ geminiEnabled: enabled });
});

app.post('/api/polisher/apikey', (req, res) => {
    const { key } = req.body;
    const ok = applyRuntimeApiKey(key);
    if (!ok) {
        return res.status(400).json({ ok: false, error: 'Key missing or too short' });
    }
    res.json({ ok: true, source: geminiKeySource, masked: maskKey(geminiKeyActive) });
});

// --- YouTube Caption Ingestion URL ---
// In YouTube Studio for a live stream, set Closed Captions = "Caption ingestion URL"
// and YT will give you a URL that looks like:
//   http://upload.youtube.com/closedcaption?cid=ABCDE-12345-...
// Paste it here and every final caption gets POSTed to YT with a timecode.
app.get('/api/youtube/caption-url', (req, res) => {
    res.json({
        url: youtubeCaptionState.url,
        sessionStartMs: youtubeCaptionState.sessionStartMs,
        sequence: youtubeCaptionState.sequence,
        lastPostMs: youtubeCaptionState.lastPostMs,
        lastError: youtubeCaptionState.lastError,
    });
});

app.post('/api/youtube/caption-url', (req, res) => {
    const { url } = req.body || {};
    if (url && typeof url === 'string' && url.trim()) {
        const trimmed = url.trim();
        if (!/^https?:\/\//i.test(trimmed)) {
            return res.status(400).json({ ok: false, error: 'URL must start with http:// or https://' });
        }
        youtubeCaptionState.url = trimmed;
        youtubeCaptionState.sessionStartMs = Date.now();
        youtubeCaptionState.sequence = 1;
        youtubeCaptionState.lastError = null;
        console.log(`[YouTube CC] Ingestion URL set, session start ${new Date(youtubeCaptionState.sessionStartMs).toISOString()}`);
    } else {
        youtubeCaptionState.url = null;
        youtubeCaptionState.sessionStartMs = null;
        youtubeCaptionState.lastError = null;
        console.log('[YouTube CC] Ingestion URL cleared');
    }
    res.json({ ok: true, url: youtubeCaptionState.url });
});

// =====================================================================
// App info + Local AI stack (speech server launcher, Ollama)
// =====================================================================

// Where this relay runs. The UI uses it to stop nagging about "the desktop
// app" when the operator is already running the standalone .app/.exe or a
// local dev server, and to decide whether the guided local setup can act.
app.get('/api/app/info', (req, res) => {
    res.json({
        version: APP_VERSION,
        desktopApp: !!process.env.DIST_PATH || typeof process.pkg !== 'undefined',
        platform: process.platform,
        arch: process.arch,
        addonLoaded: !!decklink,
        port: PORT,
        hostname: os.hostname(),
    });
});

app.get('/api/local/info', async (req, res) => {
    try {
        if (req.query.refresh === '1') invalidateProbe();
        const info = await probeSystem({ ollamaUrl: typeof req.query.ollamaUrl === 'string' ? req.query.ollamaUrl : undefined, whisperPort: parseInt(req.query.port) || undefined });
        res.json({ ok: true, ...info, whisperModels: WHISPER_MODELS, ollamaModels: OLLAMA_MODELS, managed: getWhisperStatus() });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// The bundled speech server script, for people who prefer to run it by hand
app.get('/api/local/whisper-server.py', (req, res) => {
    try {
        res.setHeader('Content-Type', 'text/x-python; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="whisper_server.py"');
        res.send(readScript());
    } catch (e) {
        res.status(404).json({ ok: false, error: e.message });
    }
});

app.post('/api/local/whisper/start', async (req, res) => {
    // A first start spends minutes installing packages before startWhisper resolves.
    // Answer within a few seconds either way; the wizard follows the status/log feed.
    try {
        const startP = startWhisper(req.body || {});
        startP.catch(() => {});
        const r = await Promise.race([startP, new Promise(resolve => setTimeout(() => resolve({ pending: true }), 3000))]);
        res.json({ ok: true, ...r, status: getWhisperStatus() });
    } catch (e) {
        res.status(400).json({ ok: false, error: e.message, status: getWhisperStatus() });
    }
});

// Make sure the speech server is up before a local workflow needs it. Starts the
// server the operator configured earlier (whisper.json) and long-polls until ready.
app.post('/api/local/whisper/ensure', async (req, res) => {
    try {
        const r = await ensureWhisper({ timeoutMs: Math.min(15 * 60 * 1000, Number(req.body?.timeoutMs) || 10 * 60 * 1000) });
        res.json(r);
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ---------------------------------------------------------------------------
// Prerecorded files on the local engine: upload → (auto-start server) → decode →
// transcribe utterance by utterance, streamed to the browser as SSE.
// ---------------------------------------------------------------------------
const UPLOAD_DIR = join(LOCAL_DIR, 'uploads');
const fileJobs = new Map();
const mediaUpload = multer ? multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => { try { fsMkdirSync(UPLOAD_DIR, { recursive: true }); } catch {} cb(null, UPLOAD_DIR); },
        filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${extname(file.originalname || '') || '.bin'}`),
    }),
    limits: { fileSize: 8 * 1024 * 1024 * 1024 },
}) : null;

function jobPublic(job, withSegments = false) {
    const { listeners, cancelFn, path, ...rest } = job;
    return withSegments ? rest : { ...rest, segments: undefined, segmentCount: job.segments.length };
}
function jobEmit(job, ev) { for (const fn of job.listeners) { try { fn(ev); } catch {} } }
function jobUpdate(job, patch) { Object.assign(job, patch); jobEmit(job, { type: 'job', job: jobPublic(job) }); }

async function runFileJob(job) {
    const t0 = Date.now();
    try {
        if (job.kind === 'youtube') {
            jobUpdate(job, { status: 'downloading', message: 'Contacting YouTube…', progress: 0 });
            const dl = await downloadYoutubeAudio(job.url, UPLOAD_DIR, (p) => jobUpdate(job, { message: p.message, progress: p.percent != null ? p.percent / 100 : job.progress }));
            job.path = dl.path;
            jobUpdate(job, { filename: dl.title, bytes: (() => { try { return statSync(dl.path).size; } catch { return 0; } })(), progress: 1 });
        }
        jobUpdate(job, { status: 'starting_server', message: 'Checking the local speech server…', progress: 0 });
        const logTail = (st) => (st.logs || []).slice(-5).map(l => (l && typeof l === 'object') ? (l.line || '') : String(l)).filter(Boolean);
        const ens = await ensureWhisper({ onStatus: (st) => jobUpdate(job, { message: st.message || 'Starting the speech server…', serverState: st.state, serverLog: logTail(st) }) });
        if (!ens.ok) {
            jobUpdate(job, { status: 'error', needsSetup: !!ens.needsSetup, error: ens.needsSetup ? 'The local speech engine is not set up on this computer yet. Open Local AI setup, install the speech server, then come back.' : (ens.error || 'The speech server is not available') });
            return;
        }
        if (job.cancelled) return jobUpdate(job, { status: 'cancelled', message: 'Cancelled' });
        jobUpdate(job, { status: 'decoding', message: 'Decoding audio…', progress: 0 });
        const client = transcribeFileWithServer({ path: job.path, jobId: job.id, onEvent: (m) => {
            if (m.type === 'hello') { jobUpdate(job, { engine: { backend: m.backend, model: m.model, device: m.device, compute: m.compute } }); return; }
            if (m.type === 'file_status') { jobUpdate(job, { status: m.stage === 'decoding' ? 'decoding' : 'transcribing', message: m.message, progress: m.progress ?? job.progress, durationSec: m.durationSec ?? job.durationSec, utterances: m.utterances ?? job.utterances }); return; }
            if (m.type === 'file_segment') {
                const seg = { start: m.start, end: m.end, text: m.text };
                job.segments.push(seg);
                job.progress = m.progress; job.durationSec = m.durationSec ?? job.durationSec; job.status = 'transcribing';
                const elapsed = (Date.now() - t0) / 1000;
                job.speed = elapsed > 2 && m.end ? +(m.end / elapsed).toFixed(1) : job.speed;
                jobEmit(job, { type: 'segment', segment: seg, progress: job.progress, durationSec: job.durationSec, speed: job.speed, segmentCount: job.segments.length });
                return;
            }
        } });
        job.cancelFn = client.cancel;
        await client.done;
        if (job.cancelled) return jobUpdate(job, { status: 'cancelled', message: 'Cancelled' });
        job.text = job.segments.map(s => s.text).join(' ');
        job.elapsedMs = Date.now() - t0;
        job.speed = job.durationSec ? +(job.durationSec / (job.elapsedMs / 1000)).toFixed(1) : null;
        job.status = 'done'; job.progress = 1; job.message = `Done: ${job.segments.length} segments in ${(job.elapsedMs / 1000).toFixed(0)} s`;
        jobEmit(job, { type: 'done', job: jobPublic(job, true) });
        console.log(`[File] ${job.filename}: ${job.durationSec?.toFixed(0)}s → ${job.segments.length} segments in ${job.elapsedMs}ms (${job.speed}x)`);
    } catch (e) {
        if (job.cancelled) jobUpdate(job, { status: 'cancelled', message: 'Cancelled' });
        else { console.warn(`[File] ${job.filename}: ${e.message}`); jobUpdate(job, { status: 'error', error: e.message }); }
    } finally {
        if (job.path) { try { unlinkSync(job.path); } catch {} }
        setTimeout(() => fileJobs.delete(job.id), 30 * 60 * 1000).unref?.();
    }
}

function newJob(fields) {
    const job = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`, status: 'queued', message: 'Queued', progress: 0, segments: [], listeners: new Set(), startedAt: Date.now(), cancelled: false, ...fields };
    fileJobs.set(job.id, job);
    setImmediate(() => runFileJob(job));
    return job;
}

if (mediaUpload) {
    app.post('/api/local/transcribe-file', mediaUpload.single('file'), (req, res) => {
        if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded' });
        const job = newJob({ kind: 'file', filename: req.file.originalname || 'media', bytes: req.file.size, path: req.file.path });
        res.json({ ok: true, jobId: job.id, job: jobPublic(job) });
    });
} else {
    app.post('/api/local/transcribe-file', (req, res) => res.status(503).json({ ok: false, error: 'File uploads are not available on this server (multer missing)' }));
}
app.post('/api/local/youtube', (req, res) => {
    const url = String(req.body?.url || '').trim();
    if (!url) return res.status(400).json({ ok: false, error: 'url required' });
    const job = newJob({ kind: 'youtube', url, filename: url, bytes: 0, path: null });
    res.json({ ok: true, jobId: job.id, job: jobPublic(job) });
});
app.get('/api/local/jobs/:id', (req, res) => {
    const job = fileJobs.get(req.params.id);
    if (!job) return res.status(404).json({ ok: false, error: 'No such job' });
    res.json({ ok: true, job: jobPublic(job, req.query.segments === '1') });
});
app.get('/api/local/jobs/:id/events', (req, res) => {
    const job = fileJobs.get(req.params.id);
    if (!job) return res.status(404).json({ ok: false, error: 'No such job' });
    const sse = sseInit(res);
    sse.emit('snapshot', { job: jobPublic(job, true) });
    if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') return sse.end();
    const fn = (ev) => { sse.emit(ev.type, ev); if (ev.type === 'done' || (ev.type === 'job' && ['error', 'cancelled'].includes(ev.job.status))) { job.listeners.delete(fn); sse.end(); } };
    job.listeners.add(fn);
    res.on('close', () => job.listeners.delete(fn));
    const keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
    res.on('close', () => clearInterval(keepAlive));
});
app.post('/api/local/jobs/:id/cancel', (req, res) => {
    const job = fileJobs.get(req.params.id);
    if (!job) return res.status(404).json({ ok: false, error: 'No such job' });
    job.cancelled = true;
    try { job.cancelFn?.(); } catch {}
    if (['queued', 'starting_server', 'downloading'].includes(job.status)) jobUpdate(job, { status: 'cancelled', message: 'Cancelled' });
    res.json({ ok: true });
});

app.post('/api/local/whisper/stop', async (req, res) => {
    const r = await stopWhisper();
    res.json({ ...r, status: getWhisperStatus() });
});

app.get('/api/local/whisper/status', (req, res) => {
    res.json({ ok: true, ...getWhisperStatus() });
});

// Live log + status stream for the setup wizard (SSE)
app.get('/api/local/whisper/logs', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    const send = (ev) => { try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch {} };
    const snapshot = getWhisperStatus();
    for (const l of snapshot.logs) send({ type: 'log', ...l });
    send({ type: 'status', ...snapshot, logs: undefined });
    const unsub = subscribeLogs(send);
    const keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
    res.on('close', () => { unsub(); clearInterval(keepAlive); }); // res, not req: req 'close' fires once the request is read (Node 16+)
});

// Ask any speech server (ours or a third-party one) for its hello message
app.post('/api/local/whisper/hello', async (req, res) => {
    const url = req.body?.url;
    if (!url || typeof url !== 'string' || !/^wss?:\/\//.test(url)) return res.status(400).json({ ok: false, error: 'ws:// url required' });
    try {
        const hello = await readHello(url);
        res.json({ ok: true, reachable: true, hello });
    } catch (e) {
        res.json({ ok: true, reachable: false, error: e.message });
    }
});

app.get('/api/local/ollama/models', async (req, res) => {
    res.json({ ok: true, ...(await ollamaModels(typeof req.query.url === 'string' ? req.query.url : undefined)), catalog: OLLAMA_MODELS });
});

app.post('/api/local/ollama/start', async (req, res) => {
    res.json(await ollamaStart(req.body?.url));
});

// Does this model work with the app? Runs the real extraction prompt on a
// sample agenda and grades recall of a few known names.
app.post('/api/local/ollama/test', async (req, res) => {
    const { model, url } = req.body || {};
    if (!model) return res.status(400).json({ ok: false, error: 'model required' });
    try { res.json(await testOllamaExtraction(model, url)); }
    catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});

// Which local model (if any) powers the Context Engine's extraction
app.get('/api/local/brain', (req, res) => {
    res.json({ ok: true, ...getBrainConfig() });
});

app.post('/api/local/brain', (req, res) => {
    const { enabled, url, model } = req.body || {};
    const cfg = setBrainConfig({
        ...(typeof enabled === 'boolean' ? { enabled } : {}),
        ...(typeof url === 'string' && url ? { url } : {}),
        ...(typeof model === 'string' && model ? { model } : {}),
    });
    res.json({ ok: true, ...cfg });
});

// Pull a model with progress (SSE): {status, completed, total, digest} as Ollama reports it
app.post('/api/local/ollama/pull', async (req, res) => {
    const { model, url } = req.body || {};
    if (!model) return res.status(400).json({ ok: false, error: 'model required' });
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    const send = (ev) => { try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch {} };
    const controller = new AbortController();
    // Abort the Ollama download only if the browser actually goes away. (Listening on
    // req 'close' is wrong: since Node 16 it fires as soon as the request body has
    // been consumed, which cancelled every download a few seconds in.)
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
        await ollamaPull(model, send, url, controller.signal);
        send({ status: 'done', model });
    } catch (e) {
        send({ status: 'error', error: e.message });
    }
    try { res.end(); } catch {}
});

// Public Gemini key status — used by the Context Engine UI to show a clear banner
// (loaded vs missing) and where the active key came from.
app.get('/api/gemini/status', (req, res) => {
    res.json({
        loaded: !!geminiKeyActive && geminiKeyActive.length >= 10,
        source: geminiKeySource,
        masked: maskKey(geminiKeyActive),
        keyLength: geminiKeyActive ? geminiKeyActive.length : 0,
    });
});

// --- Local Proper Noun Extraction (no AI needed) ---
function extractProperNounsLocally(text) {
    const entries = [];
    const seen = new Set();

    // Extract capitalized multi-word names (2-4 words, each starting with uppercase)
    // e.g., "Bernard W. Greene", "Coolidge Corner Theatre", "Brown and Caldwell"
    const namePattern = /\b([A-Z][a-z]+(?:\s+(?:[A-Z]\.?\s*)?[A-Z][a-z]+){1,3})\b/g;
    let match;
    while ((match = namePattern.exec(text)) !== null) {
        const name = match[1].trim();
        // Skip common phrases that start with capitals (beginning of sentences)
        const skipPhrases = ['The Town', 'The Board', 'The Select', 'The Public', 'Question Of', 'Change Order', 'Hours Of', 'Seating Will', 'Proposed Manager'];
        if (skipPhrases.some(s => name.startsWith(s))) continue;
        if (name.length < 4 || name.length > 50) continue;
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        // Generate phonetic misspelling hints
        const words = name.split(/\s+/);
        if (words.length >= 2) {
            entries.push({
                original: words.map(w => w.toLowerCase()).join(' '),
                replacement: name,
                type: 'proper_noun'
            });
        }
    }

    // Extract acronyms in parentheses: (ETD), (T10), (ADA)
    const acronymPattern = /\(([A-Z][A-Z0-9]{1,6})\)/g;
    while ((match = acronymPattern.exec(text)) !== null) {
        const acr = match[1];
        if (seen.has(acr.toLowerCase())) continue;
        seen.add(acr.toLowerCase());
        entries.push({ original: acr.toLowerCase(), replacement: acr, type: 'acronym' });
    }

    // Extract street/place names: "### Street Name" pattern
    const streetPattern = /\b(\d+(?:-\d+)?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+(?:Street|St|Avenue|Ave|Road|Rd|Way|Place|Lane|Drive|Boulevard|Blvd))\b/g;
    while ((match = streetPattern.exec(text)) !== null) {
        const place = match[1].trim();
        const key = place.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push({ original: key, replacement: place, type: 'place' });
    }

    // Extract organization names with common suffixes
    const orgPattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:LLC|Inc|Commission|Committee|Department|Board|Society|Group|Association))\b/g;
    while ((match = orgPattern.exec(text)) !== null) {
        const org = match[1].trim();
        const key = org.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push({ original: key, replacement: org, type: 'proper_noun' });
    }

    return entries;
}

// --- Context Learner API ---
app.get('/api/context/status', (req, res) => {
    res.json(getLearnerStatus());
});

app.post('/api/context/enable', (req, res) => {
    const { enabled } = req.body;
    setLearnerEnabled(!!enabled);
    res.json({ enabled: !!enabled });
});

app.get('/api/context/suggestions', (req, res) => {
    res.json(getSuggestions());
});

app.post('/api/context/accept', (req, res) => {
    const { id } = req.body;
    const entry = acceptSuggestion(id);
    if (entry) {
        res.json({ ok: true, entry });
    } else {
        res.status(404).json({ ok: false, error: 'Suggestion not found' });
    }
});

app.post('/api/context/dismiss', (req, res) => {
    const { id } = req.body;
    dismissSuggestion(id);
    res.json({ ok: true });
});

app.get('/api/context/dictionary', (req, res) => {
    res.json(getLearnerDictionary());
});

app.post('/api/context/dictionary', (req, res) => {
    const { dictionary, sensitivity } = req.body;
    if (Array.isArray(dictionary)) {
        setLearnerDictionary(dictionary);
        if (typeof sensitivity === 'number') correctionSensitivity = Math.max(0, Math.min(100, sensitivity));
        refreshCorrectionIndex();
        res.json({ ok: true, size: dictionary.length });
    } else {
        res.status(400).json({ ok: false, error: 'dictionary must be an array' });
    }
});

// --- Named profiles (server-side, shared by every operator machine) ---
app.get('/api/context/profiles', (req, res) => {
    res.json({ ok: true, profiles: listProfiles() });
});

app.get('/api/context/profiles/:id', (req, res) => {
    const p = getProfile(req.params.id);
    if (!p) return res.status(404).json({ ok: false, error: 'Profile not found' });
    res.json({ ok: true, profile: p });
});

app.post('/api/context/profiles', (req, res) => {
    const { name, entries, municipality, notes, merge } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) return res.status(400).json({ ok: false, error: 'name required' });
    if (!Array.isArray(entries)) return res.status(400).json({ ok: false, error: 'entries must be an array' });
    try {
        const profile = saveProfile({ name: name.trim(), entries, municipality, notes, merge: !!merge });
        console.log(`[Profiles] Saved "${profile.name}" (${profile.entries.length} entries)`);
        res.json({ ok: true, profile: { ...profile, entries: undefined, entryCount: profile.entries.length } });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

app.delete('/api/context/profiles/:id', (req, res) => {
    const removed = deleteProfile(req.params.id);
    if (!removed) return res.status(404).json({ ok: false, error: 'Profile not found' });
    console.log(`[Profiles] Deleted "${req.params.id}"`);
    res.json({ ok: true });
});

// Dictionary export as downloadable file
app.get('/api/context/dictionary/export', (req, res) => {
    const dict = getLearnerDictionary();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="caption-dictionary-${timestamp}.json"`);
    res.json({ version: 1, exportedAt: new Date().toISOString(), entries: dict });
});

// Dictionary import from exported file
app.post('/api/context/dictionary/import', (req, res) => {
    const { entries, merge } = req.body;
    if (!Array.isArray(entries)) {
        return res.status(400).json({ ok: false, error: 'entries must be an array' });
    }
    if (merge) {
        // Merge: add entries that don't already exist
        const current = getLearnerDictionary();
        const existingKeys = new Set(current.map(e => `${e.original.toLowerCase()}→${e.replacement.toLowerCase()}`));
        let added = 0;
        for (const entry of entries) {
            if (!entry.original || !entry.replacement) continue;
            const key = `${entry.original.toLowerCase()}→${entry.replacement.toLowerCase()}`;
            if (!existingKeys.has(key)) {
                current.push(entry);
                existingKeys.add(key);
                added++;
            }
        }
        setLearnerDictionary(current);
        res.json({ ok: true, added, total: current.length });
    } else {
        // Replace
        setLearnerDictionary(entries);
        res.json({ ok: true, total: entries.length });
    }
});

// Delete a single dictionary entry
app.post('/api/context/dictionary/delete', (req, res) => {
    const { original, replacement } = req.body;
    if (!original || !replacement) return res.status(400).json({ ok: false, error: 'original and replacement required' });
    const dict = getLearnerDictionary();
    const newDict = dict.filter(e => !(e.original.toLowerCase() === original.toLowerCase() && e.replacement.toLowerCase() === replacement.toLowerCase()));
    setLearnerDictionary(newDict);
    res.json({ ok: true, removed: dict.length - newDict.length, total: newDict.length });
});

// =====================================================================
// Context Engine — document / web ingestion + Municipality Wizard
//
// All AI calls go through server/context-sources.js and
// server/context-learner.js. Endpoints that take a while stream progress
// over Server-Sent Events so the UI can show what is happening.
// =====================================================================

/** Pick the Gemini key for this request (body/header override, else server key). */
function resolveRequestKey(req) {
    const candidates = [req.body?.apiKey, req.headers['x-api-key']];
    const k = candidates.find(v => typeof v === 'string' && v.trim().length >= 10 && v.trim() !== 'PLACEHOLDER_API_KEY');
    if (k) applyRuntimeApiKey(k.trim());
    return geminiKeyActive || null;
}

/**
 * Extract dictionary entries from text with whichever engine is available:
 *   1. the local Ollama brain when the operator enabled it (Fully Local mode)
 *   2. Gemini when a key is loaded
 *   3. basic pattern extraction
 * Returns { entries, engine, warning? }.
 */
async function extractEntriesAnyEngine(text, apiKey, { domainHint = '' } = {}) {
    if (brainActive()) {
        const b = getBrainConfig();
        try {
            const r = await extractEntriesWithOllama(text, { domainHint });
            if (r.entries.length > 0) {
                console.log(`[Context] Ollama ${b.model}: ${r.items.length} names → ${r.entries.length} entries in ${r.latencyMs}ms`);
                return { entries: r.entries, engine: `ollama:${b.model}` };
            }
            console.warn(`[Context] Ollama ${b.model} returned no entries${apiKey ? ' — falling back to Gemini' : ''}`);
        } catch (e) {
            console.warn(`[Context] Ollama ${b.model} failed: ${e.message}${apiKey ? ' — falling back to Gemini' : ''}`);
            if (!apiKey) {
                const local = extractProperNounsLocally(text);
                return { entries: local, engine: 'local-regex', warning: `Local AI brain (${b.model}) failed: ${e.message}. Used basic pattern extraction.` };
            }
        }
    }
    if (apiKey) {
        const entries = await extractDictionary(text, apiKey, { domainHint });
        return { entries, engine: 'gemini' };
    }
    const local = extractProperNounsLocally(text);
    return { entries: local, engine: 'local-regex', warning: 'No AI engine configured — used basic pattern extraction. Add a Gemini key, or set up the local AI brain.' };
}

/** Server-Sent Events helper. */
function sseInit(res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    let closed = false;
    res.on('close', () => { closed = true; });
    return {
        emit(phase, data = {}) {
            if (closed) return;
            try { res.write(`data: ${JSON.stringify({ phase, t: Date.now(), ...data })}\n\n`); } catch {}
        },
        end() { if (!closed) { closed = true; try { res.end(); } catch {} } },
        get closed() { return closed; },
    };
}

/**
 * Fetch a URL and turn it into dictionary entries. Shared by /scrape and
 * /scrape-stream. Falls back to Gemini's own page reader when the site
 * blocks server-side fetches (Cloudflare 403) or is a JavaScript-only app.
 */
async function scrapeUrlToEntries(url, apiKey, emit = () => {}) {
    const start = Date.now();
    emit('fetching', { url });
    const page = await fetchPage(url);

    if (!page.ok) {
        if (page.blocked && apiKey) {
            emit('ai_fetch', { message: `Site blocks automated visitors (HTTP ${page.status}) — asking Gemini to read the page…`, status: page.status });
            const r = await extractDictionaryFromUrl(url, apiKey);
            if (r.ok) return { ok: true, entries: r.entries, textLength: 0, source: 'gemini_url', totalMs: Date.now() - start };
            return { ok: false, error: `HTTP ${page.status}, and Gemini could not read the page (${r.error})`, entries: [] };
        }
        return { ok: false, error: page.error || `HTTP ${page.status}`, entries: [] };
    }

    emit('fetched', { contentType: page.contentType, status: page.status, elapsedMs: Date.now() - start });
    const isPdf = page.contentType.includes('pdf') || page.buffer.subarray(0, 5).toString() === '%PDF-';
    let text = '';
    let sourceType = 'html';
    if (isPdf) {
        emit('parsing', { sourceType: 'pdf', bytes: page.buffer.length });
        try {
            text = (await extractPdfText(page.buffer)).text;
            sourceType = 'pdf';
        } catch (e) {
            return { ok: false, error: `PDF parse failed: ${e.message}`, entries: [] };
        }
    } else {
        emit('parsing', { sourceType: 'html', bytes: page.buffer.length });
        text = htmlToText(page.buffer.toString('utf8'));
    }
    emit('parsed', { textLength: text.length, sourceType });

    if (!isPdf && text.length < 200) {
        if (apiKey) {
            emit('ai_fetch', { message: 'Page is a JavaScript app with no static text — asking Gemini to read it…' });
            const r = await extractDictionaryFromUrl(url, apiKey);
            if (r.ok && r.entries.length) return { ok: true, entries: r.entries, textLength: 0, source: 'gemini_url', totalMs: Date.now() - start };
        }
        return { ok: true, entries: [], textLength: text.length, source: sourceType, warning: 'Page has little readable text (dynamic page). Upload the agenda PDF instead.', totalMs: Date.now() - start };
    }

    emit('extracting', { textLength: text.length, model: brainActive() ? `ollama:${getBrainConfig().model}` : apiKey ? GEMINI_TEXT_MODEL : 'local-regex' });
    const r = await extractEntriesAnyEngine(text, apiKey);
    return { ok: true, entries: r.entries, engine: r.engine, warning: r.warning, textLength: text.length, source: sourceType, totalMs: Date.now() - start };
}

// What this server can do — lets the UI explain missing pieces instead of failing silently
app.get('/api/context/capabilities', (req, res) => {
    res.json({
        pdf: pdfSupportAvailable(),
        docx: true,
        upload: !!multer,
        geminiKey: !!geminiKeyActive,
        geminiKeySource,
        model: GEMINI_TEXT_MODEL,
        brain: getBrainConfig(),
        extractionEngine: brainActive() ? `ollama:${getBrainConfig().model}` : geminiKeyActive ? 'gemini' : 'local-regex',
        researchGroups: getResearchGroups(),
    });
});

// Scrape a single URL (non-streaming)
app.post('/api/context/scrape', async (req, res) => {
    const { url } = req.body || {};
    if (!url || typeof url !== 'string') return res.status(400).json({ ok: false, error: 'url required' });
    const apiKey = resolveRequestKey(req);
    try {
        console.log(`[Context] Scraping URL: ${url}`);
        const result = await scrapeUrlToEntries(url, apiKey);
        console.log(`[Context] Scrape ${url}: ${result.ok ? `${result.entries.length} entries (${result.source})` : `failed: ${result.error}`}`);
        res.status(result.ok ? 200 : 502).json(result);
    } catch (e) {
        console.warn(`[Context] Scrape error: ${e.message}`);
        res.status(500).json({ ok: false, error: e.message });
    }
});

// Scrape a single URL with live progress (SSE)
app.post('/api/context/scrape-stream', async (req, res) => {
    const { url } = req.body || {};
    if (!url || typeof url !== 'string') return res.status(400).json({ ok: false, error: 'url required' });
    const apiKey = resolveRequestKey(req);
    const sse = sseInit(res);
    const start = Date.now();
    try {
        const result = await scrapeUrlToEntries(url, apiKey, sse.emit);
        if (!result.ok) {
            sse.emit('error', { error: result.error });
            return sse.end();
        }
        const CHUNK = 12;
        for (let i = 0; i < result.entries.length; i += CHUNK) {
            sse.emit('entries', { batch: result.entries.slice(i, i + CHUNK), total: result.entries.length, sent: Math.min(i + CHUNK, result.entries.length) });
        }
        sse.emit('done', { totalEntries: result.entries.length, totalMs: Date.now() - start, sourceType: result.source, warning: result.warning });
        sse.end();
    } catch (e) {
        sse.emit('error', { error: e.message });
        sse.end();
    }
});

// Municipality Wizard, phase 1 only (find official pages) — non-streaming
app.post('/api/context/search-municipality', async (req, res) => {
    const { query } = req.body || {};
    if (!query || typeof query !== 'string') return res.status(400).json({ ok: false, error: 'query required' });
    const apiKey = resolveRequestKey(req);
    if (!apiKey && !brainActive()) return res.status(400).json({ ok: false, error: 'No AI engine: add a Gemini key or set up the local AI brain' });
    try {
        const r = brainActive() ? await locateMunicipalityLocally(query.trim()) : await locateMunicipalitySources(query.trim(), apiKey);
        if (!r.ok) return res.status(502).json({ ok: false, error: r.error, results: [] });
        res.json({ ok: true, results: r.sources, officialHost: r.officialHost, crawlNote: r.crawlNote });
    } catch (e) {
        console.warn('[Wizard] Server search failed:', e.message);
        res.status(500).json({ ok: false, error: e.message, results: [] });
    }
});

/**
 * Municipality Wizard — full research run with live progress (SSE).
 * Body: { query, apiKey?, groups?: string[], skipSources?: boolean, domainHint?: string }
 *
 * Events:
 *   status          { step: 'locate'|'research', message }
 *   sources         { officialHost, sources[], crawlNote }
 *   research_start  { groups: [{key,label}] }
 *   group           { key, label, ok, error?, elapsedMs, items: [{name, category, detail, misheard, entries[]}] }
 *   done            { totalItems, totalEntries, totalMs }
 *   error           { error }
 */
app.post('/api/context/wizard/research', async (req, res) => {
    const { query, groups, skipSources, domainHint } = req.body || {};
    if (!query || typeof query !== 'string' || !query.trim()) return res.status(400).json({ ok: false, error: 'query required' });
    const apiKey = resolveRequestKey(req);
    if (!apiKey && !brainActive()) return res.status(400).json({ ok: false, error: 'No AI engine. Add a Gemini key in the Context Engine settings, or set up the local AI brain (Connect Local AI).' });

    const sse = sseInit(res);
    const start = Date.now();
    const q = query.trim();

    // Fully Local mode: web search + the Ollama brain, no Gemini involved
    if (brainActive()) {
        console.log(`[Wizard] Local research started for "${q}" (${getBrainConfig().model})`);
        try {
            const r = await researchMunicipalityLocally(q, { emit: sse.emit });
            console.log(`[Wizard] Local research for "${q}" ${r.ok ? `done: ${r.totalItems} items / ${r.totalEntries} entries` : 'failed'} in ${Date.now() - start}ms`);
        } catch (e) {
            console.warn('[Wizard] Local research failed:', e.message);
            sse.emit('error', { error: e.message });
        }
        return sse.end();
    }

    console.log(`[Wizard] Research started for "${q}"`);

    try {
        // Phase 1 — official site + pages (runs concurrently with research)
        const sourcesPromise = skipSources
            ? Promise.resolve(null)
            : locateMunicipalitySources(q, apiKey, (phase, data) => sse.emit('status', { step: 'locate', phase, message: data.message || '' }))
                .then(r => {
                    if (r.ok) sse.emit('sources', { officialHost: r.officialHost, sources: r.sources, crawlNote: r.crawlNote, elapsedMs: Date.now() - start });
                    else sse.emit('sources', { officialHost: null, sources: [], error: r.error, elapsedMs: Date.now() - start });
                    return r;
                })
                .catch(e => { sse.emit('sources', { officialHost: null, sources: [], error: e.message }); return null; });

        // Phase 2 — grounded research, streamed per group
        const selectedGroups = Array.isArray(groups) && groups.length ? groups : getResearchGroups().map(g => g.key);
        sse.emit('research_start', { groups: getResearchGroups().filter(g => selectedGroups.includes(g.key)) });
        sse.emit('status', { step: 'research', message: `Researching ${q} with Google Search (usually 20–45 seconds)…` });

        let totalItems = 0, totalEntries = 0;
        const research = await researchMunicipality(q, apiKey, {
            groups: selectedGroups,
            domainHint: typeof domainHint === 'string' ? domainHint.slice(0, 80) : '',
            onGroup: (key, result) => {
                const items = (result.items || []).map(it => ({ ...it, entries: itemsToEntries([it]) }));
                const entryCount = items.reduce((n, it) => n + it.entries.length, 0);
                totalItems += items.length;
                totalEntries += entryCount;
                sse.emit('group', { key, label: result.label, ok: result.ok, error: result.error, elapsedMs: result.elapsedMs, items });
                console.log(`[Wizard] ${key}: ${result.ok ? `${items.length} items / ${entryCount} entries` : `failed: ${result.error}`} in ${result.elapsedMs}ms`);
            },
        });

        await sourcesPromise;
        if (!research.ok && totalItems === 0) {
            sse.emit('error', { error: research.groups?.find(g => g.error)?.error || research.error || 'Research returned nothing' });
        }
        sse.emit('done', { totalItems, totalEntries, totalMs: Date.now() - start });
        console.log(`[Wizard] Research for "${q}" done: ${totalItems} items / ${totalEntries} entries in ${Date.now() - start}ms`);
        sse.end();
    } catch (e) {
        console.warn('[Wizard] Research failed:', e.message);
        sse.emit('error', { error: e.message });
        sse.end();
    }
});

// Discover relevant sub-pages on a site (used by the wizard's deep-scan step)
app.post('/api/context/discover-links', async (req, res) => {
    const { url } = req.body || {};
    if (!url || typeof url !== 'string') return res.status(400).json({ ok: false, error: 'url required' });
    try {
        const page = await fetchPage(url, { timeoutMs: 10000 });
        if (!page.ok) return res.json({ ok: false, error: page.error || `HTTP ${page.status}`, blocked: !!page.blocked, links: [] });
        if (!page.contentType.includes('html')) return res.json({ ok: true, links: [], total: 0 });
        const links = discoverLinks(page.finalUrl, page.buffer.toString('utf8'));
        console.log(`[Context] Discovered ${links.length} relevant links from ${url}`);
        res.json({ ok: true, links, total: links.length });
    } catch (e) {
        res.json({ ok: false, error: e.message, links: [] });
    }
});

// Document upload: PDF, DOCX, TXT, HTML (multipart field "file")
const upload = multer ? multer({ storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024 } }) : null;

if (upload) {
    // Streaming upload: the same parsing + extraction as /upload-pdf, but with live
    // phases so the Context Engine can show what is happening (reading → extracting
    // chunk 2/4 with <engine> → done) instead of a spinner for up to a minute.
    app.post('/api/context/upload-stream', upload.single('file'), async (req, res) => {
        if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded' });
        const apiKey = resolveRequestKey(req);
        const filename = req.file.originalname || 'document';
        const domainHint = typeof req.body?.domainHint === 'string' ? req.body.domainHint : '';
        const sse = sseInit(res);
        const t0 = Date.now();
        sse.emit('received', { filename, bytes: req.file.size });
        try {
            sse.emit('parsing', { filename, message: `Reading ${filename}…` });
            const extracted = await extractUploadedText(req.file.buffer, filename, req.file.mimetype || '');
            const text = (extracted.text || '').trim();
            const words = text ? text.split(/\s+/).length : 0;
            const pages = extracted.pages || null;
            console.log(`[Context] Upload-stream ${filename}: kind=${extracted.kind}${pages ? ` pages=${pages}` : ''} chars=${text.length} key=${apiKey ? 'yes' : 'no'} brain=${brainActive()}`);
            sse.emit('parsed', { kind: extracted.kind, pages, chars: text.length, words, preview: text.slice(0, 1500), ms: Date.now() - t0 });
            if (text.length < 20) {
                const hint = extracted.kind === 'pdf'
                    ? 'This PDF has no selectable text (probably a scan). Export a text PDF from the agenda software, or paste the agenda text instead.'
                    : 'Could not read any text from this file.';
                sse.emit('done', { entries: [], items: [], engine: 'none', warning: hint, ms: Date.now() - t0, kind: extracted.kind, pages, chars: text.length, filename });
                return sse.end();
            }
            let entries = [], items = [], warning = null, engine = 'local-regex';
            if (brainActive()) {
                const b = getBrainConfig();
                engine = `ollama:${b.model}`;
                const chunks = Math.max(1, Math.min(4, Math.ceil(text.length / 6000)));
                sse.emit('extracting', { engine, chunk: 0, chunks, message: `Extracting names with ${b.model} (${chunks} ${chunks === 1 ? 'pass' : 'passes'})…` });
                try {
                    const r = await extractItemsWithOllama(text, { url: b.url, model: b.model, domainHint, onProgress: (p) => sse.emit('extracting', { engine, ...p, message: `Extracting names with ${b.model} (${p.chunk}/${p.chunks})…` }) });
                    items = r.items || [];
                    entries = itemsToEntries(items);
                    sse.emit('engine_done', { engine, items: items.length, entries: entries.length, ms: r.latencyMs, tokensPerSec: r.tokensPerSec });
                } catch (e) {
                    warning = `Local AI brain (${b.model}) failed: ${e.message}.`;
                    sse.emit('engine_done', { engine, items: 0, entries: 0, error: e.message });
                }
            }
            if (entries.length === 0 && apiKey) {
                engine = 'gemini';
                const chunks = Math.max(1, Math.min(6, Math.ceil(text.length / 24000)));
                sse.emit('extracting', { engine, chunk: 0, chunks, message: `Extracting names with Gemini (${chunks} ${chunks === 1 ? 'pass' : 'passes'} in parallel)…` });
                try {
                    entries = await extractDictionary(text, apiKey, { domainHint });
                    sse.emit('engine_done', { engine, entries: entries.length });
                } catch (e) {
                    warning = `${warning ? warning + ' ' : ''}Gemini failed: ${e.message}.`;
                    sse.emit('engine_done', { engine, entries: 0, error: e.message });
                }
            }
            if (entries.length === 0) {
                const local = extractProperNounsLocally(text);
                if (local.length > 0) {
                    warning = `${warning ? warning + ' ' : ''}${engine === 'local-regex' ? 'No AI engine is configured — used basic pattern extraction.' : 'AI extraction returned nothing; used basic pattern extraction instead.'}`;
                    engine = 'local-regex';
                    entries = local;
                }
            }
            console.log(`[Context] Upload-stream ${filename}: ${text.length} chars → ${entries.length} entries (${engine}) in ${Date.now() - t0}ms`);
            sse.emit('done', { entries, items, engine, warning: warning || undefined, ms: Date.now() - t0, kind: extracted.kind, pages, chars: text.length, words, filename });
        } catch (e) {
            console.warn(`[Context] Upload-stream error (${filename}): ${e.message}`);
            sse.emit('error', { error: e.message, filename });
        }
        sse.end();
    });

    app.post('/api/context/upload-pdf', upload.single('file'), async (req, res) => {
        if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded' });
        const apiKey = resolveRequestKey(req);
        const filename = req.file.originalname || 'document';
        try {
            const extracted = await extractUploadedText(req.file.buffer, filename, req.file.mimetype || '');
            const text = (extracted.text || '').trim();
            console.log(`[Context] Upload ${filename}: kind=${extracted.kind}${extracted.pages ? ` pages=${extracted.pages}` : ''} chars=${text.length} key=${apiKey ? 'yes' : 'no'}`);

            if (text.length < 20) {
                const hint = extracted.kind === 'pdf'
                    ? 'This PDF has no selectable text (probably a scan). Export a text PDF from the agenda software, or paste the agenda text instead.'
                    : 'Could not read any text from this file.';
                return res.json({ ok: true, entries: [], textLength: text.length, filename, kind: extracted.kind, warning: hint });
            }

            const base = { textLength: text.length, filename, kind: extracted.kind, pages: extracted.pages || undefined, preview: text.slice(0, 300) };

            const r = await extractEntriesAnyEngine(text, apiKey, { domainHint: typeof req.body?.domainHint === 'string' ? req.body.domainHint : '' });
            console.log(`[Context] Uploaded ${filename}: ${text.length} chars → ${r.entries.length} entries (${r.engine})`);
            if (r.entries.length === 0 && r.engine !== 'local-regex') {
                const localEntries = extractProperNounsLocally(text);
                if (localEntries.length > 0) {
                    return res.json({ ok: true, entries: localEntries, engine: 'local-regex', ...base, warning: 'AI extraction returned nothing; used basic pattern extraction instead.' });
                }
            }
            res.json({ ok: true, entries: r.entries, engine: r.engine, warning: r.warning, ...base });
        } catch (e) {
            console.warn(`[Context] Upload error (${filename}): ${e.message}`);
            res.status(422).json({ ok: false, error: e.message, filename });
        }
    });
} else {
    app.post('/api/context/upload-pdf', (req, res) => res.status(503).json({ ok: false, error: 'File uploads are not available on this server (multer missing)' }));
}

// Quick Names — generate STT mishearing entries from a list of names/terms
app.post('/api/context/names', async (req, res) => {
    const { names } = req.body || {};
    if (!names || !Array.isArray(names) || names.length === 0) {
        return res.status(400).json({ ok: false, error: 'names array required' });
    }
    const apiKey = resolveRequestKey(req);
    try {
        const entries = await generateMishearings(names.slice(0, 50), apiKey);
        console.log(`[Context] Quick Names: ${names.length} names → ${entries.length} entries`);
        res.json({ ok: true, entries });
    } catch (e) {
        console.warn('[Context] Quick Names error:', e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
});

// Plain text / paste extraction
app.post('/api/context/extract', async (req, res) => {
    const { text, domainHint } = req.body || {};
    if (!text || typeof text !== 'string' || !text.trim()) return res.status(400).json({ ok: false, error: 'text required' });
    const apiKey = resolveRequestKey(req);
    try {
        const r = await extractEntriesAnyEngine(text, apiKey, { domainHint: typeof domainHint === 'string' ? domainHint : '' });
        res.json({ ok: true, entries: r.entries, engine: r.engine, warning: r.warning, textLength: text.length });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// --- Translation API ---
app.get('/api/translation/languages', (req, res) => {
    res.json(getSupportedLanguages());
});

app.get('/api/translation/stats', (req, res) => {
    // Count viewers per language
    const langCounts = {};
    mainWss?.clients?.forEach(ws => {
        if (ws.readyState === 1 && ws.role === 'audience') {
            const lang = ws.lang || 'en';
            langCounts[lang] = (langCounts[lang] || 0) + 1;
        }
    });
    res.json({ ...getTranslationStats(), viewersPerLanguage: langCounts });
});

// --- Audience URL API ---
app.get('/api/audience-url', (req, res) => {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.get('host');
    const fullUrl = `${protocol}://${host}`;
    const resolvedUrl = publicTunnelUrl || backupTunnelUrl || fullUrl;
    res.json({
        url: `${resolvedUrl}/?view=audience&session=demo`,
        localUrl: `http://${localIP}:${PORT}/?view=audience&session=demo`,
        backupUrl: backupTunnelUrl ? `${backupTunnelUrl}/?view=audience&session=demo` : null,
        audienceCount: getAudienceCount(),
    });
});

// Track audience connections
let audienceCount = 0;
function getAudienceCount() { return audienceCount; }

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
const mainWss = wss; // alias for API endpoints
const sessions = new Map();

// --- CEA-708 SDI Bridge WebSocket ---
const cea708Wss = new WebSocketServer({ noServer: true });
const cea708Clients = new Set();
// Delta tracking removed — only final captions are forwarded to CEA-708 bridge

// Forward caption data to all connected CEA-708 bridge clients.
// ONLY final captions are forwarded. Interim/partial results are skipped
// because CEA-608 cannot erase and rewrite — sending interims causes
// garbled stuttered text (e.g. "totohehem", "appply", "c c apppply").
function forwardToCea708(captionData) {
    if (cea708Clients.size === 0) return;

    let cea708Msg;

    if (captionData.type === 'caption') {
        // Skip interims — they cause garbled CEA-608 output
        if (!captionData.isFinal) return;

        const fullText = (typeof captionData.payload === 'string')
            ? captionData.payload
            : (captionData.payload.text || '');
        if (!fullText) return;

        cea708Msg = JSON.stringify({ text: fullText, isFinal: true });
    } else if (captionData.type === 'cea708_clear') {
        cea708Msg = JSON.stringify({ clear: true });
    } else {
        return;
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
            if (data.clear && cea608Encoder) {
                cea608Encoder.enqueueClear();
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
  let clientRole = null;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      if (data.type === 'join') {
        currentSessionId = data.sessionId;
        clientRole = data.role || 'unknown';
        ws.role = clientRole;
        ws.lang = data.lang || 'en'; // Default to English
        if (!sessions.has(currentSessionId)) {
          sessions.set(currentSessionId, new Set());
        }
        sessions.get(currentSessionId).add(ws);
        // Track audience connections
        if (clientRole === 'audience') {
            audienceCount++;
            console.log(`[Audience] Connected lang=${ws.lang} (${audienceCount} total)`);
        }
      }

      // Audience language selection
      if (data.type === 'set_language') {
          ws.lang = data.lang || 'en';
          console.log(`[Audience] Language changed to ${ws.lang}`);
      }

      if (data.type === 'caption') {
          console.log(`[WS IN] isFinal=${data.isFinal} text="${(typeof data.payload === 'string' ? data.payload : data.payload?.text || '').slice(0,60)}"`);
      }

      if ((data.type === 'caption' || data.type === 'settings') && currentSessionId && sessions.has(currentSessionId)) {
        // For final captions, apply text polishing before broadcasting
        if (data.type === 'caption' && data.isFinal) {
            const rawText = (typeof data.payload === 'string')
                ? data.payload
                : (data.payload?.text || '');
            if (rawText) {
                // Polish and broadcast asynchronously
                polish(rawText).then(async (polished) => {
                    // Record for SRT export
                    recordCaption(polished);
                    // Feed Auto-Learn (non-blocking). This used to happen only inside the
                    // DeckLink encoder path, so Auto-Learn never saw text in browser mode.
                    learnerFeedText(polished);
                    const polishedData = { ...data };
                    if (typeof polishedData.payload === 'string') {
                        polishedData.payload = polished;
                    } else if (polishedData.payload) {
                        polishedData.payload = { ...polishedData.payload, text: polished };
                    }

                    // Broadcast to session clients with per-language translation
                    const clients = sessions.get(currentSessionId);
                    if (clients) {
                        // 1. Send English immediately to English clients and non-audience
                        clients.forEach(client => {
                            if (client !== ws && client.readyState === 1) {
                                if (client.role !== 'audience' || !client.lang || client.lang === 'en') {
                                    client.send(JSON.stringify(polishedData));
                                }
                            }
                        });

                        // 2. Collect unique non-English languages from audience
                        const nonEnLangs = new Set();
                        clients.forEach(client => {
                            if (client !== ws && client.readyState === 1 && client.role === 'audience' && client.lang && client.lang !== 'en') {
                                nonEnLangs.add(client.lang);
                            }
                        });

                        // 3. Translate for each language (in parallel, cached)
                        if (nonEnLangs.size > 0) {
                            const translations = await Promise.all(
                                [...nonEnLangs].map(async (lang) => {
                                    const translated = await translateCaption(polished, lang);
                                    return { lang, translated };
                                })
                            );

                            // 4. Send translated caption to matching audience clients
                            for (const { lang, translated } of translations) {
                                const translatedPayload = { ...polishedData };
                                if (typeof translatedPayload.payload === 'string') {
                                    translatedPayload.payload = translated;
                                } else if (translatedPayload.payload) {
                                    translatedPayload.payload = { ...translatedPayload.payload, translatedText: translated };
                                }
                                clients.forEach(client => {
                                    if (client !== ws && client.readyState === 1 && client.role === 'audience' && client.lang === lang) {
                                        client.send(JSON.stringify(translatedPayload));
                                    }
                                });
                            }
                        }
                    }

                    // Forward to CEA-708 bridge and encoder with polished text (English only)
                    forwardToCea708(polishedData);
                    feedCaptionToEncoder(polishedData);

                    // Also POST to YouTube's caption ingestion URL if configured.
                    // This is the only working path for captions to reach YouTube
                    // when streaming through a Blackmagic Web Presenter (its
                    // RTMP encoder doesn't forward SDI VANC CC into H.264 SEI).
                    {
                        const polishedText = (typeof polishedData.payload === 'string')
                            ? polishedData.payload
                            : (polishedData.payload?.text || '');
                        if (polishedText) forwardToYouTube(polishedText);
                    }
                });
                return; // Don't fall through to unpolished broadcast
            }
        }

        // Interim captions and settings: broadcast without polishing
        const clients = sessions.get(currentSessionId);
        clients.forEach(client => {
          if (client !== ws && client.readyState === 1) {
            client.send(JSON.stringify(data));
          }
        });

        // Forward interim captions to CEA-708 bridge (interims are filtered in feedCaptionToEncoder)
        if (data.type === 'caption') {
            forwardToCea708(data);
        }
      }

      // Handle explicit CEA-708 clear command from frontend
      if (data.type === 'cea708_clear') {
          forwardToCea708(data);
          feedCaptionToEncoder(data);
      }
    } catch (e) {
      console.error("Parse error", e);
    }
  });

  ws.on('close', () => {
    if (clientRole === 'audience') {
        audienceCount = Math.max(0, audienceCount - 1);
        console.log(`[Audience] Disconnected (${audienceCount} total)`);
    }
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

// Auto-retry on port conflict — try up to 10 ports so the app always launches
let actualPort = parseInt(PORT);
const maxRetries = 10;
let retryCount = 0;

function startServer() {
  server.listen(actualPort, '0.0.0.0');
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && retryCount < maxRetries) {
    retryCount++;
    actualPort++;
    console.warn(`[Port] ${actualPort - 1} in use, trying ${actualPort}...`);
    startServer();
  } else if (e.code === 'EADDRINUSE') {
    const msg = `Ports ${PORT}-${actualPort} are all in use. Close other applications using these ports and try again.`;
    console.error('\n\x1b[31m%s\x1b[0m', '-------------------------------------------------------');
    console.error('\x1b[31m%s\x1b[0m', `❌ ERROR: ${msg}`);
    console.error('\x1b[31m%s\x1b[0m', '-------------------------------------------------------');
    // Throw so the launcher's uncaughtException handler can show a native dialog
    throw new Error(msg);
  } else {
    console.error('Server error:', e);
  }
});

server.on('listening', async () => {
  const isProd = process.env.NODE_ENV === 'production';

  if (actualPort !== parseInt(PORT)) {
    console.log(`\n⚠️  Port ${PORT} was busy — running on port ${actualPort} instead`);
    PORT = actualPort; // Update so all API endpoints use the correct port
  }

  // Signal to launcher that server is ready to accept connections
  console.log(`__SERVER_READY__ http://localhost:${actualPort}`);

  console.log('\n' + '\x1b[32m%s\x1b[0m', '='.repeat(50));
  console.log('\x1b[32m%s\x1b[0m', `🚀 Server started successfully!`);
  console.log('\x1b[32m%s\x1b[0m', '='.repeat(50));
  console.log(`\n📍 Local:   \x1b[36mhttp://localhost:${actualPort}\x1b[0m`);
  console.log(`📍 Network: \x1b[36mhttp://${localIP}:${actualPort}\x1b[0m`);
  console.log(`📍 CEA-708: \x1b[36mws://${localIP}:${actualPort}/cea708\x1b[0m (SDI Bridge Endpoint)`);
  
  // Skip tunnels ONLY on real cloud hosts (Cloud Run, Heroku, Railway, etc.)
  // Standalone .exe and local dev both need tunnels for audience phone access
  const isCloudHost = !!(process.env.K_SERVICE || process.env.DYNO || process.env.RAILWAY_ENVIRONMENT || process.env.RENDER);
  if (!isCloudHost) {
      // 1. Primary Tunnel (Cloudflare Quick Tunnel — no password, no interstitial)
      try {
          console.log("\n🌐 Initializing Cloudflare Tunnel...");

          // Determine binary path — use a persistent location outside node_modules
          const cloudflaredDir = path.join(os.homedir(), '.community-captioner');
          const cloudflaredBin = path.join(cloudflaredDir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');

          // Download cloudflared binary if not already present
          if (!fs.existsSync(cloudflaredBin)) {
              fs.mkdirSync(cloudflaredDir, { recursive: true });
              console.log("   Downloading cloudflared binary (one-time)...");
              await installCloudflared(cloudflaredBin);
          }

          // Start the tunnel
          const tunnelUrl = await new Promise((resolve, reject) => {
              // --config with empty file prevents cloudflared from loading ~/.cloudflared/config.yml
              // which may contain named tunnel routes that override the --url flag
              const emptyConfigPath = path.join(cloudflaredDir, 'empty-config.yml');
              if (!fs.existsSync(emptyConfigPath)) fs.writeFileSync(emptyConfigPath, '# empty config for quick tunnel\n');
              const child = spawn(cloudflaredBin, ['tunnel', '--url', `http://localhost:${PORT}`, '--no-autoupdate', '--config', emptyConfigPath]);
              let resolved = false;

              const timeout = setTimeout(() => {
                  if (!resolved) { resolved = true; reject(new Error('Tunnel startup timed out (30s)')); }
              }, 30000);

              const handleOutput = (data) => {
                  const text = data.toString();
                  const urlMatch = text.match(/https:\/\/[^\s]+\.trycloudflare\.com/);
                  if (urlMatch && !resolved) {
                      resolved = true;
                      clearTimeout(timeout);
                      resolve(urlMatch[0]);
                  }
              };

              child.stdout.on('data', handleOutput);
              child.stderr.on('data', handleOutput);
              child.on('error', (err) => { if (!resolved) { resolved = true; clearTimeout(timeout); reject(err); } });

              // Cleanup on exit
              const cleanup = () => { try { child.kill(); } catch(e){} };
              process.on('exit', cleanup);
              process.on('SIGINT', () => { cleanup(); process.exit(); });
          });

          publicTunnelUrl = tunnelUrl;
          console.log(`📍 Public:  \x1b[35m${publicTunnelUrl}\x1b[0m (No password needed)`);

      } catch (err) {
          console.warn("[Tunnel] Cloudflare tunnel failed:", err.message);
      }

      // 2. Backup Tunnel (SSH to localhost.run) - No password required
      try {
          console.log("\n🌐 Initializing Backup Tunnel (localhost.run)...");
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
              }
          };

          ssh.stdout.on('data', handleOutput);
          ssh.stderr.on('data', handleOutput);

          // Cleanup SSH process on exit
          const cleanup = () => { try { ssh.kill(); } catch(e){} };
          process.on('exit', cleanup);
          process.on('SIGINT', () => { cleanup(); process.exit(); });

      } catch (e) {
          console.log("   (Backup tunnel skipped: SSH not available)");
      }
  }
  
  console.log(`\n(Press Ctrl+C to stop)`);
});

// Kick off the server
startServer();