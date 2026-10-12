/**
 * Diagnostics for Help & Settings → Diagnostics: a ring buffer of recent events
 * (errors, engine state changes) and a one-shot report that checks the things
 * that usually explain "captions are not coming on".
 */

export type DiagEntry = { t: number; kind: 'error' | 'warn' | 'console' | 'engine' | 'info'; text: string };

const LOG_MAX = 300;
const STORAGE_KEY = 'cc_diag_log';
let log: DiagEntry[] = (() => {
    try { const raw = localStorage.getItem(STORAGE_KEY); const parsed = raw ? JSON.parse(raw) : []; return Array.isArray(parsed) ? parsed.slice(-LOG_MAX) : []; } catch { return []; }
})();
if (log.length) log.push({ t: Date.now(), kind: 'info', text: `— page loaded (${log.length} earlier events kept from previous sessions) —` });
const listeners = new Set<() => void>();
let saveTimer: any = null;

function persist() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; try { localStorage.setItem(STORAGE_KEY, JSON.stringify(log.slice(-LOG_MAX))); } catch {} }, 300);
}

/** Append one event. Survives reloads (localStorage) so a report can show what happened before a browser restart. */
export function diagLog(kind: DiagEntry['kind'], text: string) {
    const last = log[log.length - 1];
    if (last && last.kind === kind && last.text === text && Date.now() - last.t < 2000) return; // collapse tight repeats
    log.push({ t: Date.now(), kind, text: String(text).slice(0, 400) });
    if (log.length > LOG_MAX) log.splice(0, log.length - LOG_MAX);
    persist();
    for (const fn of listeners) { try { fn(); } catch {} }
}

export function diagEntries(): DiagEntry[] { return [...log]; }
export function clearDiagLog() { log = []; try { localStorage.removeItem(STORAGE_KEY); } catch {} for (const fn of listeners) { try { fn(); } catch {} } }
export function onDiagChange(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }
export function diagText(entries = log): string {
    return entries.map(e => `${new Date(e.t).toISOString()} [${e.kind}] ${e.text}`).join('\n');
}
export function relayLogDownloadUrl() { return `${relayHttp()}/api/logs/download`; }

const relayHttp = () => {
    const manual = localStorage.getItem('cc_relay_url');
    if (manual) return manual.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
    const p = parseInt(window.location.port || '0');
    if (p >= 5170 && p <= 5199) return `${window.location.protocol}//${window.location.hostname}:8080`;
    return `${window.location.protocol}//${window.location.hostname}${window.location.port ? `:${window.location.port}` : ''}`;
};

async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
    return Promise.race([p, new Promise<T>(resolve => setTimeout(() => resolve(fallback), ms))]);
}

export type DiagReport = { lines: string[]; problems: string[] };

/** Collect everything a maintainer would ask for, as plain text lines. */
export async function collectDiagnostics(extra: Record<string, unknown> = {}): Promise<DiagReport> {
    const lines: string[] = [];
    const problems: string[] = [];
    const add = (k: string, v: unknown) => lines.push(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);

    add('time', new Date().toISOString());
    add('page', window.location.href);
    add('secureContext', window.isSecureContext);
    if (!window.isSecureContext) problems.push('The page is not a secure context (not https and not localhost). Browsers refuse microphone access there. Open the app at http://localhost:8080 on the captioning computer, or use https.');
    add('userAgent', navigator.userAgent);
    const isChromium = /Chrome\//.test(navigator.userAgent) && !/Edg\//.test(navigator.userAgent);
    const isSafari = /Safari\//.test(navigator.userAgent) && !/Chrome\//.test(navigator.userAgent);
    add('browser', isChromium ? 'Chrome/Chromium' : /Edg\//.test(navigator.userAgent) ? 'Edge' : isSafari ? 'Safari' : /Firefox\//.test(navigator.userAgent) ? 'Firefox' : 'other');
    add('speechRecognitionApi', !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition));
    if (!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition)) problems.push('This browser has no Web Speech API, so Balanced mode cannot work here. Use Chrome, Edge or Safari, or Local mode.');
    add('spokenLanguage', localStorage.getItem('cc_speech_lang') || 'en-US (default)');
    add('online', navigator.onLine);
    if (!navigator.onLine) problems.push('The browser reports no network connection. Balanced and Cloud modes need one; Local mode does not.');

    // Microphone
    try {
        const perm: any = await withTimeout((navigator.permissions as any)?.query?.({ name: 'microphone' as any }) ?? Promise.resolve(null), 1500, null);
        add('micPermission', perm?.state ?? 'unknown');
        if (perm?.state === 'denied') problems.push('Microphone permission is denied for this site. Allow it in the browser\'s site settings (lock / "aA" icon in the address bar) and on macOS under System Settings → Privacy & Security → Microphone.');
    } catch { add('micPermission', 'unknown'); }
    try {
        const devs = await withTimeout(navigator.mediaDevices.enumerateDevices(), 2000, [] as MediaDeviceInfo[]);
        const inputs = devs.filter(d => d.kind === 'audioinput');
        add('audioInputs', inputs.length);
        add('audioInputLabels', inputs.map(d => d.label || '(label hidden until permission is granted)').slice(0, 8));
        if (inputs.length === 0) problems.push('No audio input devices are visible to the browser.');
    } catch (e: any) { add('audioInputs', `error: ${e?.message}`); }
    add('rememberedAudioSource', extra.audioSourceId ?? '(default)');

    // Relay
    const relayProblem = `The relay at ${relayHttp()} did not answer. Local mode, the audience view, translation and the Context Engine need it. In the desktop app, keep its Terminal window open; if it closed, launch the app again (port 8080 must be free).`;
    try {
        const r = await withTimeout(fetch(`${relayHttp()}/api/app/info`).then(x => x.json()).catch(() => null), 3000, null as any);
        add('relay', r ? `${relayHttp()} · app ${r.version} · desktopApp ${r.desktopApp} · addon ${r.addonLoaded}` : 'unreachable');
        if (!r) problems.push(relayProblem);
    } catch { add('relay', 'unreachable'); problems.push(relayProblem); }
    try {
        const p = await withTimeout(fetch(`${relayHttp()}/api/polisher/status`).then(x => x.json()), 3000, null as any);
        if (p) add('engines', `geminiKey ${p.geminiKeySet} · localBrain ${p.localBrain} · translation ${p.translationAvailable}`);
    } catch {}
    try {
        const li = await withTimeout(fetch(`${relayHttp()}/api/local/info`).then(x => x.json()), 6000, null as any);
        if (li?.whisper) {
            add('localSpeechServer', `running ${li.whisper.running} · managed ${li.whisper.managed} · configured ${li.whisper.configured} · version ${li.whisper.serverVersion ?? '-'} (bundled ${li.whisper.bundledVersion})${li.whisper.hello?.model ? ` · ${li.whisper.hello.model}` : ''}`);
            if (li.managed) add('managedServerState', `${li.managed.state} — ${li.managed.message}`);
            if (li.ollama) add('ollama', `installed ${li.ollama.installed} · running ${li.ollama.running} · ${li.ollama.models?.length ?? 0} models`);
            if (li.gpu) add('gpu', `${li.gpu.type}${li.gpu.name ? ' ' + li.gpu.name : ''}`);
            add('machine', `${li.cpu} · ${li.cpuCores} cores · ${li.memoryGB} GB`);
        }
    } catch {}

    for (const [k, v] of Object.entries(extra)) if (k !== 'audioSourceId') add(k, v);

    const recent = diagEntries().slice(-40);
    lines.push('');
    lines.push(`app events, newest last (${recent.length}):`);
    for (const e of recent) lines.push(`  ${new Date(e.t).toLocaleTimeString()} [${e.kind}] ${e.text}`);

    try {
        const rl = await withTimeout(fetch(`${relayHttp()}/api/logs?n=40`).then(x => x.json()).catch(() => null), 3000, null as any);
        if (rl?.lines) {
            lines.push('');
            lines.push(`relay log, newest last (${rl.lines.length}; full file: ${rl.file}):`);
            for (const l of rl.lines) lines.push(`  ${l}`);
        }
    } catch {}

    return { lines, problems };
}
