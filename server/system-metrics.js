/**
 * System metrics — how the machine is coping while captioning.
 *
 * Samples CPU, RAM, GPU and network every 2 s while someone is asking for them
 * (the Dashboard polls GET /api/system/metrics) and stops on its own 20 s after
 * the last request. Everything is read from cheap OS commands that need no
 * extra permissions:
 *   CPU      os.cpus() deltas (all platforms)
 *   RAM      vm_stat (macOS, "app memory" = active + wired + compressed),
 *            /proc/meminfo MemAvailable (Linux), os.freemem() (Windows)
 *   GPU      ioreg IOAccelerator "Device Utilization %" (Apple Silicon / Intel Macs),
 *            nvidia-smi (NVIDIA on Windows/Linux); other GPUs report unavailable
 *   Network  netstat -ibn (macOS), /proc/net/dev (Linux), netstat -e (Windows)
 *   Procs    the managed Whisper server and Ollama via ps / tasklist, plus this relay
 */

import os from 'os';
import { execFile } from 'child_process';
import { readFile } from 'fs/promises';
import { getWhisperStatus } from './local-stack.js';

const PLATFORM = process.platform;
const GIB = 2 ** 30;
const SAMPLE_MS = 2000;
const IDLE_STOP_MS = 20000;

function run(cmd, args, timeout = 1500) {
    return new Promise((resolve) => {
        try {
            execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : String(stdout || '')));
        } catch {
            resolve('');
        }
    });
}

// ---------------------------------------------------------------------------
// CPU
// ---------------------------------------------------------------------------
let prevCpu = null;
let prevProc = null;

function cpuTimes() {
    let idle = 0, total = 0;
    for (const c of os.cpus()) {
        for (const k in c.times) total += c.times[k];
        idle += c.times.idle;
    }
    return { idle, total };
}

function cpuPercent() {
    const now = cpuTimes();
    let percent = null;
    if (prevCpu) {
        const dt = now.total - prevCpu.total;
        percent = dt > 0 ? Math.max(0, Math.min(100, Math.round((1 - (now.idle - prevCpu.idle) / dt) * 100))) : 0;
    }
    prevCpu = now;
    return percent;
}

/** This relay's own CPU share (of one core) and memory. */
function relayProcess() {
    const usage = process.cpuUsage();
    const now = Date.now();
    let cpu = null;
    if (prevProc) {
        const dtUs = (now - prevProc.at) * 1000;
        if (dtUs > 0) cpu = +(((usage.user - prevProc.user) + (usage.system - prevProc.system)) / dtUs * 100).toFixed(1);
    }
    prevProc = { ...usage, at: now };
    return { name: 'Captioner relay', pid: process.pid, cpu, memGB: +(process.memoryUsage().rss / GIB).toFixed(2) };
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------
async function memory() {
    const total = os.totalmem();
    let used = null, pressure = null;
    if (PLATFORM === 'darwin') {
        const out = await run('vm_stat', []);
        const page = +(out.match(/page size of (\d+)/)?.[1] || 16384);
        const get = (label) => +(out.match(new RegExp(`${label}:\\s+(\\d+)`))?.[1] || 0);
        const active = get('Pages active'), wired = get('Pages wired down'), compressed = get('Pages occupied by compressor');
        if (active || wired) used = (active + wired + compressed) * page;
        const lvl = (await run('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'])).trim();
        pressure = lvl === '4' ? 'critical' : lvl === '2' ? 'warning' : lvl ? 'normal' : null;
    } else if (PLATFORM === 'linux') {
        try {
            const mi = await readFile('/proc/meminfo', 'utf8');
            const avail = +(mi.match(/MemAvailable:\s+(\d+)/)?.[1] || 0) * 1024;
            if (avail) used = total - avail;
        } catch {}
    }
    if (used == null) used = total - os.freemem();
    return { usedGB: +(used / GIB).toFixed(1), totalGB: +(total / GIB).toFixed(1), percent: Math.round((used / total) * 100), pressure };
}

// ---------------------------------------------------------------------------
// GPU
// ---------------------------------------------------------------------------
let gpuUnavailable = false;

async function gpu() {
    if (gpuUnavailable) return { available: false };
    if (PLATFORM === 'darwin') {
        const out = await run('ioreg', ['-r', '-d', '1', '-c', 'IOAccelerator']);
        const util = out.match(/"Device Utilization %"=(\d+)/);
        if (!util) { gpuUnavailable = true; return { available: false }; }
        const renderer = out.match(/"Renderer Utilization %"=(\d+)/);
        const mem = out.match(/"In use system memory"=(\d+)/);
        const model = os.cpus()[0]?.model || '';
        return {
            available: true,
            percent: +util[1],
            rendererPercent: renderer ? +renderer[1] : null,
            memoryUsedGB: mem ? +(+mem[1] / GIB).toFixed(2) : null,
            memoryTotalGB: null, // unified memory: shares RAM
            unified: true,
            name: /apple/i.test(model) ? `${model} GPU` : 'GPU',
        };
    }
    const out = await run('nvidia-smi', ['--query-gpu=name,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'], 2500);
    const line = out.trim().split('\n')[0];
    if (!line) { gpuUnavailable = true; return { available: false }; }
    const [name, util, memUsed, memTotal] = line.split(',').map(s => s.trim());
    return { available: true, percent: +util, memoryUsedGB: +(+memUsed / 1024).toFixed(2), memoryTotalGB: +(+memTotal / 1024).toFixed(1), unified: false, name };
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------
let prevNet = null;

async function networkTotals() {
    let rx = 0, tx = 0, iface = null;
    if (PLATFORM === 'darwin') {
        const out = await run('netstat', ['-ibn']);
        for (const line of out.split('\n').slice(1)) {
            const cols = line.trim().split(/\s+/);
            if (cols.length < 10 || !(cols[2] || '').startsWith('<Link#')) continue;
            if (cols[0] === 'lo0' || /^(utun|awdl|llw|gif|stf|bridge|p2p|ap\d|anpi|vmenet)/.test(cols[0])) continue;
            // Name Mtu Network [Address] Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll — Address is absent on some links
            const hasAddr = (cols[3] || '').includes(':');
            const ibytes = +cols[hasAddr ? 6 : 5], obytes = +cols[hasAddr ? 9 : 8];
            if (!Number.isFinite(ibytes) || !Number.isFinite(obytes)) continue;
            if (ibytes === 0 && obytes === 0) continue;
            rx += ibytes; tx += obytes;
            if (!iface) iface = cols[0];
        }
    } else if (PLATFORM === 'linux') {
        const txt = await readFile('/proc/net/dev', 'utf8').catch(() => '');
        for (const line of txt.split('\n').slice(2)) {
            const [name, rest] = line.split(':');
            if (!rest || name.trim() === 'lo') continue;
            const f = rest.trim().split(/\s+/);
            rx += +f[0] || 0; tx += +f[8] || 0;
            if (!iface) iface = name.trim();
        }
    } else if (PLATFORM === 'win32') {
        const out = await run('netstat', ['-e']);
        const m = out.match(/Bytes\s+(\d+)\s+(\d+)/);
        if (m) { rx = +m[1]; tx = +m[2]; iface = 'all adapters'; }
    }
    return { rx, tx, iface };
}

async function network() {
    const now = Date.now();
    const t = await networkTotals();
    let down = null, up = null;
    if (prevNet && t.iface) {
        const dt = (now - prevNet.at) / 1000;
        if (dt > 0) { down = Math.max(0, (t.rx - prevNet.rx) / dt); up = Math.max(0, (t.tx - prevNet.tx) / dt); }
    }
    prevNet = { ...t, at: now };
    return { downKBps: down == null ? null : Math.round(down / 1024), upKBps: up == null ? null : Math.round(up / 1024), iface: t.iface };
}

// ---------------------------------------------------------------------------
// Processes we care about: the managed Whisper server and Ollama
// ---------------------------------------------------------------------------
async function processes() {
    // serverPid = the interpreter that holds the model (on Windows the spawned venv python.exe
    // is only a 3 MB launcher for it); pid until the server has reported ready.
    const ws = getWhisperStatus();
    const whisperPid = ws.serverPid || ws.pid || null;
    const rows = [];
    if (PLATFORM === 'win32') {
        // tasklist has memory but not CPU; good enough to show what the models cost
        const out = await run('tasklist', ['/FO', 'CSV', '/NH'], 3000);
        for (const line of out.split('\n')) {
            const cols = line.split('","').map(s => s.replace(/^"|"\r?$/g, ''));
            if (cols.length < 5) continue;
            const [image, pidStr, , , memStr] = cols;
            const pid = +pidStr;
            const memGB = +(parseInt(memStr.replace(/[^\d]/g, ''), 10) * 1024 / GIB).toFixed(2);
            if (pid === whisperPid) rows.push({ kind: 'whisper', pid, cpu: null, memGB });
            else if (/^ollama/i.test(image)) rows.push({ kind: 'ollama', pid, cpu: null, memGB });
        }
    } else {
        const pg = await run('pgrep', ['-f', 'ollama']);
        const ollamaPids = pg.split('\n').map(s => +s.trim()).filter(n => n > 0 && n !== process.pid);
        const pids = [...(whisperPid ? [whisperPid] : []), ...ollamaPids].slice(0, 16);
        if (pids.length) {
            const out = await run('ps', ['-o', 'pid=,%cpu=,rss=,comm=', '-p', pids.join(',')]);
            for (const line of out.split('\n')) {
                const m = line.trim().match(/^(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/);
                if (!m) continue;
                const pid = +m[1];
                rows.push({ kind: pid === whisperPid ? 'whisper' : 'ollama', pid, cpu: +m[2], memGB: +((+m[3] * 1024) / GIB).toFixed(2) });
            }
        }
    }
    const groups = [];
    const w = rows.find(r => r.kind === 'whisper');
    if (w) groups.push({ name: 'Whisper speech server', pid: w.pid, cpu: w.cpu, memGB: w.memGB });
    const o = rows.filter(r => r.kind === 'ollama');
    if (o.length) {
        const cpu = o.some(r => r.cpu != null) ? +o.reduce((n, r) => n + (r.cpu || 0), 0).toFixed(1) : null;
        groups.push({ name: 'Ollama (local AI brain)', pid: o[0].pid, cpu, memGB: +o.reduce((n, r) => n + r.memGB, 0).toFixed(2), count: o.length });
    }
    groups.push(relayProcess());
    return groups;
}

// ---------------------------------------------------------------------------
// Sampler
// ---------------------------------------------------------------------------
let latest = null;
let timer = null;
let lastRequest = 0;
let sampling = false;

async function takeSample() {
    if (sampling) return latest;
    sampling = true;
    try {
        const [mem, g, net, procs] = await Promise.all([memory(), gpu(), network(), processes()]);
        latest = {
            ts: Date.now(),
            platform: PLATFORM,
            cpu: { percent: cpuPercent(), cores: os.cpus().length, loadAvg1: +(os.loadavg()[0] || 0).toFixed(2), model: os.cpus()[0]?.model || '' },
            memory: mem,
            gpu: g,
            network: net,
            processes: procs,
        };
    } finally {
        sampling = false;
    }
    return latest;
}

function stopSampler() {
    if (timer) { clearInterval(timer); timer = null; }
    prevCpu = null; prevNet = null; prevProc = null;
}

/**
 * Latest sample; starts the sampler on first use and lets it idle out on its own.
 * The very first call takes two samples half a second apart so rates are real.
 */
export async function getSystemMetrics() {
    lastRequest = Date.now();
    if (!timer) {
        await takeSample();
        await new Promise(r => setTimeout(r, 500));
        await takeSample();
        timer = setInterval(() => {
            if (Date.now() - lastRequest > IDLE_STOP_MS) { stopSampler(); return; }
            takeSample().catch(() => {});
        }, SAMPLE_MS);
        timer.unref?.();
    }
    return latest;
}
