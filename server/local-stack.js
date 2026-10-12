/**
 * Local AI stack manager — lets the relay (which runs on the operator's own
 * machine) probe, install, launch and monitor the local speech server and
 * talk to Ollama, so the Local Setup wizard can guide people with real
 * feedback instead of pasted scripts.
 *
 *   probeSystem()                 platform, CPU/RAM/GPU, Python & uv, Ollama, speech server
 *   recommend(info)               which backend/model to suggest for this machine
 *   startWhisper(opts)            spawn local/whisper_server.py via uv or a venv
 *   stopWhisper()
 *   getWhisperStatus()            {state, message, model, ..., logs}
 *   subscribeLogs(fn)             live log/status events (SSE)
 *   ollama*()                     tags / pull (streamed) / test / start
 */

import { spawn, execFile } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import net from 'net';
// The `ws` client is used (not the global WebSocket) because packaged builds run
// on Node 20, which has no global WebSocket.
import { WebSocket as WsClient } from 'ws';
import { DATA_DIR } from './context-learner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const IS_APPLE_SILICON = IS_MAC && process.arch === 'arm64';

export const LOCAL_DIR = join(DATA_DIR, 'local');
const SCRIPT_NAME = 'whisper_server.py';

// Model catalogue shown by the wizard (mirrors MODELS in local/whisper_server.py)
export const WHISPER_MODELS = [
    { name: 'large-v3-turbo', label: 'Whisper large-v3-turbo', downloadMB: 1600, englishOnly: false, tier: 'best',
      desc: 'Near large-v3 accuracy at 8x the speed. Multilingual. The default for Apple Silicon and NVIDIA GPUs.' },
    { name: 'distil-large-v3', label: 'Distil-Whisper large-v3', downloadMB: 1500, englishOnly: true, tier: 'best',
      desc: 'English-only distillation of large-v3: about 2x faster than turbo on CPU with similar accuracy.' },
    { name: 'small.en', label: 'Whisper small (English)', downloadMB: 480, englishOnly: true, tier: 'light',
      desc: 'Lightest model that still gives usable meeting captions. Real-time on most CPUs.' },
    { name: 'base.en', label: 'Whisper base (English)', downloadMB: 145, englishOnly: true, tier: 'light',
      desc: 'Very light. Rougher accuracy; fine for testing the pipeline or very old machines.' },
    { name: 'medium.en', label: 'Whisper medium (English)', downloadMB: 1500, englishOnly: true, tier: 'other',
      desc: 'Older middle option. Prefer distil-large-v3 (faster and more accurate).' },
    { name: 'large-v3', label: 'Whisper large-v3', downloadMB: 3000, englishOnly: false, tier: 'other',
      desc: 'Highest accuracy, slowest. Only real-time with a GPU.' },
];

// Ollama models for the Context Engine's local extraction (JSON output matters).
// `tested` = verified with the app's real extraction prompt (see local-llm.js
// testOllamaExtraction) on 2026-10-12; `tier` drives the recommendation badge.
// Measured on an M1 Max with the sample agenda (warm model): recall of six known
// names / time to answer.
// Measured 2026-10-12 on an M1 Max (32 GB) with the app's own test: the real extraction
// prompt on a sample Select Board agenda, graded on recall of six known names, warm model.
// Newer is not automatically better, and Ollama's "-mlx" tags (Apple Silicon builds) were
// both LARGER downloads and WORSE on this test (gemma4:e4b-mlx 67% vs gemma4:e4b 100%,
// qwen3.5:4b-mlx 33%), so the catalog sticks to the standard tags on every platform.
export const OLLAMA_MODELS = [
    { name: 'gemma4:e2b',  label: 'Gemma 4 E2B',   sizeGB: 4.6, minRamGB: 8,  tier: 'light', tested: true,  desc: 'Best on every axis in our agenda test: found all six known names (100%), fastest (about 5 s), and runs on an 8 GB machine. Google\'s newest small model. Start here.' },
    { name: 'gemma4:e4b',  label: 'Gemma 4 E4B',   sizeGB: 6.6, minRamGB: 16, tier: 'best',  tested: true,  desc: 'Same 100% recall and a few more names than E2B, but about 3x slower (~14 s per agenda) and the best of the small models at translating into less common languages (Haitian Creole). Needs 16 GB RAM.' },
    { name: 'gemma3:4b',   label: 'Gemma 3 4B',    sizeGB: 3.3, minRamGB: 8,  tier: 'light', tested: true,  desc: 'Previous recommendation, still solid: 83% of known names in about 8 s. Smaller download than Gemma 4 E2B; pick it if disk space is tight.' },
    { name: 'gemma3:12b',  label: 'Gemma 3 12B',   sizeGB: 8.2, minRamGB: 24, tier: 'other', tested: true,  desc: 'Thorough but slow: 83% with a third more names than Gemma 3 4B, ~30 s per agenda. Gemma 4 E4B now does better in half the time.' },
    { name: 'qwen3.5:4b',  label: 'Qwen 3.5 4B',   sizeGB: 3.3, minRamGB: 8,  tier: 'other', tested: true,  desc: 'Not recommended for the Context Engine: on our test it returned acronyms and last names but missed most people (17%). Fine for translation.' },
    { name: 'qwen3:4b',    label: 'Qwen3 4B',      sizeGB: 2.5, minRamGB: 8,  tier: 'other', tested: true,  desc: 'Smallest download. Finds most names (67%, ~14 s) but tends to include meeting times and room numbers.' },
    { name: 'llama3.1:8b', label: 'Llama 3.1 8B',  sizeGB: 4.9, minRamGB: 16, tier: 'other', tested: true,  desc: 'Older but dependable (67%, ~30 s). Fine if you already have it installed.' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run(cmd, args, { timeout = 4000, env } = {}) {
    return new Promise((resolve) => {
        try {
            execFile(cmd, args, { timeout, windowsHide: true, env: env || process.env, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
                resolve({ ok: !err, code: err?.code, stdout: String(stdout || ''), stderr: String(stderr || '') });
            });
        } catch (e) {
            resolve({ ok: false, code: -1, stdout: '', stderr: e.message });
        }
    });
}

function portOpen(port, host = '127.0.0.1', timeout = 800) {
    return new Promise((resolve) => {
        const sock = new net.Socket();
        let done = false;
        const finish = (v) => { if (!done) { done = true; try { sock.destroy(); } catch {} resolve(v); } };
        sock.setTimeout(timeout);
        sock.once('connect', () => finish(true));
        sock.once('timeout', () => finish(false));
        sock.once('error', () => finish(false));
        sock.connect(port, host);
    });
}

async function fetchJson(url, opts = {}, timeoutMs = 3000) {
    const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

/** Where to find the bundled server script: dev tree, pkg snapshot, or Mac Resources. */
export function findScriptSource() {
    const candidates = [
        join(__dirname, '..', 'local', SCRIPT_NAME),
        join(__dirname, 'local', SCRIPT_NAME),
        process.env.DIST_PATH ? join(dirname(process.env.DIST_PATH), 'local', SCRIPT_NAME) : null,
        join(dirname(process.execPath), 'local', SCRIPT_NAME),
    ].filter(Boolean);
    for (const c of candidates) { try { if (existsSync(c)) return c; } catch {} }
    return null;
}

export function readScript() {
    const src = findScriptSource();
    if (!src) throw new Error('whisper_server.py not found in this build');
    return readFileSync(src, 'utf-8');
}

// ---------------------------------------------------------------------------
// System probe
// ---------------------------------------------------------------------------

let probeCache = { at: 0, value: null };

async function detectPython() {
    const candidates = IS_WIN
        ? [['py', ['-3.13']], ['py', ['-3.12']], ['py', ['-3.11']], ['py', ['-3.10']], ['python', []], ['python3', []]]
        : [['python3.13', []], ['python3.12', []], ['python3.11', []], ['python3.10', []], ['python3', []]];
    const found = [];
    const seenVersions = new Set();
    for (const [cmd, pre] of candidates) {
        const r = await run(cmd, [...pre, '--version'], { timeout: 3000 });
        const m = (r.stdout + r.stderr).match(/Python (\d+)\.(\d+)\.(\d+)/);
        if (!r.ok || !m) continue;
        const version = `${m[1]}.${m[2]}.${m[3]}`;
        if (seenVersions.has(version)) continue;
        seenVersions.add(version);
        const minor = parseInt(m[2]);
        found.push({
            cmd, args: pre, version,
            ok: parseInt(m[1]) === 3 && minor >= 9 && minor <= 13,
            note: minor > 13 ? 'newer than the prebuilt speech libraries support; a 3.10–3.13 interpreter (or uv) is preferred' : minor < 9 ? 'too old' : '',
        });
    }
    // Prefer 3.12/3.13, then 3.11, 3.10; only fall back to others if nothing else
    const rank = (p) => { const mi = parseInt(p.version.split('.')[1]); return p.ok ? (mi === 12 ? 0 : mi === 13 ? 1 : mi === 11 ? 2 : 3) : 9; };
    found.sort((a, b) => rank(a) - rank(b));
    return found;
}

function uvCandidates() {
    const home = os.homedir();
    return IS_WIN
        ? [join(home, '.local', 'bin', 'uv.exe'), join(home, '.cargo', 'bin', 'uv.exe'), 'uv']
        : [join(home, '.local', 'bin', 'uv'), join(home, '.cargo', 'bin', 'uv'), '/opt/homebrew/bin/uv', '/usr/local/bin/uv', 'uv'];
}

async function detectUv() {
    for (const c of uvCandidates()) {
        const r = await run(c, ['--version'], { timeout: 3000 });
        if (r.ok) return { installed: true, path: c, version: r.stdout.trim() };
    }
    return { installed: false };
}

async function detectGpu() {
    if (IS_APPLE_SILICON) {
        const r = await run('sysctl', ['-n', 'machdep.cpu.brand_string'], { timeout: 2000 });
        return { type: 'apple', name: r.stdout.trim() || 'Apple Silicon' };
    }
    const r = await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader'], { timeout: 4000 });
    if (r.ok && r.stdout.trim()) {
        const [name, mem] = r.stdout.trim().split('\n')[0].split(',').map(s => s.trim());
        const mib = parseFloat(mem);
        // faster-whisper's Windows wheel ships cuDNN but not cuBLAS: without the CUDA 12
        // runtime the speech server falls back to the CPU, so the recommendation should too.
        const cudaRuntime = IS_WIN ? cublasOnPath() : null;
        return { type: 'nvidia', name, memory: mem, memoryGB: Number.isFinite(mib) ? +(mib / 1024).toFixed(1) : null, cudaRuntime };
    }
    return { type: 'none' };
}

function cublasOnPath() {
    const dirs = (process.env.PATH || '').split(';');
    if (process.env.CUDA_PATH) dirs.push(join(process.env.CUDA_PATH, 'bin'));
    return dirs.some(d => { try { return !!d && existsSync(join(d, 'cublas64_12.dll')); } catch { return false; } });
}

async function detectOllama(baseUrl = 'http://127.0.0.1:11434') {
    const which = await run(IS_WIN ? 'where' : 'which', ['ollama'], { timeout: 3000 });
    let installed = which.ok && which.stdout.trim().length > 0;
    if (!installed && IS_MAC) installed = existsSync('/Applications/Ollama.app') || existsSync('/usr/local/bin/ollama') || existsSync('/opt/homebrew/bin/ollama');
    if (!installed && IS_WIN) installed = existsSync(join(os.homedir(), 'AppData', 'Local', 'Programs', 'Ollama', 'ollama.exe'));
    let running = false, models = [], version = null;
    try {
        const tags = await fetchJson(`${baseUrl}/api/tags`, {}, 2500);
        running = true;
        installed = true;
        models = (tags.models || []).map(m => ({ name: m.name, sizeGB: m.size ? +(m.size / 1e9).toFixed(1) : null, modifiedAt: m.modified_at, family: m.details?.family, parameterSize: m.details?.parameter_size }));
        try { version = (await fetchJson(`${baseUrl}/api/version`, {}, 1500)).version || null; } catch {}
    } catch {}
    return { installed, running, models, version, url: baseUrl };
}

/** Version of the speech server script we ship (SCRIPT_VERSION in whisper_server.py). */
export function bundledScriptVersion() {
    try { const m = readScript().match(/^SCRIPT_VERSION\s*=\s*(\d+)/m); return m ? +m[1] : 0; } catch { return 0; }
}

async function detectWhisper(port = 9000) {
    const running = await portOpen(port);
    const managed = !!whisperProc && whisperState.state !== 'stopped';
    let hello = null;
    if (running) hello = await readHello(`ws://127.0.0.1:${port}`).catch(() => null);
    const bundledVersion = bundledScriptVersion();
    const serverVersion = hello && typeof hello.scriptVersion === 'number' ? hello.scriptVersion : (hello ? 1 : null);
    // An older copy of our own script (or a legacy server) is still listening: the app
    // can replace it so the operator gets the current captioning behaviour.
    const outdated = running && !managed && !!hello && serverVersion != null && serverVersion < bundledVersion;
    const saved = loadWhisperConfig();
    return { running, managed, hello, url: `ws://127.0.0.1:${port}`, port, bundledVersion, serverVersion, outdated, configured: !!saved, savedModel: saved?.model || null };
}

/** Kill whatever is listening on the speech-server port (used to replace a stale server). */
export async function killPortListener(port = 9000) {
    let pids = [];
    if (process.platform === 'win32') {
        const r = await run('netstat', ['-ano', '-p', 'tcp'], { timeout: 5000 });
        for (const line of r.stdout.split('\n')) {
            const m = line.trim().match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
            if (m && +m[1] === port && +m[2] !== process.pid) pids.push(+m[2]);
        }
        // TerminateProcess on the listener directly (process.kill is forceful on Windows).
        // taskkill enumerates every process first, which took 45–50 s on the busy Windows
        // test rig, far past any reasonable timeout; it stays below as a fallback.
        for (const pid of pids) { try { process.kill(pid); } catch {} }
    } else {
        const r = await run('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { timeout: 5000 });
        pids = r.stdout.split('\n').map(x => +x.trim()).filter(n => n > 0 && n !== process.pid);
        for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    }
    for (let i = 0; i < 30 && await portOpen(port); i++) {
        if (i === 15 && process.platform !== 'win32') for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
        await new Promise(r => setTimeout(r, 200));
    }
    if (process.platform === 'win32' && pids.length && await portOpen(port)) {
        for (const pid of pids) await run('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 90000 });
        for (let i = 0; i < 15 && await portOpen(port); i++) await new Promise(r => setTimeout(r, 200));
    }
    invalidateProbe();
    return { killed: pids, freed: !(await portOpen(port)) };
}

/** Connect to a speech server and return its hello message (null for legacy servers). */
export function readHello(url, timeoutMs = 2500) {
    return new Promise((resolve, reject) => {
        let ws;
        try { ws = new WsClient(url, { handshakeTimeout: timeoutMs }); } catch (e) { return reject(e); }
        let settled = false;
        const finish = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); try { ws.close(); } catch {} fn(v); };
        const timer = setTimeout(() => finish(resolve, null), timeoutMs);
        ws.on('message', (data) => {
            try {
                const d = JSON.parse(data.toString());
                if (d.type === 'hello') finish(resolve, d);
            } catch {}
        });
        ws.on('error', (e) => finish(reject, new Error(e?.message || 'connection failed')));
        ws.on('close', () => finish(resolve, null));
    });
}

export function recommend(info) {
    const ram = info.memoryGB || 8;
    if (info.gpu?.type === 'apple') {
        if (ram >= 16) return { backend: 'mlx', model: 'large-v3-turbo', compute: 'mlx', reason: `Apple Silicon with ${ram} GB: the GPU runs large-v3-turbo comfortably in real time.` };
        return { backend: 'mlx', model: 'distil-large-v3', compute: 'mlx', reason: `Apple Silicon with ${ram} GB: distil-large-v3 keeps memory low while staying accurate (English only).` };
    }
    let gpuNote = '';
    if (info.gpu?.type === 'nvidia') {
        const name = info.gpu.name || 'GPU';
        if (info.gpu.cudaRuntime === false) gpuNote = `NVIDIA ${name} found, but the CUDA 12 runtime (cuBLAS) isn't installed, so speech runs on the CPU. `;
        else if (info.gpu.memoryGB != null && info.gpu.memoryGB < 4) gpuNote = `NVIDIA ${name} has only ${info.gpu.memoryGB} GB of memory, too little for the GPU models, so speech runs on the CPU. `;
        else return { backend: 'faster-whisper', model: 'large-v3-turbo', compute: 'float16', reason: `NVIDIA ${name} detected: large-v3-turbo in float16 runs well ahead of real time.` };
    }
    // On a CPU every caption pays for Whisper's full 30 s encoder pass, so the large-encoder models
    // fall behind even on big machines: measured on a 24-core Xeon Gold 6342 (12 threads, int8),
    // one 4 s sentence took small.en 0.95 s, distil-large-v3 3.5 s, large-v3-turbo 3.6 s.
    const cores = info.cpuCores || 4;
    return { backend: 'faster-whisper', model: 'small.en', compute: 'int8', reason: `${gpuNote || 'No usable GPU: '}small.en (int8) keeps up in real time on a ${cores}-core CPU (about 1 s per caption). The large models (distil-large-v3, turbo) take 3–4 s per caption without a GPU, so captions fall behind.` };
}

export async function probeSystem({ ollamaUrl, whisperPort } = {}) {
    if (probeCache.value && Date.now() - probeCache.at < 8000) return probeCache.value;
    const [python, uv, gpu, ollama, whisper] = await Promise.all([
        detectPython(), detectUv(), detectGpu(), detectOllama(ollamaUrl), detectWhisper(whisperPort || 9000),
    ]);
    const cpus = os.cpus();
    const info = {
        platform: process.platform, arch: process.arch,
        cpu: cpus[0]?.model || 'unknown', cpuCores: cpus.length,
        memoryGB: Math.round(os.totalmem() / 1073741824),
        gpu, python, uv, ollama, whisper,
        scriptBundled: !!findScriptSource(),
        dataDir: LOCAL_DIR,
        installCommands: {
            uv: IS_WIN ? 'powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"' : 'curl -LsSf https://astral.sh/uv/install.sh | sh',
            ollama: IS_MAC ? 'brew install ollama' : IS_WIN ? 'winget install Ollama.Ollama' : 'curl -fsSL https://ollama.com/install.sh | sh',
            ollamaServe: 'ollama serve',
        },
        downloads: {
            // Plain installers for people who don't use Homebrew / a terminal
            ollama: IS_MAC ? 'https://ollama.com/download/mac' : IS_WIN ? 'https://ollama.com/download/windows' : 'https://ollama.com/download/linux',
            python: 'https://www.python.org/downloads/',
            terminalHint: IS_MAC ? 'Open Terminal: press ⌘ Space, type Terminal, press Return, then paste the line.' : IS_WIN ? 'Open PowerShell: press the Windows key, type PowerShell, press Enter, then paste the line.' : 'Open a terminal and paste the line.',
        },
    };
    info.recommendation = recommend(info);
    info.canLaunch = !!(info.scriptBundled && (uv.installed || python.some(p => p.ok)));
    probeCache = { at: Date.now(), value: info };
    return info;
}

export function invalidateProbe() { probeCache = { at: 0, value: null }; }

// ---------------------------------------------------------------------------
// Speech server launcher
// ---------------------------------------------------------------------------

let whisperProc = null;
let whisperState = { state: 'stopped', message: 'Not running', model: null, backend: null, device: null, compute: null, url: null, pid: null, startedAt: null, runner: null, exitCode: null };
const logRing = [];
const LOG_MAX = 400;
const subscribers = new Set();

function emit(event) {
    for (const fn of subscribers) { try { fn(event); } catch {} }
}
function pushLog(line) {
    const entry = { t: Date.now(), line };
    logRing.push(entry);
    if (logRing.length > LOG_MAX) logRing.splice(0, logRing.length - LOG_MAX);
    emit({ type: 'log', ...entry });
}
function setState(patch) {
    whisperState = { ...whisperState, ...patch };
    emit({ type: 'status', ...whisperState });
}

export function subscribeLogs(fn) { subscribers.add(fn); return () => subscribers.delete(fn); }
export function getWhisperStatus() { return { ...whisperState, logs: logRing.slice(-80) }; }

const CONFIG_PATH = join(LOCAL_DIR, 'whisper.json');
let lastLaunchConfig = null;
export function loadWhisperConfig() {
    try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')); } catch { return null; }
}
function saveWhisperConfig(cfg) {
    try { mkdirSync(LOCAL_DIR, { recursive: true }); writeFileSync(CONFIG_PATH, JSON.stringify({ ...cfg, savedAt: Date.now() }, null, 2)); } catch {}
}

function handleScriptLine(line) {
    const m = line.match(/__WHISPER_STATUS__\s+(\{.*\})/);
    if (!m) { pushLog(line); return; }
    try {
        const s = JSON.parse(m[1]);
        if (s.state === 'loading') setState({ state: 'loading', message: s.message || `Loading ${s.model}…`, model: s.model, backend: s.backend, device: s.device, compute: s.compute });
        else if (s.state === 'ready') { setState({ state: 'ready', message: `Ready — ${s.model} on ${s.device}`, model: s.model, backend: s.backend, device: s.device, compute: s.compute, url: s.url, serverPid: s.pid || null }); if (lastLaunchConfig) saveWhisperConfig(lastLaunchConfig); }
        else if (s.state === 'error') setState({ state: 'error', message: s.message || 'Server error' });
        else if (s.state === 'starting') setState({ state: 'starting', message: `Python ${s.python} starting…` });
        pushLog(`[status] ${s.state}${s.message ? ': ' + s.message : ''}`);
    } catch { pushLog(line); }
}

function venvPython() {
    return IS_WIN ? join(LOCAL_DIR, 'venv', 'Scripts', 'python.exe') : join(LOCAL_DIR, 'venv', 'bin', 'python');
}

function spawnLogged(cmd, args, { env, cwd } = {}) {
    pushLog(`$ ${[cmd, ...args].join(' ')}`);
    const child = spawn(cmd, args, { cwd: cwd || LOCAL_DIR, env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', HF_HUB_DISABLE_PROGRESS_BARS: '0', ...(env || {}) }, windowsHide: true, shell: false });
    let buf = { out: '', err: '' };
    const onData = (key) => (chunk) => {
        buf[key] += chunk.toString();
        let idx;
        while ((idx = buf[key].search(/\r?\n|\r/)) >= 0) {
            const line = buf[key].slice(0, idx).trimEnd();
            buf[key] = buf[key].slice(idx + (buf[key][idx] === '\r' && buf[key][idx + 1] === '\n' ? 2 : 1));
            if (line.trim()) handleScriptLine(line);
        }
        // tqdm progress bars update with \r only; surface partial lines occasionally
        if (buf[key].length > 400) { handleScriptLine(buf[key].trim()); buf[key] = ''; }
    };
    child.stdout.on('data', onData('out'));
    child.stderr.on('data', onData('err'));
    return child;
}

function waitExit(child) {
    return new Promise((resolve) => { child.on('exit', (code) => resolve(code)); child.on('error', () => resolve(-1)); });
}

/**
 * Start the speech server. Steps: write the bundled script to DATA_DIR/local,
 * pick a runner (uv → ephemeral env; else venv + pip), install deps if needed,
 * spawn the server and track its status lines.
 */
export async function startWhisper({ model = 'large-v3-turbo', backend = 'auto', device = 'auto', compute = 'auto', language = 'en', port = 9000, interim = true, interimModel = 'auto', replaceExisting = false } = {}) {
    if (whisperProc && whisperState.state !== 'stopped' && whisperState.state !== 'error') {
        if (!replaceExisting) throw new Error(`Speech server is already ${whisperState.state}. Stop it first.`);
        await stopWhisper();
    }
    if (await portOpen(port)) {
        if (!replaceExisting) throw new Error(`Port ${port} is already in use (another speech server?). Stop it or pick another port.`);
        const k = await killPortListener(port);
        if (!k.freed) throw new Error(`Could not stop the server on port ${port} (pid ${k.killed.join(', ') || '?'}). Close it yourself and try again.`);
        pushLog(`Replaced the speech server that was listening on port ${port} (pid ${k.killed.join(', ') || '?'}).`);
    }
    mkdirSync(LOCAL_DIR, { recursive: true });
    const scriptPath = join(LOCAL_DIR, SCRIPT_NAME);
    writeFileSync(scriptPath, readScript(), 'utf-8');
    logRing.length = 0;
    lastLaunchConfig = { model, backend, device, compute, language, port, interim, interimModel };
    setState({ state: 'installing', message: 'Preparing Python environment…', model, backend, device, compute, url: null, pid: null, serverPid: null, startedAt: Date.now(), exitCode: null });

    const info = await probeSystem();
    const wantMlx = IS_APPLE_SILICON && (backend === 'auto' || backend === 'mlx');
    const pkgs = ['numpy', 'websockets', 'faster-whisper', ...(wantMlx ? ['mlx-whisper'] : [])];
    const serverArgs = [scriptPath, '--model', model, '--backend', backend, '--device', device, '--compute', compute, '--language', language, '--port', String(port), ...(interim ? [] : ['--no-interim']), ...(interimModel && interimModel !== 'auto' ? ['--interim-model', interimModel] : [])];
    // Windows without Developer Mode can't make symlinks; huggingface_hub copies instead and
    // otherwise prints a long warning that reads like an error in the wizard's log.
    const env = { HF_HOME: join(LOCAL_DIR, 'hf-cache'), HF_HUB_DISABLE_SYMLINKS_WARNING: '1' };

    let cmd, args, runner;
    if (info.uv.installed) {
        runner = 'uv';
        cmd = info.uv.path;
        args = ['run', '--python', '3.12', ...pkgs.flatMap(p => ['--with', p]), 'python', ...serverArgs];
        pushLog('Using uv (it creates and caches an isolated Python environment; the first run installs packages).');
    } else {
        const py = info.python.find(p => p.ok) || info.python[0];
        if (!py) {
            setState({ state: 'error', message: 'No Python found. Install uv (recommended) or Python 3.12 and try again.' });
            throw new Error('No Python interpreter found');
        }
        runner = 'venv';
        const vpy = venvPython();
        if (!existsSync(vpy)) {
            pushLog(`Creating virtual environment with ${py.cmd} ${py.version}…`);
            const c = spawnLogged(py.cmd, [...py.args, '-m', 'venv', join(LOCAL_DIR, 'venv')]);
            const code = await waitExit(c);
            if (code !== 0) { setState({ state: 'error', message: `Could not create a Python virtual environment (exit ${code})` }); throw new Error('venv failed'); }
        }
        // Only hit PyPI when something is missing: re-running pip on every start cost
        // seconds and, worse, failed outright on a machine without internet.
        const importCheck = await run(vpy, ['-c', `import ${['numpy', 'websockets', 'faster_whisper', ...(wantMlx ? ['mlx_whisper'] : [])].join(', ')}`], { timeout: 60000 });
        if (importCheck.ok) {
            pushLog('Speech packages already installed; skipping pip.');
        } else {
            setState({ state: 'installing', message: 'Installing speech packages (first time only, 1–3 minutes)…' });
            const pip = spawnLogged(vpy, ['-m', 'pip', 'install', '--disable-pip-version-check', '--upgrade', ...pkgs]);
            const pipCode = await waitExit(pip);
            if (pipCode !== 0) { setState({ state: 'error', message: `Package installation failed (exit ${pipCode}). See the log.${/Could not find a version|No matching distribution|Temporary failure|Connection|SSL/i.test(logRing.slice(-30).map(l => l.line).join('\n')) ? ' This looks like a network problem: the first install needs internet.' : ''}` }); throw new Error('pip failed'); }
        }
        cmd = vpy;
        args = serverArgs;
    }

    setState({ state: 'starting', message: runner === 'uv' ? 'Resolving packages and starting (first run downloads them)…' : 'Starting speech server…', runner });
    const child = spawnLogged(cmd, args, { env });
    whisperProc = child;
    setState({ pid: child.pid });
    child.on('error', (e) => { setState({ state: 'error', message: `Could not start: ${e.message}` }); whisperProc = null; });
    child.on('exit', (code) => {
        const wasReady = whisperState.state === 'ready';
        whisperProc = null;
        invalidateProbe();
        if (whisperState.state === 'stopping' || code === 0 || code === null) setState({ state: 'stopped', message: 'Speech server stopped', pid: null, serverPid: null, exitCode: code });
        else setState({ state: 'error', message: whisperState.state === 'error' ? whisperState.message : `Speech server exited with code ${code}${wasReady ? '' : ' before becoming ready'} — see the log`, pid: null, serverPid: null, exitCode: code });
    });
    invalidateProbe();
    return { ok: true, pid: child.pid, runner, command: [cmd, ...args].join(' ') };
}

export async function stopWhisper() {
    if (!whisperProc) { setState({ state: 'stopped', message: 'Not running', pid: null }); return { ok: true, wasRunning: false }; }
    setState({ state: 'stopping', message: 'Stopping…' });
    const child = whisperProc;
    try { child.kill('SIGTERM'); } catch {}
    const exited = await Promise.race([waitExit(child), new Promise(r => setTimeout(() => r('timeout'), 4000))]);
    if (exited === 'timeout') { try { child.kill('SIGKILL'); } catch {} }
    whisperProc = null;
    setState({ state: 'stopped', message: 'Speech server stopped', pid: null, serverPid: null, url: null });
    invalidateProbe();
    return { ok: true, wasRunning: true };
}

process.on('exit', () => { try { whisperProc?.kill(); } catch {} });
for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { try { whisperProc?.kill(); } catch {} });
}

// ---------------------------------------------------------------------------
// Ollama
// ---------------------------------------------------------------------------

export async function ollamaModels(baseUrl = 'http://127.0.0.1:11434') {
    return detectOllama(baseUrl);
}

/** Stream a model pull. onEvent receives Ollama's NDJSON progress objects. */
export async function ollamaPull(model, onEvent, baseUrl = 'http://127.0.0.1:11434', signal) {
    const res = await fetch(`${baseUrl}/api/pull`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: model, stream: true }), signal });
    if (!res.ok || !res.body) throw new Error(`Ollama returned HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            let obj;
            try { obj = JSON.parse(line); } catch { continue; }
            // Ollama reports failures as {"error": "..."} lines (e.g. unknown model, no disk space)
            if (obj.error) { onEvent({ status: 'error', error: obj.error }); invalidateProbe(); return; }
            onEvent(obj);
        }
    }
    invalidateProbe();
}

export async function ollamaTest(model, baseUrl = 'http://127.0.0.1:11434') {
    const t0 = Date.now();
    const body = {
        model, stream: false, format: 'json',
        prompt: 'Extract the proper nouns from this sentence as JSON {"names":[...]} : "Chair David Pearlman recognized Bernard Greene of the DPW."',
        options: { num_predict: 80, temperature: 0 },
    };
    const res = await fetch(`${baseUrl}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    let parsed = null;
    try { parsed = JSON.parse(data.response); } catch {}
    return {
        ok: true, model, latencyMs: Date.now() - t0,
        loadMs: data.load_duration ? Math.round(data.load_duration / 1e6) : null,
        evalTokensPerSec: data.eval_count && data.eval_duration ? +(data.eval_count / (data.eval_duration / 1e9)).toFixed(1) : null,
        response: (data.response || '').slice(0, 300), jsonValid: !!parsed,
    };
}

export async function ollamaStart(baseUrl = 'http://127.0.0.1:11434') {
    const probe = await detectOllama(baseUrl);
    if (probe.running) return { ok: true, alreadyRunning: true };
    if (!probe.installed) return { ok: false, error: 'Ollama is not installed' };
    // The Windows installer is per-user and its PATH entry only reaches processes started
    // after the install, so prefer the install location over a bare "ollama".
    const winExe = IS_WIN ? join(os.homedir(), 'AppData', 'Local', 'Programs', 'Ollama', 'ollama.exe') : null;
    const bin = IS_MAC && existsSync('/Applications/Ollama.app') ? 'open' : winExe && existsSync(winExe) ? winExe : 'ollama';
    const args = bin === 'open' ? ['-a', 'Ollama'] : ['serve'];
    let spawnError = null;
    try {
        const child = spawn(bin, args, { detached: true, stdio: 'ignore', windowsHide: true });
        child.on('error', (e) => { spawnError = e; });  // ENOENT arrives as an event; unhandled it would crash the relay
        child.unref();
    } catch (e) { return { ok: false, error: e.message }; }
    for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 500));
        if (spawnError) return { ok: false, error: `Could not run ${bin}: ${spawnError.message}` };
        try { await fetchJson(`${baseUrl}/api/tags`, {}, 1500); invalidateProbe(); return { ok: true, started: true }; } catch {}
    }
    return { ok: false, error: 'Ollama did not start within 10 seconds' };
}


// ---------------------------------------------------------------------------
// Make sure a speech server is up (auto-start the one the operator set up earlier)
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Resolve to a usable speech server. If one answers on the port, use it. If the
 * operator completed the wizard before (whisper.json), start it again and wait
 * for ready, reporting progress through onStatus. If nothing was ever set up,
 * return needsSetup so the UI can send them to the wizard instead of guessing.
 */
export async function ensureWhisper({ port = 9000, onStatus, timeoutMs = 15 * 60 * 1000 } = {}) {
    if (await portOpen(port)) return { ok: true, running: true, managed: !!whisperProc, status: getWhisperStatus() };
    const busy = whisperProc && ['installing', 'starting', 'loading'].includes(whisperState.state);
    let startError = null;
    let startPending = false;
    if (!busy) {
        const cfg = loadWhisperConfig();
        if (!cfg) return { ok: false, needsSetup: true, error: 'The local speech engine has not been set up on this computer yet.' };
        // Do not await: on a first run startWhisper spends minutes in pip/uv before it
        // resolves, and the caller needs the installing/loading status lines meanwhile.
        startPending = true;
        startWhisper({ ...cfg, port }).catch(e => { startError = e; }).finally(() => { startPending = false; });
        await sleep(200);
    }
    const t0 = Date.now();
    let lastMsg = '';
    let lastLogLen = -1;
    while (Date.now() - t0 < timeoutMs) {
        const st = whisperState;
        if (startError) return { ok: false, error: startError.message, status: getWhisperStatus() };
        if (st.message !== lastMsg || logRing.length !== lastLogLen) { lastMsg = st.message; lastLogLen = logRing.length; onStatus?.(getWhisperStatus()); }
        if (st.state === 'ready' && await portOpen(port)) return { ok: true, started: true, managed: true, status: getWhisperStatus() };
        if (!startPending && (st.state === 'error' || st.state === 'stopped')) return { ok: false, error: st.message || 'The speech server did not start', status: getWhisperStatus() };
        await sleep(500);
    }
    return { ok: false, error: 'Timed out waiting for the speech server to start', status: getWhisperStatus() };
}

// ---------------------------------------------------------------------------
// Prerecorded files: hand a path to the speech server and relay its events
// ---------------------------------------------------------------------------
/**
 * Ask the running speech server to transcribe a file. onEvent receives the raw
 * file_* messages plus the server's hello. Returns { cancel } immediately and
 * resolves `done` when the job finishes.
 */
export function transcribeFileWithServer({ url = 'ws://127.0.0.1:9000', path, jobId, onEvent }) {
    let ws;
    let finished = false;
    const done = new Promise((resolve, reject) => {
        try { ws = new WsClient(url, { handshakeTimeout: 5000, maxPayload: 64 * 1024 * 1024 }); } catch (e) { return reject(e); }
        const finish = (err) => { if (finished) return; finished = true; try { ws.close(); } catch {} err ? reject(err) : resolve(); };
        ws.on('open', () => { /* wait for hello */ });
        ws.on('message', (data) => {
            let d; try { d = JSON.parse(data.toString()); } catch { return; }
            if (d.type === 'hello') {
                onEvent?.(d);
                if (typeof d.scriptVersion !== 'number' || d.scriptVersion < 4) {
                    return finish(new Error('The running speech server is too old to transcribe files. Open Local AI setup and replace it with the new version.'));
                }
                ws.send(JSON.stringify({ type: 'transcribe_file', jobId, path }));
                return;
            }
            if (typeof d.type === 'string' && d.type.startsWith('file_')) {
                onEvent?.(d);
                if (d.type === 'file_done') finish();
                else if (d.type === 'file_error') finish(new Error(d.error || 'transcription failed'));
            }
        });
        ws.on('error', (e) => finish(new Error(e?.message || 'speech server connection failed')));
        ws.on('close', () => finish(new Error('speech server connection closed')));
    });
    return {
        done,
        cancel() { try { ws?.send(JSON.stringify({ type: 'cancel_file', jobId })); } catch {} },
    };
}

// ---------------------------------------------------------------------------
// YouTube: fetch the audio with yt-dlp in the same Python environment
// ---------------------------------------------------------------------------
async function pythonRunner() {
    const vpy = venvPython();
    if (existsSync(vpy)) return { cmd: vpy, prefix: [] };
    const info = await probeSystem();
    if (info.uv.installed) return { cmd: info.uv.path, prefix: ['run', '--python', '3.12', '--with', 'yt-dlp', 'python'] , uv: true };
    const py = info.python.find(p => p.ok);
    if (py) return { cmd: py.cmd, prefix: [...py.args] };
    throw new Error('No Python environment found. Set up Local AI first.');
}

/** Download the best audio of a YouTube URL into outDir. Resolves { path, title }. */
export async function downloadYoutubeAudio(url, outDir, onProgress) {
    if (!/^https?:\/\/(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\//i.test(url)) throw new Error('That does not look like a YouTube link');
    mkdirSync(outDir, { recursive: true });
    const r = await pythonRunner();
    if (!r.uv) {
        const probe = await run(r.cmd, [...r.prefix, '-m', 'yt_dlp', '--version'], { timeout: 15000 });
        if (!probe.ok) {
            onProgress?.({ stage: 'installing', message: 'Installing yt-dlp (first time only)…' });
            const pip = await new Promise((resolve) => execFile(r.cmd, [...r.prefix, '-m', 'pip', 'install', '--disable-pip-version-check', '--upgrade', 'yt-dlp'], { timeout: 180000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, so, se) => resolve({ ok: !err, out: String(so) + String(se) })));
            if (!pip.ok) throw new Error('Could not install yt-dlp: ' + pip.out.slice(-300));
        }
    }
    return new Promise((resolve, reject) => {
        const args = [...r.prefix, '-m', 'yt_dlp', '--no-playlist', '--newline', '-f', 'bestaudio[ext=m4a]/bestaudio/best', '-o', join(outDir, '%(id)s.%(ext)s'), '--print', 'after_move:filepath', '--print', 'title', '--no-simulate', url];
        // UTF-8 stdout: on Windows a piped Python writes cp1252, so a printed path under a
        // non-ASCII profile (C:\Users\José\…) would not match existsSync and titles would garble.
        const child = spawn(r.cmd, args, { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
        let out = '', err = '';
        child.stdout.on('data', (d) => {
            const text = d.toString(); out += text;
            for (const line of text.split('\n')) {
                const m = line.match(/\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+\w+)(?:.*?at\s+([\d.]+\w+\/s))?(?:.*?ETA\s+([\d:]+))?/);
                if (m) onProgress?.({ stage: 'downloading', percent: +m[1], size: m[2], speed: m[3], eta: m[4], message: `Downloading audio ${m[1]}% of ${m[2]}${m[3] ? ` at ${m[3]}` : ''}` });
            }
        });
        child.stderr.on('data', (d) => { err += d.toString(); });
        child.on('error', (e) => reject(new Error('yt-dlp failed to start: ' + e.message)));
        child.on('exit', (code) => {
            if (code !== 0) return reject(new Error('YouTube download failed: ' + (err.trim().split('\n').pop() || `exit ${code}`)));
            const lines = out.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('['));
            const filePath = lines.find(l => existsSync(l));
            const title = lines.find(l => l !== filePath) || 'YouTube video';
            if (!filePath) return reject(new Error('yt-dlp finished but no file was written'));
            resolve({ path: filePath, title });
        });
    });
}
