import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Server, CheckCircle, AlertCircle, ArrowRight, ArrowLeft, Cpu, Download, RefreshCw, XCircle, Monitor, Command, Copy, Loader2, Mic, Square, ChevronDown, ChevronRight, Brain, Zap, Shield, Wand2, ExternalLink, Play, StopCircle, AlertTriangle, Info } from 'lucide-react';
import { MAC_DOWNLOAD_URL, WINDOWS_DOWNLOAD_URL } from '../utils/appLinks';

interface LocalSetupProps {
    onBack: () => void;
    /** llm is null when the user skipped the Ollama step (Local mode instead of Fully Local) */
    onComplete: (whisperUrl: string, llm: { url: string; model: string } | null) => void;
    initialWhisperUrl?: string;
    initialLlmUrl?: string;
    initialLlmModel?: string;
}

// --- shapes returned by the relay (server/local-stack.js) ---
type ProbeInfo = {
    platform: string; arch: string; cpu: string; cpuCores: number; memoryGB: number;
    gpu: { type: 'apple' | 'nvidia' | 'none'; name?: string; memory?: string };
    python: { cmd: string; version: string; ok: boolean; note?: string }[];
    uv: { installed: boolean; path?: string; version?: string };
    ollama: { installed: boolean; running: boolean; models: { name: string; sizeGB?: number | null; parameterSize?: string }[]; version?: string | null; url: string };
    whisper: { running: boolean; managed: boolean; hello: any; url: string; port: number };
    scriptBundled: boolean; canLaunch: boolean; dataDir: string;
    installCommands: { uv: string; ollama: string; ollamaServe: string };
    recommendation: { backend: string; model: string; compute: string; reason: string };
    whisperModels: { name: string; label: string; downloadMB: number; englishOnly: boolean; tier: 'best' | 'light' | 'other'; desc: string }[];
    ollamaModels: { name: string; label: string; sizeGB: number; minRamGB: number; tier: 'best' | 'light' | 'other'; desc: string }[];
    managed: WhisperStatus;
};
type WhisperStatus = { state: 'stopped' | 'installing' | 'starting' | 'loading' | 'ready' | 'stopping' | 'error'; message: string; model?: string | null; backend?: string | null; device?: string | null; compute?: string | null; url?: string | null; pid?: number | null; runner?: string | null; logs?: { t: number; line: string }[] };

const getRelayUrl = () => {
    const port = window.location.port;
    const p = parseInt(port || '0');
    if (p >= 5170 && p <= 5199) return `${window.location.protocol}//${window.location.hostname}:8080`;
    return `${window.location.protocol}//${window.location.hostname}${port ? `:${port}` : ''}`;
};
const isLocalHost = (h: string) => h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.local') || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);

async function readSse(res: Response, onEvent: (ev: any) => void) {
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
            const raw = buffer.slice(0, idx); buffer = buffer.slice(idx + 2);
            const line = raw.split('\n').find(l => l.startsWith('data:'));
            if (line) { try { onEvent(JSON.parse(line.slice(5).trim())); } catch {} }
        }
    }
}

const fmtMB = (mb: number) => mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`;

const LocalSetup: React.FC<LocalSetupProps> = ({ onBack, onComplete, initialWhisperUrl, initialLlmUrl, initialLlmModel }) => {
    // ---- probe ----
    const [appInfo, setAppInfo] = useState<{ desktopApp: boolean; platform: string; version: string } | null>(null);
    const [info, setInfo] = useState<ProbeInfo | null>(null);
    const [probing, setProbing] = useState(true);
    const [probeError, setProbeError] = useState<string | null>(null);
    const relayOnThisMachine = !!appInfo?.desktopApp || isLocalHost(window.location.hostname);
    const browserHost = window.location.hostname === 'localhost' ? '127.0.0.1' : window.location.hostname;

    // ---- steps ----
    const [step, setStep] = useState(0);

    // ---- speech server ----
    const [model, setModel] = useState('large-v3-turbo');
    const [backend, setBackend] = useState<'auto' | 'mlx' | 'faster-whisper'>('auto');
    const [language, setLanguage] = useState<'en' | 'auto'>('en');
    const [interim, setInterim] = useState(true);
    const [wstatus, setWstatus] = useState<WhisperStatus>({ state: 'stopped', message: 'Not running' });
    const [logs, setLogs] = useState<string[]>([]);
    const [showLogs, setShowLogs] = useState(false);
    const [launching, setLaunching] = useState(false);
    const [launchError, setLaunchError] = useState<string | null>(null);
    const [manualMode, setManualMode] = useState(false);
    const [whisperUrl, setWhisperUrl] = useState(() => {
        const def = `ws://${browserHost}:9000`;
        if (initialWhisperUrl && !/^ws:\/\/(localhost|127\.0\.0\.1):9000$/.test(initialWhisperUrl)) return initialWhisperUrl;
        return def;
    });
    const [manualCheck, setManualCheck] = useState<{ state: 'idle' | 'checking' | 'ok' | 'fail'; hello?: any; error?: string }>({ state: 'idle' });

    // ---- mic test ----
    const [micState, setMicState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
    const [micInterim, setMicInterim] = useState('');
    const [micFinals, setMicFinals] = useState<{ text: string; latencyMs?: number }[]>([]);
    const [micHello, setMicHello] = useState<any>(null);
    const [micError, setMicError] = useState<string | null>(null);
    const micRef = useRef<{ ws?: WebSocket; ctx?: AudioContext; stream?: MediaStream; timer?: any }>({});

    // ---- brain (Ollama) ----
    const [llmUrl, setLlmUrl] = useState(initialLlmUrl || 'http://127.0.0.1:11434');
    const [llmModel, setLlmModel] = useState(initialLlmModel || 'qwen3:4b');
    const [ollama, setOllama] = useState<ProbeInfo['ollama'] | null>(null);
    const [ollamaBusy, setOllamaBusy] = useState<string | null>(null);
    const [pull, setPull] = useState<{ model: string; status: string; completed?: number; total?: number; done?: boolean; error?: string } | null>(null);
    const [llmTest, setLlmTest] = useState<{ ok: boolean; latencyMs?: number; tokensPerSec?: number | null; jsonValid?: boolean; error?: string; model?: string } | null>(null);
    const [skipBrain, setSkipBrain] = useState(false);

    const copy = (t: string) => navigator.clipboard.writeText(t).catch(() => {});

    // ------------------------------------------------------------------
    // Probe the machine (through the relay, which runs where the audio is)
    // ------------------------------------------------------------------
    const probe = useCallback(async (refresh = false) => {
        setProbing(true);
        setProbeError(null);
        try {
            const [a, l] = await Promise.all([
                fetch(`${getRelayUrl()}/api/app/info`).then(r => r.json()).catch(() => null),
                fetch(`${getRelayUrl()}/api/local/info${refresh ? '?refresh=1' : ''}`).then(r => r.json()),
            ]);
            if (a) setAppInfo(a);
            if (!l.ok) throw new Error(l.error || 'probe failed');
            setInfo(l);
            setOllama(l.ollama);
            setWstatus(l.managed);
            if (!refresh) {
                setModel(l.recommendation.model);
                if (l.ollama?.models?.length && !l.ollama.models.some((m: any) => m.name === llmModel)) {
                    const rec = l.ollamaModels.find((m: any) => l.ollama.models.some((im: any) => im.name === m.name));
                    setLlmModel(rec ? rec.name : l.ollama.models[0].name);
                }
            }
        } catch (e) {
            setProbeError((e as Error).message);
        }
        setProbing(false);
    }, []);

    useEffect(() => { probe(false); }, [probe]);

    // Live status + logs of the managed speech server
    useEffect(() => {
        if (!relayOnThisMachine) return;
        const es = new EventSource(`${getRelayUrl()}/api/local/whisper/logs`);
        es.onmessage = (ev) => {
            try {
                const d = JSON.parse(ev.data);
                if (d.type === 'log') setLogs(prev => [...prev.slice(-299), d.line]);
                else if (d.type === 'status') setWstatus(d);
            } catch {}
        };
        es.onerror = () => {};
        return () => es.close();
    }, [relayOnThisMachine]);

    const serverReady = wstatus.state === 'ready' || (!!info?.whisper.running && !wstatus.pid);
    const effectiveUrl = manualMode ? whisperUrl : `ws://${browserHost}:9000`;

    // ------------------------------------------------------------------
    // Speech server actions
    // ------------------------------------------------------------------
    const startServer = async () => {
        setLaunching(true);
        setLaunchError(null);
        setLogs([]);
        try {
            const res = await fetch(`${getRelayUrl()}/api/local/whisper/start`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model, backend, language, interim }),
            });
            const data = await res.json();
            if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);
            setWstatus(data.status);
        } catch (e) {
            setLaunchError((e as Error).message);
        }
        setLaunching(false);
    };

    const stopServer = async () => {
        await fetch(`${getRelayUrl()}/api/local/whisper/stop`, { method: 'POST' }).catch(() => {});
        setTimeout(() => probe(true), 500);
    };

    const checkManual = async () => {
        setManualCheck({ state: 'checking' });
        try {
            const res = await fetch(`${getRelayUrl()}/api/local/whisper/hello`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: whisperUrl }) });
            const d = await res.json();
            if (d.reachable) setManualCheck({ state: 'ok', hello: d.hello });
            else setManualCheck({ state: 'fail', error: d.error || 'No answer' });
        } catch (e) {
            // the relay may not reach it (remote relay) — try from the browser
            try {
                await new Promise<void>((resolve, reject) => {
                    const ws = new WebSocket(whisperUrl);
                    const t = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 3000);
                    ws.onopen = () => { clearTimeout(t); ws.close(); resolve(); };
                    ws.onerror = () => { clearTimeout(t); reject(new Error('connection refused')); };
                });
                setManualCheck({ state: 'ok' });
            } catch (e2) { setManualCheck({ state: 'fail', error: (e2 as Error).message }); }
        }
    };

    // ------------------------------------------------------------------
    // Microphone test: real audio through the real pipeline
    // ------------------------------------------------------------------
    const stopMicTest = useCallback((finalState: 'done' | 'error' | 'idle' = 'done') => {
        const m = micRef.current;
        clearTimeout(m.timer);
        try { m.ws?.close(); } catch {}
        try { m.ctx?.close(); } catch {}
        m.stream?.getTracks().forEach(t => t.stop());
        micRef.current = {};
        setMicState(finalState);
    }, []);

    useEffect(() => () => stopMicTest('idle'), [stopMicTest]);

    const runMicTest = async () => {
        setMicState('running');
        setMicInterim(''); setMicFinals([]); setMicHello(null); setMicError(null);
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
            const ws = new WebSocket(effectiveUrl);
            ws.binaryType = 'arraybuffer';
            micRef.current = { ws, stream };
            ws.onopen = async () => {
                const ctx = new AudioContext({ sampleRate: 16000 });
                if (ctx.state === 'suspended') await ctx.resume();
                micRef.current.ctx = ctx;
                const src = ctx.createMediaStreamSource(stream);
                const proc = ctx.createScriptProcessor(4096, 1, 1);
                proc.onaudioprocess = (e) => {
                    if (ws.readyState !== 1) return;
                    const d = e.inputBuffer.getChannelData(0);
                    const pcm = new Int16Array(d.length);
                    for (let i = 0; i < d.length; i++) pcm[i] = Math.max(-1, Math.min(1, d[i])) * 0x7FFF;
                    ws.send(pcm.buffer);
                };
                src.connect(proc); proc.connect(ctx.destination);
                micRef.current.timer = setTimeout(() => stopMicTest('done'), 30000);
            };
            ws.onmessage = (ev) => {
                try {
                    const d = JSON.parse(ev.data);
                    if (d.type === 'hello') setMicHello(d);
                    else if (typeof d.text === 'string') {
                        if (d.isFinal === false) setMicInterim(d.text);
                        else { setMicFinals(prev => [...prev, { text: d.text, latencyMs: d.latencyMs }].slice(-6)); setMicInterim(''); }
                    }
                } catch {}
            };
            ws.onerror = () => { setMicError(`Could not connect to ${effectiveUrl}`); stopMicTest('error'); };
            ws.onclose = () => { if (micRef.current.ws === ws) stopMicTest('done'); };
        } catch (e) {
            setMicError((e as Error).name === 'NotAllowedError' ? 'Microphone access was denied. Allow it in the browser and try again.' : (e as Error).message);
            stopMicTest('error');
        }
    };

    // ------------------------------------------------------------------
    // Ollama actions
    // ------------------------------------------------------------------
    const refreshOllama = async () => {
        try {
            const d = await fetch(`${getRelayUrl()}/api/local/ollama/models?url=${encodeURIComponent(llmUrl)}`).then(r => r.json());
            setOllama(d);
        } catch {}
    };
    const startOllama = async () => {
        setOllamaBusy('start');
        try {
            const d = await fetch(`${getRelayUrl()}/api/local/ollama/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: llmUrl }) }).then(r => r.json());
            if (!d.ok) setLlmTest({ ok: false, error: d.error });
            await refreshOllama();
        } catch (e) { setLlmTest({ ok: false, error: (e as Error).message }); }
        setOllamaBusy(null);
    };
    const pullModel = async (name: string) => {
        setPull({ model: name, status: 'starting…' });
        setOllamaBusy('pull');
        try {
            const res = await fetch(`${getRelayUrl()}/api/local/ollama/pull`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: name, url: llmUrl }) });
            await readSse(res, (ev) => {
                if (ev.status === 'error') setPull({ model: name, status: 'failed', error: ev.error });
                else if (ev.status === 'done') setPull({ model: name, status: 'done', done: true });
                else setPull({ model: name, status: ev.status || '', completed: ev.completed, total: ev.total });
            });
            setLlmModel(name);
            await refreshOllama();
        } catch (e) { setPull({ model: name, status: 'failed', error: (e as Error).message }); }
        setOllamaBusy(null);
    };
    const testModel = async () => {
        setOllamaBusy('test');
        setLlmTest(null);
        try {
            const d = await fetch(`${getRelayUrl()}/api/local/ollama/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: llmModel, url: llmUrl }) }).then(r => r.json());
            if (!d.ok) throw new Error(d.error || 'failed');
            setLlmTest({ ok: true, latencyMs: d.latencyMs, tokensPerSec: d.evalTokensPerSec, jsonValid: d.jsonValid, model: d.model });
        } catch (e) { setLlmTest({ ok: false, error: (e as Error).message }); }
        setOllamaBusy(null);
    };

    const installedNames = useMemo(() => new Set((ollama?.models || []).map(m => m.name)), [ollama]);
    const osName = info?.platform === 'darwin' ? 'macOS' : info?.platform === 'win32' ? 'Windows' : info?.platform === 'linux' ? 'Linux' : '';
    const speechDone = manualMode ? manualCheck.state === 'ok' : serverReady;
    const brainDone = skipBrain || (!!ollama?.running && installedNames.has(llmModel));

    // ------------------------------------------------------------------
    // Render helpers
    // ------------------------------------------------------------------
    const Step = ({ n, label, done, active }: { n: number; label: string; done: boolean; active: boolean }) => (
        <button onClick={() => setStep(n)} className={`flex-1 flex items-center gap-2 px-3 py-2 rounded-xl border-2 text-left transition-all ${active ? 'border-sage-500 bg-sage-50' : done ? 'border-green-200 bg-green-50' : 'border-stone-100 bg-white hover:border-sage-200'}`}>
            <span className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0 ${done ? 'bg-green-500 text-white' : active ? 'bg-forest-dark text-white' : 'bg-stone-100 text-stone-400'}`}>{done ? <CheckCircle size={14} /> : n + 1}</span>
            <span className={`text-xs font-bold ${active ? 'text-forest-dark' : 'text-stone-500'}`}>{label}</span>
        </button>
    );
    const Pill = ({ ok, warn, children }: { ok?: boolean; warn?: boolean; children: React.ReactNode }) => (
        <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full ${ok ? 'bg-green-100 text-green-700' : warn ? 'bg-amber-100 text-amber-800' : 'bg-stone-100 text-stone-500'}`}>{children}</span>
    );
    const Cmd = ({ cmd }: { cmd: string }) => (
        <div className="flex items-center gap-2 bg-stone-900 text-green-400 px-3 py-2 rounded-lg font-mono text-[11px] overflow-x-auto">
            <span className="flex-1 whitespace-pre">{cmd}</span>
            <button onClick={() => copy(cmd)} className="text-stone-400 hover:text-white shrink-0" title="Copy"><Copy size={12} /></button>
        </div>
    );

    const stateColor = wstatus.state === 'ready' ? 'green' : wstatus.state === 'error' ? 'red' : wstatus.state === 'stopped' ? 'stone' : 'amber';

    return (
        <div className="h-full bg-cream p-6 flex flex-col items-center font-sans overflow-y-auto">
            <div className="max-w-5xl w-full bg-white rounded-3xl shadow-2xl p-8 border border-stone-200 relative my-auto">
                {/* Header */}
                <div className="flex items-center justify-between mb-6">
                    <button onClick={onBack} className="flex items-center gap-2 text-stone-400 hover:text-forest-dark font-bold text-xs transition-colors uppercase tracking-wider">
                        <ArrowLeft size={14} /> Back
                    </button>
                    <div className="flex items-center gap-2 text-[10px] font-bold">
                        {appInfo?.desktopApp && <Pill ok><Monitor size={10} /> Desktop app</Pill>}
                        {!appInfo?.desktopApp && relayOnThisMachine && <Pill ok><Monitor size={10} /> Running on this machine</Pill>}
                        {!relayOnThisMachine && <Pill warn><AlertTriangle size={10} /> Remote server</Pill>}
                    </div>
                </div>

                <div className="mb-6">
                    <h1 className="text-3xl font-display font-bold text-forest-dark mb-1 flex items-center gap-3"><Shield className="text-sage-500" /> Local AI setup</h1>
                    <p className="text-stone-500 text-sm max-w-2xl">Caption with nothing leaving this computer. The speech engine is required; the local AI brain (Ollama) is optional and replaces Gemini for the Context Engine.</p>
                </div>

                {/* Remote-relay notice (the only time the desktop app is actually required) */}
                {!relayOnThisMachine && (
                    <div className="mb-6 p-4 bg-amber-50 border border-amber-200 rounded-xl flex items-start gap-3">
                        <Info size={18} className="text-amber-600 mt-0.5 shrink-0" />
                        <div className="flex-1 text-xs text-amber-800">
                            <p className="font-bold text-sm mb-1">This copy of the app is hosted on another machine</p>
                            <p>Local AI runs on the computer that captures the audio, so the guided installer is unavailable here. Run the desktop app on your own machine, or point the wizard at a speech server you started yourself.</p>
                            <div className="flex gap-2 mt-3">
                                <a href={MAC_DOWNLOAD_URL} target="_blank" rel="noopener noreferrer" className="px-3 py-1.5 rounded-lg bg-forest-dark text-white font-bold hover:bg-forest-light flex items-center gap-1.5"><Command size={12} /> macOS</a>
                                <a href={WINDOWS_DOWNLOAD_URL} target="_blank" rel="noopener noreferrer" className="px-3 py-1.5 rounded-lg bg-forest-dark text-white font-bold hover:bg-forest-light flex items-center gap-1.5"><Monitor size={12} /> Windows</a>
                            </div>
                        </div>
                    </div>
                )}

                {/* Stepper */}
                <div className="flex gap-2 mb-6">
                    <Step n={0} label="Check this machine" done={!!info && !probing} active={step === 0} />
                    <Step n={1} label="Speech engine" done={speechDone} active={step === 1} />
                    <Step n={2} label="AI brain (optional)" done={brainDone} active={step === 2} />
                    <Step n={3} label="Finish" done={false} active={step === 3} />
                </div>

                {/* ============ STEP 0: CHECK ============ */}
                {step === 0 && (
                    <div className="animate-fade-in space-y-4">
                        {probing && !info && (
                            <div className="flex items-center gap-3 text-sm text-stone-500 p-6 justify-center"><Loader2 className="animate-spin" size={18} /> Checking your machine…</div>
                        )}
                        {probeError && (
                            <div className="p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700 flex items-start gap-2"><AlertCircle size={16} className="mt-0.5" /> <span>Could not reach the relay server to inspect this machine ({probeError}). The setup can still be done by hand on the next step.</span></div>
                        )}
                        {info && (
                            <>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                    <div className="p-4 rounded-xl border border-stone-200 bg-stone-50">
                                        <div className="flex items-center gap-2 mb-2"><Cpu size={16} className="text-forest-dark" /><span className="text-sm font-bold text-forest-dark">Hardware</span></div>
                                        <p className="text-xs text-stone-600">{info.cpu}</p>
                                        <p className="text-xs text-stone-600">{info.cpuCores} cores · {info.memoryGB} GB RAM · {osName} {info.arch}</p>
                                        <div className="mt-2">
                                            {info.gpu.type === 'apple' && <Pill ok><Zap size={10} /> Apple Silicon GPU — fast local speech</Pill>}
                                            {info.gpu.type === 'nvidia' && <Pill ok><Zap size={10} /> NVIDIA {info.gpu.name} — GPU acceleration</Pill>}
                                            {info.gpu.type === 'none' && <Pill warn>No supported GPU — CPU models recommended</Pill>}
                                        </div>
                                    </div>
                                    <div className="p-4 rounded-xl border border-stone-200 bg-stone-50">
                                        <div className="flex items-center gap-2 mb-2"><Wand2 size={16} className="text-forest-dark" /><span className="text-sm font-bold text-forest-dark">Recommendation</span></div>
                                        <p className="text-xs text-stone-700 font-bold">{info.whisperModels.find(m => m.name === info.recommendation.model)?.label || info.recommendation.model}
                                            <span className="text-stone-400 font-normal"> via {info.recommendation.backend === 'mlx' ? 'mlx-whisper (Apple GPU)' : `faster-whisper (${info.recommendation.compute})`}</span></p>
                                        <p className="text-xs text-stone-500 mt-1">{info.recommendation.reason}</p>
                                    </div>
                                    <div className="p-4 rounded-xl border border-stone-200 bg-stone-50">
                                        <div className="flex items-center justify-between mb-2">
                                            <div className="flex items-center gap-2"><Server size={16} className="text-forest-dark" /><span className="text-sm font-bold text-forest-dark">Python runtime</span></div>
                                            {info.uv.installed ? <Pill ok>uv {info.uv.version?.replace(/^uv /, '')}</Pill> : info.python.some(p => p.ok) ? <Pill ok>Python {info.python.find(p => p.ok)!.version}</Pill> : <Pill warn>Needs install</Pill>}
                                        </div>
                                        {info.uv.installed ? (
                                            <p className="text-xs text-stone-600">uv is installed — it manages Python and the speech packages automatically. Nothing else to install.</p>
                                        ) : info.python.some(p => p.ok) ? (
                                            <p className="text-xs text-stone-600">Python {info.python.find(p => p.ok)!.version} found ({info.python.find(p => p.ok)!.cmd}). The installer will create an isolated environment for the speech packages. Installing <strong>uv</strong> is optional but makes updates easier:</p>
                                        ) : (
                                            <p className="text-xs text-stone-600">No usable Python found{info.python.length ? ` (found ${info.python.map(p => p.version).join(', ')}, ${info.python[0].note || 'not supported'})` : ''}. Install <strong>uv</strong> (one line, no admin rights) and press "Check again":</p>
                                        )}
                                        {!info.uv.installed && <div className="mt-2"><Cmd cmd={info.installCommands.uv} /></div>}
                                    </div>
                                    <div className="p-4 rounded-xl border border-stone-200 bg-stone-50">
                                        <div className="flex items-center justify-between mb-2">
                                            <div className="flex items-center gap-2"><Brain size={16} className="text-forest-dark" /><span className="text-sm font-bold text-forest-dark">Ollama (optional brain)</span></div>
                                            {info.ollama.running ? <Pill ok>Running · {info.ollama.models.length} model{info.ollama.models.length === 1 ? '' : 's'}</Pill> : info.ollama.installed ? <Pill warn>Installed, not running</Pill> : <Pill>Not installed</Pill>}
                                        </div>
                                        <p className="text-xs text-stone-600">Only needed for a fully offline Context Engine. Otherwise the Context Engine keeps using Gemini (if you have a key) or basic extraction.</p>
                                    </div>
                                </div>
                                {info.whisper.running && (
                                    <div className="p-3 rounded-xl border border-green-200 bg-green-50 text-xs text-green-800 flex items-center gap-2">
                                        <CheckCircle size={14} /> A speech server is already listening on port {info.whisper.port}{info.whisper.hello ? ` — ${info.whisper.hello.backend} / ${info.whisper.hello.model} on ${info.whisper.hello.device}` : ' (a third-party or older server; no model info)'}.
                                    </div>
                                )}
                            </>
                        )}
                        <div className="flex justify-between items-center pt-2">
                            <button onClick={() => probe(true)} disabled={probing} className="text-xs font-bold text-stone-500 hover:text-forest-dark flex items-center gap-1.5"><RefreshCw size={12} className={probing ? 'animate-spin' : ''} /> Check again</button>
                            <button onClick={() => setStep(1)} className="bg-forest-dark text-white px-8 py-3 rounded-xl font-bold hover:bg-forest-light shadow-lg flex items-center gap-2">Next: speech engine <ArrowRight size={18} /></button>
                        </div>
                    </div>
                )}

                {/* ============ STEP 1: SPEECH ENGINE ============ */}
                {step === 1 && (
                    <div className="animate-fade-in space-y-5">
                        <div className="flex items-center justify-between">
                            <div>
                                <h3 className="font-bold text-lg text-forest-dark">Speech engine</h3>
                                <p className="text-xs text-stone-500">Turns microphone audio into text on this machine. Pick a model; the app installs and runs it.</p>
                            </div>
                            <div className="bg-stone-100 p-1 rounded-lg flex gap-1 text-xs font-bold">
                                <button onClick={() => setManualMode(false)} disabled={!relayOnThisMachine} className={`px-3 py-1.5 rounded-md ${!manualMode ? 'bg-white shadow text-forest-dark' : 'text-stone-400'} disabled:opacity-40`}>Let the app run it</button>
                                <button onClick={() => setManualMode(true)} className={`px-3 py-1.5 rounded-md ${manualMode ? 'bg-white shadow text-forest-dark' : 'text-stone-400'}`}>I run my own server</button>
                            </div>
                        </div>

                        {!manualMode && info && (
                            <>
                                {/* Model picker */}
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                                    {info.whisperModels.filter(m => m.tier !== 'other' || m.name === model).map(m => {
                                        const rec = m.name === info.recommendation.model;
                                        const sel = m.name === model;
                                        return (
                                            <button key={m.name} onClick={() => setModel(m.name)} disabled={wstatus.state !== 'stopped' && wstatus.state !== 'error'}
                                                className={`text-left p-3 rounded-xl border-2 transition-all disabled:opacity-60 ${sel ? 'border-sage-500 bg-sage-50' : 'border-stone-200 bg-white hover:border-sage-300'}`}>
                                                <div className="flex items-center gap-2 flex-wrap">
                                                    <span className="text-sm font-bold text-forest-dark">{m.label}</span>
                                                    {rec && <Pill ok>Recommended for this machine</Pill>}
                                                    {m.tier === 'light' && !rec && <Pill>Light</Pill>}
                                                    {m.englishOnly && <Pill>English only</Pill>}
                                                    <span className="text-[10px] text-stone-400 ml-auto">{fmtMB(m.downloadMB)} download</span>
                                                </div>
                                                <p className="text-xs text-stone-500 mt-1">{m.desc}</p>
                                            </button>
                                        );
                                    })}
                                </div>
                                <details className="text-xs text-stone-500">
                                    <summary className="cursor-pointer font-bold text-stone-600">Advanced options</summary>
                                    <div className="mt-2 grid grid-cols-1 md:grid-cols-3 gap-3 p-3 bg-stone-50 rounded-xl border border-stone-200">
                                        <label className="block"><span className="font-bold text-stone-600 block mb-1">Backend</span>
                                            <select value={backend} onChange={e => setBackend(e.target.value as any)} className="w-full border border-stone-200 rounded-lg p-2 bg-white">
                                                <option value="auto">Auto ({info.gpu.type === 'apple' ? 'mlx-whisper on the Apple GPU' : 'faster-whisper'})</option>
                                                {info.gpu.type === 'apple' && <option value="mlx">mlx-whisper (Apple GPU)</option>}
                                                <option value="faster-whisper">faster-whisper (CPU / NVIDIA)</option>
                                            </select></label>
                                        <label className="block"><span className="font-bold text-stone-600 block mb-1">Language</span>
                                            <select value={language} onChange={e => setLanguage(e.target.value as any)} className="w-full border border-stone-200 rounded-lg p-2 bg-white">
                                                <option value="en">English (fastest)</option>
                                                <option value="auto">Auto-detect (multilingual models only)</option>
                                            </select></label>
                                        <label className="flex items-center gap-2 mt-5"><input type="checkbox" checked={interim} onChange={e => setInterim(e.target.checked)} className="accent-forest-dark" /> <span className="font-bold text-stone-600">Show words while speaking</span> <span className="text-stone-400">(uses more CPU)</span></label>
                                    </div>
                                    <p className="mt-2 text-[11px]">Prefer a terminal? <a href={`${getRelayUrl()}/api/local/whisper-server.py`} className="underline text-forest-dark">Download whisper_server.py</a> and run <code className="font-mono">python whisper_server.py --model {model}</code> (needs <code className="font-mono">pip install faster-whisper websockets numpy{info.gpu.type === 'apple' ? ' mlx-whisper' : ''}</code>).</p>
                                </details>

                                {/* Launch + status */}
                                <div className={`rounded-xl border p-4 ${stateColor === 'green' ? 'border-green-200 bg-green-50' : stateColor === 'red' ? 'border-red-200 bg-red-50' : stateColor === 'amber' ? 'border-amber-200 bg-amber-50' : 'border-stone-200 bg-stone-50'}`}>
                                    <div className="flex items-center gap-3">
                                        <div className="shrink-0">
                                            {wstatus.state === 'ready' ? <CheckCircle size={22} className="text-green-600" /> : wstatus.state === 'error' ? <XCircle size={22} className="text-red-500" /> : wstatus.state === 'stopped' ? <Server size={22} className="text-stone-400" /> : <Loader2 size={22} className="animate-spin text-amber-600" />}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <p className="text-sm font-bold text-forest-dark">
                                                {wstatus.state === 'stopped' ? (info.whisper.running ? 'A speech server is already running' : 'Speech server not running') :
                                                 wstatus.state === 'installing' ? 'Installing packages' :
                                                 wstatus.state === 'starting' ? 'Starting' :
                                                 wstatus.state === 'loading' ? 'Loading model' :
                                                 wstatus.state === 'ready' ? 'Speech server ready' :
                                                 wstatus.state === 'stopping' ? 'Stopping' : 'Something went wrong'}
                                            </p>
                                            <p className="text-xs text-stone-600 truncate">{wstatus.message}{wstatus.state === 'ready' && wstatus.url ? ` · ${wstatus.url}` : ''}</p>
                                            {(wstatus.state === 'installing' || wstatus.state === 'loading') && <p className="text-[11px] text-stone-500 mt-0.5">First run downloads {wstatus.state === 'installing' ? 'the speech packages (~200 MB)' : `the model (${fmtMB(info.whisperModels.find(m => m.name === model)?.downloadMB || 0)})`}; later starts take a few seconds.</p>}
                                        </div>
                                        <div className="flex gap-2 shrink-0">
                                            {(wstatus.state === 'stopped' || wstatus.state === 'error') && !info.whisper.running && (
                                                <button onClick={startServer} disabled={launching || !info.canLaunch} className="bg-forest-dark text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-forest-light disabled:opacity-40 flex items-center gap-2" title={!info.canLaunch ? 'Install uv or Python first (step 1)' : ''}>
                                                    {launching ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} {wstatus.state === 'error' ? 'Try again' : 'Install & start'}
                                                </button>
                                            )}
                                            {(wstatus.pid || wstatus.state === 'ready') && (
                                                <button onClick={stopServer} className="bg-white border border-stone-200 text-stone-600 px-3 py-2 rounded-lg text-sm font-bold hover:bg-stone-50 flex items-center gap-1.5"><StopCircle size={14} /> Stop</button>
                                            )}
                                        </div>
                                    </div>
                                    {launchError && <p className="text-xs text-red-600 mt-2 flex items-center gap-1"><AlertCircle size={12} /> {launchError}</p>}
                                    {!info.canLaunch && <p className="text-xs text-amber-700 mt-2">Install uv (see the first step) so the app can create the Python environment.</p>}
                                    {logs.length > 0 && (
                                        <div className="mt-3">
                                            <button onClick={() => setShowLogs(s => !s)} className="text-[11px] font-bold text-stone-500 flex items-center gap-1">{showLogs ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Log ({logs.length} lines)</button>
                                            {showLogs && <pre className="mt-1 bg-stone-900 text-stone-300 text-[10px] p-3 rounded-lg max-h-48 overflow-auto font-mono whitespace-pre-wrap">{logs.slice(-120).join('\n')}</pre>}
                                            {!showLogs && logs.length > 0 && <p className="text-[10px] text-stone-400 font-mono truncate mt-1">{logs[logs.length - 1]}</p>}
                                        </div>
                                    )}
                                </div>
                            </>
                        )}

                        {manualMode && (
                            <div className="rounded-xl border border-stone-200 bg-stone-50 p-4 space-y-3">
                                <p className="text-xs text-stone-600">Use any server that accepts 16 kHz PCM over a WebSocket and returns <code className="font-mono">{'{"text": "..."}'}</code> JSON. Our script does: <a href={`${getRelayUrl()}/api/local/whisper-server.py`} className="underline text-forest-dark">download whisper_server.py</a>, then <code className="font-mono">pip install faster-whisper websockets numpy</code> and <code className="font-mono">python whisper_server.py --model small.en</code>.</p>
                                <div className="flex gap-2">
                                    <input value={whisperUrl} onChange={e => { setWhisperUrl(e.target.value); setManualCheck({ state: 'idle' }); }} className="flex-1 bg-white border border-stone-200 rounded-lg p-2 text-sm font-mono focus:border-sage-500 outline-none" placeholder="ws://127.0.0.1:9000" />
                                    <button onClick={checkManual} disabled={manualCheck.state === 'checking'} className="bg-forest-dark text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-forest-light disabled:opacity-50">{manualCheck.state === 'checking' ? 'Checking…' : 'Check'}</button>
                                </div>
                                {manualCheck.state === 'ok' && <p className="text-xs text-green-700 flex items-center gap-1"><CheckCircle size={12} /> Reachable{manualCheck.hello ? ` — ${manualCheck.hello.backend} / ${manualCheck.hello.model} on ${manualCheck.hello.device}` : ' (no hello message: third-party or older server)'}</p>}
                                {manualCheck.state === 'fail' && <p className="text-xs text-red-600 flex items-center gap-1"><XCircle size={12} /> {manualCheck.error}</p>}
                            </div>
                        )}

                        {/* Mic test */}
                        <div className="rounded-xl border border-stone-200 bg-white p-4">
                            <div className="flex items-center justify-between gap-3">
                                <div>
                                    <p className="text-sm font-bold text-forest-dark flex items-center gap-2"><Mic size={16} /> Test with your microphone</p>
                                    <p className="text-xs text-stone-500">Say a sentence with a few names in it. Captions should appear within a second or two of each pause.</p>
                                </div>
                                {micState !== 'running' ? (
                                    <button onClick={runMicTest} disabled={!speechDone} className="bg-sage-500 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-sage-600 disabled:opacity-40 flex items-center gap-2" title={!speechDone ? 'Start the speech server first' : ''}><Mic size={14} /> Start test</button>
                                ) : (
                                    <button onClick={() => stopMicTest('done')} className="bg-red-500 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-red-600 flex items-center gap-2"><Square size={14} /> Stop</button>
                                )}
                            </div>
                            {(micState !== 'idle' || micError) && (
                                <div className="mt-3 p-3 rounded-lg bg-stone-50 border border-stone-200 min-h-[64px]">
                                    {micError && <p className="text-xs text-red-600 flex items-center gap-1"><XCircle size={12} /> {micError}</p>}
                                    {micHello && <p className="text-[10px] text-green-700 mb-1 flex items-center gap-1"><CheckCircle size={10} /> Connected — {micHello.backend} / {micHello.model} on {micHello.device}</p>}
                                    {micState === 'running' && micFinals.length === 0 && !micInterim && <p className="text-xs text-stone-400 flex items-center gap-2"><Loader2 size={12} className="animate-spin" /> Listening… speak now.</p>}
                                    {micFinals.map((f, i) => <p key={i} className="text-sm text-forest-dark">{f.text} {typeof f.latencyMs === 'number' && <span className="text-[10px] text-stone-400">{(f.latencyMs / 1000).toFixed(1)}s</span>}</p>)}
                                    {micInterim && <p className="text-sm text-stone-400 italic">{micInterim}</p>}
                                    {micState === 'done' && micFinals.length > 0 && <p className="text-[11px] text-green-700 font-bold mt-1 flex items-center gap-1"><CheckCircle size={12} /> Working. Average delay {(micFinals.reduce((a, f) => a + (f.latencyMs || 0), 0) / micFinals.length / 1000).toFixed(1)}s after each pause.</p>}
                                    {micState === 'done' && micFinals.length === 0 && !micError && <p className="text-[11px] text-amber-700 mt-1">No captions came back. Check the microphone level and that the server shows "ready".</p>}
                                </div>
                            )}
                        </div>

                        <div className="flex justify-between items-center pt-2">
                            <button onClick={() => setStep(0)} className="text-stone-500 font-bold hover:text-forest-dark text-sm">Back</button>
                            <button onClick={() => setStep(2)} className="bg-forest-dark text-white px-8 py-3 rounded-xl font-bold hover:bg-forest-light shadow-lg flex items-center gap-2 disabled:opacity-50" disabled={!speechDone}>
                                Next: AI brain <ArrowRight size={18} />
                            </button>
                        </div>
                    </div>
                )}

                {/* ============ STEP 2: BRAIN (OLLAMA) ============ */}
                {step === 2 && (
                    <div className="animate-fade-in space-y-5">
                        <div className="flex items-start justify-between gap-4">
                            <div>
                                <h3 className="font-bold text-lg text-forest-dark">AI brain (optional)</h3>
                                <p className="text-xs text-stone-500 max-w-xl">Ollama runs a small language model locally for the Context Engine (extracting names and acronyms from agendas) and session summaries. Skip it if you'd rather keep using Gemini for those, or don't need them.</p>
                            </div>
                            <label className="flex items-center gap-2 text-xs font-bold text-stone-600 shrink-0 bg-stone-50 border border-stone-200 px-3 py-2 rounded-lg"><input type="checkbox" checked={skipBrain} onChange={e => setSkipBrain(e.target.checked)} className="accent-forest-dark" /> Skip for now</label>
                        </div>

                        {!skipBrain && (
                            <>
                                <div className={`rounded-xl border p-4 ${ollama?.running ? 'border-green-200 bg-green-50' : 'border-stone-200 bg-stone-50'}`}>
                                    <div className="flex items-center gap-3">
                                        {ollama?.running ? <CheckCircle size={22} className="text-green-600" /> : ollama?.installed ? <AlertCircle size={22} className="text-amber-600" /> : <Download size={22} className="text-stone-400" />}
                                        <div className="flex-1">
                                            <p className="text-sm font-bold text-forest-dark">{ollama?.running ? `Ollama is running${ollama.version ? ` (v${ollama.version})` : ''}` : ollama?.installed ? 'Ollama is installed but not running' : 'Ollama is not installed'}</p>
                                            <p className="text-xs text-stone-600">{ollama?.running ? `${ollama.models.length} model${ollama.models.length === 1 ? '' : 's'} installed` : ollama?.installed ? 'Start it, or open the Ollama app.' : 'Free, one install. Then come back and press "Check again".'}</p>
                                        </div>
                                        <div className="flex gap-2">
                                            {ollama?.installed && !ollama.running && <button onClick={startOllama} disabled={ollamaBusy === 'start'} className="bg-forest-dark text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-forest-light disabled:opacity-50 flex items-center gap-2">{ollamaBusy === 'start' ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} Start Ollama</button>}
                                            <button onClick={refreshOllama} className="bg-white border border-stone-200 text-stone-600 px-3 py-2 rounded-lg text-sm font-bold hover:bg-stone-50 flex items-center gap-1.5"><RefreshCw size={14} /> Check again</button>
                                        </div>
                                    </div>
                                    {!ollama?.installed && info && (
                                        <div className="mt-3 space-y-2">
                                            <Cmd cmd={info.installCommands.ollama} />
                                            <a href="https://ollama.com/download" target="_blank" rel="noopener noreferrer" className="text-[11px] underline text-forest-dark inline-flex items-center gap-1">ollama.com/download <ExternalLink size={10} /></a>
                                        </div>
                                    )}
                                </div>

                                {ollama?.running && info && (
                                    <div className="space-y-3">
                                        <p className="text-xs font-bold text-stone-500 uppercase tracking-wider">Pick a model</p>
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                                            {[...info.ollamaModels, ...ollama.models.filter(m => !info.ollamaModels.some(c => c.name === m.name)).map(m => ({ name: m.name, label: m.name, sizeGB: m.sizeGB || 0, minRamGB: 0, tier: 'other' as const, desc: `Installed${m.parameterSize ? ` · ${m.parameterSize}` : ''}` }))].map(m => {
                                                const installed = installedNames.has(m.name);
                                                const sel = llmModel === m.name;
                                                const fits = !m.minRamGB || info.memoryGB >= m.minRamGB;
                                                const rec = m.tier === 'light' && m.name === 'qwen3:4b' || (m.tier === 'best' && m.name === 'qwen3:8b' && info.memoryGB >= 16);
                                                const pulling = pull?.model === m.name && !pull.done && !pull.error;
                                                return (
                                                    <div key={m.name} className={`p-3 rounded-xl border-2 transition-all ${sel ? 'border-sage-500 bg-sage-50' : 'border-stone-200 bg-white'}`}>
                                                        <div className="flex items-center gap-2 flex-wrap">
                                                            <button onClick={() => installed && setLlmModel(m.name)} className={`text-sm font-bold ${installed ? 'text-forest-dark' : 'text-stone-500'}`}>{m.label}</button>
                                                            {rec && fits && <Pill ok>Recommended</Pill>}
                                                            {installed ? <Pill ok>Installed</Pill> : <Pill>{m.sizeGB ? `${m.sizeGB} GB download` : 'Download'}</Pill>}
                                                            {!fits && <Pill warn>Needs {m.minRamGB} GB RAM</Pill>}
                                                            <div className="ml-auto flex gap-1">
                                                                {!installed && !pulling && <button onClick={() => pullModel(m.name)} disabled={!!ollamaBusy} className="text-[11px] font-bold bg-forest-dark text-white px-2.5 py-1 rounded-lg hover:bg-forest-light disabled:opacity-40">Download</button>}
                                                                {installed && !sel && <button onClick={() => setLlmModel(m.name)} className="text-[11px] font-bold bg-sage-100 text-forest-dark px-2.5 py-1 rounded-lg hover:bg-sage-200">Use</button>}
                                                            </div>
                                                        </div>
                                                        <p className="text-xs text-stone-500 mt-1">{m.desc}</p>
                                                        {pull?.model === m.name && (
                                                            <div className="mt-2">
                                                                <div className="flex justify-between text-[10px] text-stone-500 mb-1"><span>{pull.error ? `Failed: ${pull.error}` : pull.done ? 'Downloaded' : pull.status}</span>{pull.total ? <span>{Math.round(((pull.completed || 0) / pull.total) * 100)}%</span> : null}</div>
                                                                <div className="w-full bg-stone-200 rounded-full h-1.5"><div className={`h-1.5 rounded-full ${pull.error ? 'bg-red-400' : 'bg-sage-500'}`} style={{ width: `${pull.done ? 100 : pull.total ? Math.round(((pull.completed || 0) / pull.total) * 100) : 5}%` }} /></div>
                                                            </div>
                                                        )}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                        <div className="flex items-center gap-3 p-3 rounded-xl border border-stone-200 bg-white">
                                            <div className="flex-1 text-xs text-stone-600">Selected: <strong className="text-forest-dark font-mono">{llmModel}</strong>{installedNames.has(llmModel) ? '' : ' (not installed yet)'}</div>
                                            <button onClick={testModel} disabled={!installedNames.has(llmModel) || !!ollamaBusy} className="bg-sage-500 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-sage-600 disabled:opacity-40 flex items-center gap-2">{ollamaBusy === 'test' ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />} Test extraction</button>
                                        </div>
                                        {llmTest && (
                                            <p className={`text-xs flex items-center gap-1 ${llmTest.ok ? 'text-green-700' : 'text-red-600'}`}>
                                                {llmTest.ok ? <CheckCircle size={12} /> : <XCircle size={12} />}
                                                {llmTest.ok ? `${llmTest.model} answered in ${((llmTest.latencyMs || 0) / 1000).toFixed(1)}s${llmTest.tokensPerSec ? ` (${llmTest.tokensPerSec} tokens/s)` : ''}${llmTest.jsonValid ? ' with valid JSON' : ' but the JSON was malformed — try another model'}` : `Test failed: ${llmTest.error}`}
                                            </p>
                                        )}
                                    </div>
                                )}
                            </>
                        )}

                        <div className="flex justify-between items-center pt-2">
                            <button onClick={() => setStep(1)} className="text-stone-500 font-bold hover:text-forest-dark text-sm">Back</button>
                            <button onClick={() => setStep(3)} disabled={!brainDone} className="bg-forest-dark text-white px-8 py-3 rounded-xl font-bold hover:bg-forest-light shadow-lg flex items-center gap-2 disabled:opacity-50">Next: finish <ArrowRight size={18} /></button>
                        </div>
                    </div>
                )}

                {/* ============ STEP 3: FINISH ============ */}
                {step === 3 && (
                    <div className="animate-fade-in space-y-5">
                        <h3 className="font-bold text-lg text-forest-dark">Ready to caption locally</h3>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <div className={`p-4 rounded-xl border ${speechDone ? 'border-green-200 bg-green-50' : 'border-amber-200 bg-amber-50'}`}>
                                <p className="text-sm font-bold text-forest-dark flex items-center gap-2"><Server size={16} /> Speech engine {speechDone ? <CheckCircle size={14} className="text-green-600" /> : <AlertTriangle size={14} className="text-amber-600" />}</p>
                                <p className="text-xs text-stone-600 mt-1 font-mono">{effectiveUrl}</p>
                                <p className="text-xs text-stone-600">{manualMode ? (manualCheck.hello ? `${manualCheck.hello.backend} / ${manualCheck.hello.model}` : 'your own server') : (wstatus.model ? `${wstatus.backend} / ${wstatus.model} on ${wstatus.device}` : info?.whisper.hello ? `${info.whisper.hello.backend} / ${info.whisper.hello.model}` : 'managed by the app')}</p>
                                {!manualMode && <p className="text-[11px] text-stone-500 mt-2">The server keeps running while the app is open. Start it again from this wizard after a restart (the model stays cached).</p>}
                            </div>
                            <div className={`p-4 rounded-xl border ${skipBrain ? 'border-stone-200 bg-stone-50' : 'border-green-200 bg-green-50'}`}>
                                <p className="text-sm font-bold text-forest-dark flex items-center gap-2"><Brain size={16} /> AI brain {skipBrain ? <span className="text-[10px] font-bold text-stone-400">skipped</span> : <CheckCircle size={14} className="text-green-600" />}</p>
                                <p className="text-xs text-stone-600 mt-1">{skipBrain ? 'Mode: Local speech. The Context Engine keeps using Gemini when a key is set, otherwise basic extraction.' : `Mode: Fully local. Ollama ${llmModel} at ${llmUrl}.`}</p>
                            </div>
                        </div>
                        <div className="p-3 rounded-xl bg-stone-50 border border-stone-200 text-xs text-stone-600 flex items-start gap-2"><Info size={14} className="mt-0.5 shrink-0" /><span>The Dashboard shows a <strong>Local</strong> pill while captioning: green when the speech server is answering, red if it drops. Click it to come back here.</span></div>
                        <div className="flex justify-between items-center pt-2">
                            <button onClick={() => setStep(2)} className="text-stone-500 font-bold hover:text-forest-dark text-sm">Back</button>
                            <button onClick={() => onComplete(effectiveUrl, skipBrain ? null : { url: llmUrl, model: llmModel })} className="bg-forest-dark text-white px-8 py-3 rounded-xl font-bold hover:bg-forest-light shadow-lg flex items-center gap-2"><CheckCircle size={18} /> Start captioning in {skipBrain ? 'Local' : 'Fully Local'} mode</button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default LocalSetup;
