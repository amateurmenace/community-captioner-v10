import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import localtunnel from 'localtunnel';
import { spawn } from 'child_process';
import { polish, localPolish, summarize, truncateAtWord, setApiKey as setPolisherApiKey, toggleGemini as togglePolisherGemini, getStatus as getPolisherStatus } from './caption-polisher.js';
import { feedText as learnerFeedText, setApiKey as setLearnerApiKey, setEnabled as setLearnerEnabled, getSuggestions, acceptSuggestion, dismissSuggestion, setDictionary as setLearnerDictionary, getDictionary as getLearnerDictionary, extractDictionary, generateMishearings, getStatus as getLearnerStatus } from './context-learner.js';
import { translateCaption, setApiKey as setTranslationApiKey, getSupportedLanguages, getCacheStats as getTranslationStats } from './translation-service.js';
import { createRequire as _cr } from 'module';
const _require = _cr(import.meta.url);
let multer, pdfParse;
try { multer = _require('multer'); } catch { multer = null; }
try { pdfParse = _require('pdf-parse'); } catch { pdfParse = null; }

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
const server = createServer(app);

// CLOUD FIX: Use the environment variable PORT if available, otherwise default to 8080
const PORT = process.env.PORT || 8080;
let publicTunnelUrl = null;
let backupTunnelUrl = null;
let tunnelPassword = null;

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
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, X-Api-Key");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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

// Load Gemini API key from .env.local if available
try {
    const envPath = path.join(__dirname, '../.env.local');
    if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf-8');
        const match = envContent.match(/GEMINI_API_KEY=(.+)/);
        if (match && match[1] && match[1] !== 'PLACEHOLDER_API_KEY') {
            const key = match[1].trim();
            setPolisherApiKey(key);
            setLearnerApiKey(key);
            setTranslationApiKey(key);
            console.log('[Config] Gemini API key loaded from .env.local');
        }
    }
} catch (e) {}

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
    console.warn('[DeckLink] Native addon not available:', e.message);
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
                // Feed to background learner (non-blocking)
                learnerFeedText(processed);
            }
        })();
    } else if (captionData.type === 'cea708_clear') {
        if (cea608Encoder) cea608Encoder.enqueueClear();
        if (dtvccEncoder) dtvccEncoder.enqueueClear();
    }
}

// --- DeckLink REST API ---
app.get('/api/decklink/devices', (req, res) => {
    if (!decklink) {
        return res.json({ available: false, devices: [], error: 'DeckLink addon not loaded' });
    }
    try {
        const raw = decklink.enumerateDevices();
        res.json({ available: true, devices: raw });
    } catch (e) {
        res.json({ available: false, devices: [], error: e.message });
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
app.get('/api/polisher/status', (req, res) => {
    res.json(getPolisherStatus());
});

app.post('/api/polisher/toggle', (req, res) => {
    const enabled = togglePolisherGemini();
    res.json({ geminiEnabled: enabled });
});

app.post('/api/polisher/apikey', (req, res) => {
    const { key } = req.body;
    setPolisherApiKey(key);
    setLearnerApiKey(key);
    setTranslationApiKey(key);
    res.json({ ok: true });
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
    const { dictionary } = req.body;
    if (Array.isArray(dictionary)) {
        setLearnerDictionary(dictionary);
        res.json({ ok: true, size: dictionary.length });
    } else {
        res.status(400).json({ ok: false, error: 'dictionary must be an array' });
    }
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

// Server-side URL scraping with SPA fallback
// For static pages: fetch HTML, strip tags, extract.
// For SPA/dynamic pages (like CivicClerk): if HTML has little text content,
// use Gemini to extract content directly from the URL.
app.post('/api/context/scrape', async (req, res) => {
    const { url, apiKey: bodyKey } = req.body;
    if (!url) return res.status(400).json({ ok: false, error: 'url required' });
    const apiKey = bodyKey || req.headers['x-api-key'] || null;
    if (apiKey) { setPolisherApiKey(apiKey); setLearnerApiKey(apiKey); }

    try {
        console.log(`[Context] Scraping URL: ${url}`);

        // First, try fetching and checking if it's a PDF
        const response = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Community Captioner' },
            signal: AbortSignal.timeout(15000),
            redirect: 'follow',
        });

        if (!response.ok) {
            return res.status(502).json({ ok: false, error: `HTTP ${response.status} from ${url}` });
        }

        const contentType = response.headers.get('content-type') || '';

        // Handle PDF responses directly
        if (contentType.includes('application/pdf') && pdfParse) {
            const buffer = Buffer.from(await response.arrayBuffer());
            const pdf = await pdfParse(buffer);
            const text = pdf.text?.trim();
            if (text && text.length > 20) {
                const entries = await extractDictionary(text, apiKey);
                console.log(`[Context] Scraped PDF from ${url}: ${text.length} chars → ${entries.length} entries`);
                return res.json({ ok: true, entries, textLength: text.length, source: 'pdf' });
            }
        }

        const html = await response.text();
        // Strip HTML to text
        let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                       .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                       .replace(/<[^>]+>/g, ' ')
                       .replace(/&nbsp;/g, ' ')
                       .replace(/&amp;/g, '&')
                       .replace(/&lt;/g, '<')
                       .replace(/&gt;/g, '>')
                       .replace(/\s+/g, ' ')
                       .trim();

        // If we got meaningful text from HTML, use it
        if (text.length > 200) {
            const entries = await extractDictionary(text, apiKey);
            console.log(`[Context] Scraped HTML from ${url}: ${text.length} chars → ${entries.length} entries`);
            return res.json({ ok: true, entries, textLength: text.length, source: 'html' });
        }

        // SPA/dynamic page fallback: ask Gemini to visit the URL and extract content
        console.log(`[Context] Page has little static content (${text.length} chars), using Gemini URL extraction`);
        const geminiKey = getLearnerStatus().geminiKeySet ? null : null; // Key is in the learner module
        // Use extractDictionary with a prompt that includes the URL
        const urlContext = `This is a meeting agenda page at ${url}. The page is dynamically rendered. Based on the URL pattern (CivicClerk municipal portal), this likely contains a government meeting agenda with names of officials, committee members, and agenda items. Extract proper nouns, names, places, and acronyms that a speech-to-text engine might misspell during a live broadcast of this meeting.`;
        const entries = await extractDictionary(urlContext, apiKey);
        if (entries.length > 0) {
            console.log(`[Context] Gemini URL extraction for ${url}: ${entries.length} entries`);
            return res.json({ ok: true, entries, textLength: 0, source: 'gemini_url', warning: 'Dynamic page — used AI to infer context from URL pattern' });
        }

        res.json({ ok: true, entries: [], warning: 'Could not extract content from this page. Try uploading the agenda as a PDF instead.' });
    } catch (e) {
        console.warn(`[Context] Scrape error: ${e.message}`);
        res.status(500).json({ ok: false, error: e.message });
    }
});

// Discover links from a web page (for municipality wizard)
app.post('/api/context/discover-links', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ ok: false, error: 'url required' });

    try {
        const response = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Community Captioner' },
            signal: AbortSignal.timeout(10000),
            redirect: 'follow',
        });
        if (!response.ok) return res.json({ ok: false, error: `HTTP ${response.status}` });

        const html = await response.text();
        const baseUrl = new URL(url);

        // Extract all <a href="..."> links with their text
        const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
        const links = [];
        const seenUrls = new Set();
        let match;

        // Keywords that indicate pages with useful proper nouns
        const usefulPatterns = /official|elected|council|mayor|select.?board|alderm|government|department|staff|directory|agenda|minute|meeting|committee|commission|board|advisory|planning|zoning|finance|police|fire|school|library|park|public.?works/i;

        while ((match = linkRegex.exec(html)) !== null) {
            let href = match[1].trim();
            const text = match[2].replace(/<[^>]+>/g, '').trim();
            if (!text || text.length < 3 || text.length > 100) continue;
            if (href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) continue;

            // Resolve relative URLs
            try {
                const resolved = new URL(href, url);
                // Only keep same-domain links
                if (resolved.hostname !== baseUrl.hostname) continue;
                href = resolved.href;
            } catch { continue; }

            if (seenUrls.has(href)) continue;
            seenUrls.add(href);

            // Score relevance
            const combined = (text + ' ' + href).toLowerCase();
            if (usefulPatterns.test(combined)) {
                let type = 'General';
                if (/official|elected|council|mayor|select.?board|alderm|government/i.test(combined)) type = 'Officials';
                else if (/agenda|minute|meeting|calendar/i.test(combined)) type = 'Meetings';
                else if (/department|staff|directory|contact/i.test(combined)) type = 'Departments';
                else if (/committee|commission|board|advisory|planning|zoning/i.test(combined)) type = 'Committees';

                links.push({ title: text, url: href, type, why: `Link found on ${baseUrl.hostname}` });
            }
        }

        console.log(`[Context] Discovered ${links.length} relevant links from ${url}`);
        res.json({ ok: true, links, total: seenUrls.size });
    } catch (e) {
        res.json({ ok: false, error: e.message, links: [] });
    }
});

// PDF file upload endpoint
const upload = multer ? multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } }) : null;

if (upload) {
    app.post('/api/context/upload-pdf', upload.single('file'), async (req, res) => {
        if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded' });

        // Accept API key from header for extraction
        const apiKey = req.headers['x-api-key'] || null;
        if (apiKey) { setPolisherApiKey(apiKey); setLearnerApiKey(apiKey); }

        try {
            const contentType = req.file.mimetype || '';
            let text = '';

            if (contentType.includes('pdf') && pdfParse) {
                const pdf = await pdfParse(req.file.buffer);
                text = pdf.text?.trim() || '';
            } else {
                // Treat as plain text
                text = req.file.buffer.toString('utf-8').trim();
            }

            if (!text || text.length < 20) {
                return res.json({ ok: true, entries: [], warning: 'Could not extract text from file' });
            }

            console.log(`[Context] Upload PDF: ${req.file.originalname}, ${text.length} chars, apiKey present: ${!!apiKey}, key length: ${apiKey?.length || 0}`);

            // Check if we have a usable API key
            if (!apiKey || apiKey === 'PLACEHOLDER_API_KEY' || apiKey.length < 10) {
                console.warn(`[Context] No valid Gemini API key for extraction`);

                // Fall back to local regex extraction (no AI)
                const localEntries = extractProperNounsLocally(text);
                if (localEntries.length > 0) {
                    console.log(`[Context] Local extraction found ${localEntries.length} entries (no API key)`);
                    return res.json({ ok: true, entries: localEntries, textLength: text.length, filename: req.file.originalname, warning: 'Using basic extraction (no Gemini API key). Add an API key in Output Settings for better results.' });
                }
                return res.json({ ok: true, entries: [], warning: 'No Gemini API key set. Add your key in Output Settings → Caption Processing to enable AI extraction.' });
            }

            const entries = await extractDictionary(text, apiKey);
            console.log(`[Context] Uploaded ${req.file.originalname}: ${text.length} chars → ${entries.length} entries`);

            // If Gemini returned nothing, fall back to local extraction
            if (entries.length === 0) {
                const localEntries = extractProperNounsLocally(text);
                if (localEntries.length > 0) {
                    console.log(`[Context] Gemini returned 0, local fallback found ${localEntries.length}`);
                    return res.json({ ok: true, entries: localEntries, textLength: text.length, filename: req.file.originalname, warning: 'AI extraction returned no results. Using basic extraction instead.' });
                }
            }

            res.json({ ok: true, entries, textLength: text.length, filename: req.file.originalname });
        } catch (e) {
            console.warn(`[Context] PDF parse error: ${e.message}`);
            res.status(500).json({ ok: false, error: e.message });
        }
    });
}

// Quick Names — generate STT mishearing entries from a list of names/terms
app.post('/api/context/names', async (req, res) => {
    const { names, apiKey: bodyKey } = req.body;
    if (!names || !Array.isArray(names) || names.length === 0) {
        return res.status(400).json({ ok: false, error: 'names array required' });
    }
    const extractKey = bodyKey || req.headers['x-api-key'] || null;
    if (extractKey) { setPolisherApiKey(extractKey); setLearnerApiKey(extractKey); }

    try {
        const entries = await generateMishearings(names.slice(0, 50), extractKey);
        console.log(`[Context] Quick Names: ${names.length} names → ${entries.length} entries`);
        res.json({ ok: true, entries });
    } catch (e) {
        console.warn('[Context] Quick Names error:', e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
});

// Plain text / paste extraction
app.post('/api/context/extract', async (req, res) => {
    const { text, apiKey: bodyKey } = req.body;
    if (!text) return res.status(400).json({ ok: false, error: 'text required' });
    const extractKey = bodyKey || req.headers['x-api-key'] || null;
    if (extractKey) { setPolisherApiKey(extractKey); setLearnerApiKey(extractKey); }

    const entries = await extractDictionary(text, extractKey);
    res.json({ ok: true, entries });
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
        tunnelPassword: tunnelPassword,
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
              tunnelPassword = data.ip;
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