import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
    ArrowRight, Cast, Cpu, Copy, CheckCircle, Loader2, Mic, Monitor,
    Play, RefreshCw, Signal, Square, Tv, Wifi, Youtube, Plug, Radio,
    AlertTriangle, Zap, Send, Settings as SettingsIcon, ExternalLink
} from 'lucide-react';
import { DeckLinkDevice } from '../types';

interface CaptionInjectionProps {
    onBack: () => void;
    apiKey?: string;
}

type SourceKind = 'sdi' | 'ndi' | 'standalone';
type CaptionSource = 'live_mic' | 'system_audio' | 'external_ws' | 'manual';

interface InjectStatus {
    running: boolean;
    mode: string | null;
    framesOutput: number;
    droppedFrames: number;
    encoderQueueDepth: number;
    cea708BridgeClients: number;
    presenterUrl: string;
    addonLoaded: boolean;
    ndiAvailable: boolean;
    encodingMode: string;
}

const CaptionInjection: React.FC<CaptionInjectionProps> = ({ onBack, apiKey }) => {
    const getRelayUrl = () => {
        const port = window.location.port || '80';
        const relayPort = (parseInt(port) >= 5170 && parseInt(port) <= 5199) ? '8080' : port;
        return `${window.location.protocol}//${window.location.hostname}:${relayPort}`;
    };
    const getWsRelayUrl = () => {
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const port = window.location.port || (window.location.protocol === 'https:' ? '443' : '80');
        const p = parseInt(port);
        const relayPort = (p >= 5170 && p <= 5199) ? '8080' : port;
        return `${proto}//${window.location.hostname}:${relayPort}`;
    };

    // Device + source selection
    const [devices, setDevices] = useState<DeckLinkDevice[]>([]);
    const [addonAvailable, setAddonAvailable] = useState(false);
    const [addonError, setAddonError] = useState<string | null>(null);
    const [sourceKind, setSourceKind] = useState<SourceKind>('sdi');
    const [inputDevice, setInputDevice] = useState(0);
    const [outputDevice, setOutputDevice] = useState(0);
    const [displayMode, setDisplayMode] = useState(0);
    const [frameRate, setFrameRate] = useState('29.97');
    const [encodingMode, setEncodingMode] = useState<'cea608' | 'dtvcc'>('cea608');
    const [ndiSources, setNdiSources] = useState<{name: string; url: string}[]>([]);
    const [selectedNdiSource, setSelectedNdiSource] = useState('');
    const [ndiScanning, setNdiScanning] = useState(false);
    const [ndiAvailable, setNdiAvailable] = useState(false);

    // Caption source
    const [captionSource, setCaptionSource] = useState<CaptionSource>('live_mic');
    const [manualText, setManualText] = useState('');

    // Live status
    const [status, setStatus] = useState<InjectStatus | null>(null);
    const [starting, setStarting] = useState(false);
    const [startError, setStartError] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    // STT (live_mic) — uses Web Speech API for low-friction setup
    const [listening, setListening] = useState(false);
    const recognitionRef = useRef<any>(null);
    const wsRef = useRef<WebSocket | null>(null);
    const [interimText, setInterimText] = useState('');
    const [recentCaptions, setRecentCaptions] = useState<string[]>([]);
    const [micPermissionError, setMicPermissionError] = useState<string | null>(null);

    // Load devices + status on mount
    useEffect(() => {
        const load = async () => {
            try {
                const res = await fetch(`${getRelayUrl()}/api/decklink/devices`);
                const data = await res.json();
                setAddonAvailable(!!data.available);
                setAddonError(data.error || null);
                if (data.devices) {
                    setDevices(data.devices);
                    const firstIn = data.devices.find((d: DeckLinkDevice) => d.hasInput);
                    if (firstIn) setInputDevice(firstIn.index);
                    const firstOut = data.devices.find((d: DeckLinkDevice) => d.hasOutput);
                    if (firstOut) {
                        setOutputDevice(firstOut.index);
                        if (firstOut.displayModes?.length) {
                            setDisplayMode(firstOut.displayModes[0].mode);
                            setFrameRate(firstOut.displayModes[0].fps.toFixed(2));
                        }
                    }
                }
            } catch {}
            // Check inject status for NDI availability
            try {
                const r2 = await fetch(`${getRelayUrl()}/api/inject/status`);
                const d2 = await r2.json();
                setStatus(d2);
                setNdiAvailable(!!d2.ndiAvailable);
            } catch {}
        };
        load();
    }, []);

    // Status poll
    useEffect(() => {
        const tick = async () => {
            try {
                const res = await fetch(`${getRelayUrl()}/api/inject/status`);
                const data = await res.json();
                setStatus(data);
                setNdiAvailable(!!data.ndiAvailable);
            } catch {}
        };
        const interval = setInterval(tick, 1000);
        return () => clearInterval(interval);
    }, []);

    // NDI source scan — auto when NDI mode picked
    const scanNdi = useCallback(async () => {
        setNdiScanning(true);
        try {
            const res = await fetch(`${getRelayUrl()}/api/ndi/sources`);
            const data = await res.json();
            setNdiSources(data.sources || []);
            if (data.sources?.length && !selectedNdiSource) setSelectedNdiSource(data.sources[0].name);
        } catch {}
        setNdiScanning(false);
    }, [selectedNdiSource]);

    useEffect(() => {
        if (sourceKind === 'ndi' && ndiAvailable) scanNdi();
    }, [sourceKind, ndiAvailable, scanNdi]);

    // Output device options (only devices with hasOutput)
    const outputDevices = devices.filter(d => d.hasOutput);
    const inputDevices = devices.filter(d => d.hasInput);
    const currentOutputModes = devices.find(d => d.index === outputDevice)?.displayModes || [];

    // Caption injection control
    const handleStart = async () => {
        setStarting(true);
        setStartError(null);
        try {
            const body: any = {
                sourceKind, outputDevice, displayMode, frameRate, encodingMode,
            };
            if (sourceKind === 'sdi') body.inputDevice = inputDevice;
            if (sourceKind === 'ndi') body.ndiSource = selectedNdiSource;

            const res = await fetch(`${getRelayUrl()}/api/inject/start`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const data = await res.json();
            if (!data.ok) {
                setStartError(data.error || 'Start failed');
            }
        } catch (e) {
            setStartError((e as Error).message);
        }
        setStarting(false);
    };

    const handleStop = async () => {
        try {
            await fetch(`${getRelayUrl()}/api/inject/stop`, { method: 'POST' });
            if (listening) stopListening();
        } catch {}
    };

    // --- Caption broadcast helpers ---
    const broadcastCaption = useCallback((text: string, isFinal: boolean) => {
        if (!text) return;
        // 1. Push directly into encoder via dedicated endpoint (works even
        //    without a session WebSocket).
        if (isFinal) {
            fetch(`${getRelayUrl()}/api/inject/caption`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text, isFinal: true }),
            }).catch(() => {});
        }

        // 2. Also broadcast via the main session WS so audience phones and
        //    overlays see the same caption (they're connected to 'demo').
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
            try {
                const ws = new WebSocket(getWsRelayUrl());
                ws.onopen = () => {
                    ws.send(JSON.stringify({ type: 'join', sessionId: 'demo', role: 'presenter' }));
                    ws.send(JSON.stringify({ type: 'caption', isFinal, payload: { id: Date.now().toString(), text, timestamp: Date.now() } }));
                };
                wsRef.current = ws;
            } catch {}
        } else {
            wsRef.current.send(JSON.stringify({ type: 'caption', isFinal, payload: { id: Date.now().toString(), text, timestamp: Date.now() } }));
        }

        if (isFinal) {
            setRecentCaptions(prev => [text, ...prev].slice(0, 8));
        }
    }, []);

    // Web Speech for live_mic source
    const startListening = useCallback(async () => {
        setMicPermissionError(null);
        const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
        if (!SR) {
            setMicPermissionError('SpeechRecognition API not available in this browser. Use Chrome or Edge.');
            return;
        }
        try {
            await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (e) {
            setMicPermissionError('Microphone permission denied. Allow mic access in browser settings.');
            return;
        }
        const recognition = new SR();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = 'en-US';

        recognition.onresult = (event: any) => {
            let interim = '';
            for (let i = event.resultIndex; i < event.results.length; i++) {
                const transcript = event.results[i][0].transcript;
                if (event.results[i].isFinal) {
                    broadcastCaption(transcript.trim(), true);
                    setInterimText('');
                } else {
                    interim += transcript;
                }
            }
            if (interim) {
                setInterimText(interim);
                broadcastCaption(interim, false);
            }
        };

        recognition.onerror = (e: any) => {
            console.warn('[Inject STT] error', e.error);
            if (e.error === 'not-allowed') setMicPermissionError('Mic permission denied');
            if (e.error === 'no-speech') return; // ignore
        };

        recognition.onend = () => {
            // Auto-restart while listening flag is on
            if (recognitionRef.current === recognition && listeningRef.current) {
                try { recognition.start(); } catch {}
            }
        };

        recognitionRef.current = recognition;
        listeningRef.current = true;
        try { recognition.start(); setListening(true); } catch (e) {
            setMicPermissionError((e as Error).message);
        }
    }, [broadcastCaption]);

    const listeningRef = useRef(false);
    const stopListening = useCallback(() => {
        listeningRef.current = false;
        try { recognitionRef.current?.stop(); } catch {}
        recognitionRef.current = null;
        setListening(false);
        setInterimText('');
        try { wsRef.current?.close(); } catch {}
        wsRef.current = null;
    }, []);

    useEffect(() => () => stopListening(), [stopListening]);

    const handleSendManual = () => {
        if (!manualText.trim()) return;
        broadcastCaption(manualText.trim(), true);
        setManualText('');
    };

    const copyPresenterUrl = () => {
        if (!status?.presenterUrl) return;
        navigator.clipboard.writeText(status.presenterUrl);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    };

    const running = !!status?.running;
    // OS detection for platform-specific setup instructions
    const ua = (typeof navigator !== 'undefined' ? navigator.userAgent : '') || '';
    const platform = /Windows/i.test(ua) ? 'windows' : /Mac/i.test(ua) ? 'mac' : /Linux/i.test(ua) ? 'linux' : 'unknown';
    const showSetupCard = !addonAvailable && status !== null; // we've loaded status and it's still missing

    if (showSetupCard) {
        const addonReleaseUrl = `https://github.com/amateurmenace/community-captioner-v10/releases/latest`;
        return (
            <div className="absolute inset-0 z-40 bg-cream flex flex-col animate-fade-in font-sans overflow-y-auto">
                <div className="h-20 border-b border-stone-200 px-8 flex items-center justify-between bg-white sticky top-0 z-20 shadow-sm">
                    <div className="flex items-center gap-4">
                        <button onClick={onBack} className="text-stone-500 font-bold flex items-center gap-2 hover:text-forest-dark"><ArrowRight className="rotate-180" size={16} /> Back</button>
                        <div className="w-12 h-12 bg-amber-500 rounded-xl flex items-center justify-center text-white shadow-lg shadow-amber-200">
                            <AlertTriangle size={22} />
                        </div>
                        <div>
                            <h2 className="text-xl font-bold font-display leading-tight">Caption Injection — Setup Required</h2>
                            <p className="text-xs text-stone-500 font-medium">The native DeckLink driver isn't loaded on this machine</p>
                        </div>
                    </div>
                </div>

                <div className="flex-1 flex justify-center p-8">
                    <div className="max-w-3xl w-full space-y-6">
                        {/* What's happening */}
                        <div className="bg-white border border-amber-200 rounded-2xl p-6 shadow-sm">
                            <div className="flex items-start gap-4">
                                <div className="w-12 h-12 bg-amber-50 rounded-xl flex items-center justify-center text-amber-600 shrink-0">
                                    <AlertTriangle size={24} />
                                </div>
                                <div className="flex-1">
                                    <h3 className="text-lg font-bold text-stone-800 mb-1">DeckLink hardware support is missing</h3>
                                    <p className="text-sm text-stone-600 leading-relaxed">
                                        Caption Injection needs the native <code className="bg-stone-100 px-1.5 py-0.5 rounded text-xs">decklink_addon.node</code> driver
                                        to talk to your Blackmagic DeckLink card. It's a one-time setup — once installed, captions are embedded
                                        in SDI VANC and passed through to your web presenter automatically.
                                    </p>
                                    {addonError && (
                                        <div className="mt-3 p-2.5 bg-stone-50 border border-stone-200 rounded-lg">
                                            <p className="text-[10px] font-bold text-stone-400 uppercase mb-1">Server reported</p>
                                            <p className="text-[11px] font-mono text-stone-600">{addonError}</p>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* Platform-specific setup */}
                        {platform === 'windows' && (
                            <div className="bg-white rounded-2xl shadow-lg border border-stone-200 overflow-hidden">
                                <div className="bg-gradient-to-r from-blue-500 to-blue-600 p-5 text-white">
                                    <p className="text-[10px] font-bold uppercase tracking-wider opacity-80">Windows setup</p>
                                    <h3 className="text-xl font-bold mt-0.5">Three options — easiest first</h3>
                                </div>
                                <div className="p-6 space-y-5">
                                    {/* Option 1 — download prebuilt addon */}
                                    <div className="flex gap-4">
                                        <div className="w-10 h-10 bg-green-500 text-white rounded-full flex items-center justify-center font-bold shrink-0 shadow-sm">1</div>
                                        <div className="flex-1">
                                            <p className="font-bold text-stone-800">Download the prebuilt addon (recommended)</p>
                                            <p className="text-sm text-stone-600 mt-0.5">If we've published a Windows build for your version, you can drop it next to <code className="bg-stone-100 px-1 rounded text-xs">CommunityCaptioner.exe</code>.</p>
                                            <ol className="text-sm text-stone-600 mt-2 space-y-1 list-decimal list-inside">
                                                <li>Open the latest release page</li>
                                                <li>Download <code className="bg-stone-100 px-1 rounded text-xs">decklink_addon-windows-x64.node</code></li>
                                                <li>Rename it to <code className="bg-stone-100 px-1 rounded text-xs">decklink_addon.node</code></li>
                                                <li>Place it in the same folder as <code className="bg-stone-100 px-1 rounded text-xs">CommunityCaptioner.exe</code></li>
                                                <li>Restart the app</li>
                                            </ol>
                                            <a href={addonReleaseUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 mt-3 px-4 py-2 bg-green-500 hover:bg-green-600 text-white text-sm font-bold rounded-lg shadow-sm">
                                                Open GitHub Releases <ExternalLink size={14} />
                                            </a>
                                        </div>
                                    </div>

                                    {/* Option 2 — install drivers + addon manually */}
                                    <div className="border-t border-stone-100 pt-5 flex gap-4">
                                        <div className="w-10 h-10 bg-blue-500 text-white rounded-full flex items-center justify-center font-bold shrink-0 shadow-sm">2</div>
                                        <div className="flex-1">
                                            <p className="font-bold text-stone-800">Install Blackmagic drivers (always required for the card itself)</p>
                                            <p className="text-sm text-stone-600 mt-0.5">Even with the prebuilt addon, you need Blackmagic's drivers so Windows can talk to the DeckLink hardware.</p>
                                            <a href="https://www.blackmagicdesign.com/support/family/capture-and-playback" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 mt-3 px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white text-sm font-bold rounded-lg shadow-sm">
                                                Download Desktop Video <ExternalLink size={14} />
                                            </a>
                                        </div>
                                    </div>

                                    {/* Option 3 — build from source */}
                                    <div className="border-t border-stone-100 pt-5 flex gap-4">
                                        <div className="w-10 h-10 bg-stone-400 text-white rounded-full flex items-center justify-center font-bold shrink-0 shadow-sm">3</div>
                                        <div className="flex-1">
                                            <p className="font-bold text-stone-800">Build from source (developer fallback)</p>
                                            <p className="text-sm text-stone-600 mt-0.5">If no prebuilt is available, compile it yourself.</p>
                                            <ol className="text-sm text-stone-600 mt-2 space-y-1 list-decimal list-inside">
                                                <li>Install <a href="https://nodejs.org/" className="text-blue-600 underline">Node.js 20</a></li>
                                                <li>Install <a href="https://visualstudio.microsoft.com/visual-cpp-build-tools/" className="text-blue-600 underline">Visual Studio Build Tools</a> (C++ workload)</li>
                                                <li>Download the <a href="https://www.blackmagicdesign.com/developer/" className="text-blue-600 underline">DeckLink SDK</a> (free registration)</li>
                                                <li>Clone <a href="https://github.com/amateurmenace/community-captioner-v10" className="text-blue-600 underline">the repo</a>, run <code className="bg-stone-100 px-1 rounded text-xs">npm install</code> then <code className="bg-stone-100 px-1 rounded text-xs">npm run build:native</code></li>
                                                <li>Copy <code className="bg-stone-100 px-1 rounded text-xs">native/decklink/build/Release/decklink_addon.node</code> next to <code className="bg-stone-100 px-1 rounded text-xs">CommunityCaptioner.exe</code></li>
                                            </ol>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}

                        {platform === 'mac' && (
                            <div className="bg-white rounded-2xl shadow-lg border border-stone-200 overflow-hidden">
                                <div className="bg-gradient-to-r from-stone-700 to-stone-800 p-5 text-white">
                                    <p className="text-[10px] font-bold uppercase tracking-wider opacity-80">macOS setup</p>
                                    <h3 className="text-xl font-bold mt-0.5">Reinstall or rebuild the addon</h3>
                                </div>
                                <div className="p-6 space-y-4">
                                    <p className="text-sm text-stone-600">The official macOS .app should ship with the addon pre-bundled. If you're seeing this:</p>
                                    <ol className="text-sm text-stone-600 space-y-1 list-decimal list-inside">
                                        <li>Confirm <a href="https://www.blackmagicdesign.com/support/family/capture-and-playback" className="text-blue-600 underline">Blackmagic Desktop Video</a> is installed</li>
                                        <li>Re-download the latest <a href={addonReleaseUrl} className="text-blue-600 underline">Community Captioner.app</a></li>
                                        <li>If you're running from source, run <code className="bg-stone-100 px-1 rounded text-xs">npm run build:native</code> and restart</li>
                                    </ol>
                                </div>
                            </div>
                        )}

                        {/* What still works without DeckLink */}
                        <div className="bg-stone-50 border border-stone-200 rounded-2xl p-5">
                            <p className="text-[10px] font-bold text-stone-400 uppercase tracking-wider mb-2">Meanwhile, these still work without DeckLink</p>
                            <ul className="text-sm text-stone-600 space-y-1 list-disc list-inside">
                                <li><strong>Live Session</strong> — browser-based captioning with overlay output</li>
                                <li><strong>Audience phone view</strong> — QR-code accessible captions on mobile</li>
                                <li><strong>Context Engine</strong> — agenda upload, municipality wizard, dictionary management</li>
                                <li><strong>Translations</strong> — server-side per-language translation for audience members</li>
                            </ul>
                            <button onClick={onBack} className="mt-3 text-sm font-bold text-forest-dark hover:underline">← Back to workflow picker</button>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="absolute inset-0 z-40 bg-cream flex flex-col animate-fade-in font-sans overflow-hidden">
            {/* Header */}
            <div className="h-20 border-b border-stone-200 px-8 flex items-center justify-between bg-white sticky top-0 z-20 shadow-sm">
                <div className="flex items-center gap-4">
                    <button onClick={onBack} className="text-stone-500 font-bold flex items-center gap-2 hover:text-forest-dark"><ArrowRight className="rotate-180" size={16} /> Back</button>
                    <div className="w-12 h-12 bg-purple-500 rounded-xl flex items-center justify-center text-white shadow-lg shadow-purple-200">
                        <Zap size={22} />
                    </div>
                    <div>
                        <h2 className="text-xl font-bold font-display leading-tight">Caption Injection</h2>
                        <p className="text-xs text-stone-500 font-medium">Embed CEA-608/708 captions in your live SDI feed for YouTube broadcast</p>
                    </div>
                </div>
                <div className="flex items-center gap-3">
                    {running ? (
                        <div className="flex items-center gap-2 px-3 py-1.5 bg-red-50 border border-red-200 rounded-lg">
                            <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                            <span className="text-xs font-bold text-red-700">INJECTING</span>
                        </div>
                    ) : (
                        <div className="flex items-center gap-2 px-3 py-1.5 bg-stone-100 rounded-lg">
                            <div className="w-2 h-2 rounded-full bg-stone-400" />
                            <span className="text-xs font-bold text-stone-500">IDLE</span>
                        </div>
                    )}
                </div>
            </div>

            {/* Body */}
            <div className="flex-1 flex overflow-hidden">
                {/* Left config column */}
                <div className="w-2/5 bg-white border-r border-stone-200 overflow-y-auto custom-scrollbar p-6 space-y-6">
                    {/* Addon warning */}
                    {!addonAvailable && (
                        <div className="p-4 bg-amber-50 border border-amber-300 rounded-xl">
                            <div className="flex items-start gap-2">
                                <AlertTriangle size={18} className="text-amber-600 shrink-0 mt-0.5" />
                                <div>
                                    <p className="text-sm font-bold text-amber-800">DeckLink Addon Not Loaded</p>
                                    <p className="text-[11px] text-amber-700 mt-1">Caption injection requires the native DeckLink addon. {addonError ? `Reason: ${addonError}` : 'Build with npm run build:native and restart.'}</p>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Step 1 — Video Source */}
                    <section>
                        <div className="flex items-center gap-2 mb-3">
                            <div className="w-6 h-6 bg-forest-dark text-white rounded-full flex items-center justify-center text-[10px] font-bold">1</div>
                            <h3 className="text-sm font-bold text-forest-dark">Video Source</h3>
                        </div>
                        <p className="text-[11px] text-stone-500 mb-3">Pick where the live video is coming from. The system injects CEA-608/708 into the outgoing SDI.</p>
                        <div className="grid grid-cols-3 gap-2">
                            <button
                                onClick={() => setSourceKind('sdi')}
                                disabled={running}
                                className={`p-3 rounded-lg border text-left transition-all ${sourceKind === 'sdi' ? 'border-sage-500 bg-sage-50 shadow-sm' : 'border-stone-200 hover:border-sage-300'} disabled:opacity-50`}
                            >
                                <Signal size={16} className={sourceKind === 'sdi' ? 'text-sage-600 mb-1' : 'text-stone-500 mb-1'} />
                                <p className="text-xs font-bold text-stone-800">SDI Input</p>
                                <p className="text-[10px] text-stone-500">DeckLink card or capture card</p>
                            </button>
                            <button
                                onClick={() => setSourceKind('ndi')}
                                disabled={running || !ndiAvailable}
                                className={`p-3 rounded-lg border text-left transition-all ${sourceKind === 'ndi' ? 'border-sage-500 bg-sage-50 shadow-sm' : 'border-stone-200 hover:border-sage-300'} disabled:opacity-40 disabled:cursor-not-allowed`}
                                title={!ndiAvailable ? 'NDI not built into this addon' : ''}
                            >
                                <Cast size={16} className={sourceKind === 'ndi' ? 'text-sage-600 mb-1' : 'text-stone-500 mb-1'} />
                                <p className="text-xs font-bold text-stone-800">NDI</p>
                                <p className="text-[10px] text-stone-500">{ndiAvailable ? 'IP video on LAN' : 'Not available'}</p>
                            </button>
                            <button
                                onClick={() => setSourceKind('standalone')}
                                disabled={running}
                                className={`p-3 rounded-lg border text-left transition-all ${sourceKind === 'standalone' ? 'border-sage-500 bg-sage-50 shadow-sm' : 'border-stone-200 hover:border-sage-300'} disabled:opacity-50`}
                            >
                                <Monitor size={16} className={sourceKind === 'standalone' ? 'text-sage-600 mb-1' : 'text-stone-500 mb-1'} />
                                <p className="text-xs font-bold text-stone-800">CC-only feed</p>
                                <p className="text-[10px] text-stone-500">Black SDI + captions</p>
                            </button>
                        </div>

                        {/* SDI Input device picker */}
                        {sourceKind === 'sdi' && (
                            <div className="mt-3">
                                <label className="text-[10px] font-bold text-stone-400 uppercase tracking-wider mb-1 block">SDI Input Device</label>
                                {inputDevices.length > 0 ? (
                                    <select
                                        value={inputDevice}
                                        onChange={e => setInputDevice(Number(e.target.value))}
                                        disabled={running}
                                        className="w-full px-3 py-2 rounded-lg border border-stone-200 text-sm focus:outline-none focus:border-sage-500"
                                    >
                                        {inputDevices.map(d => <option key={d.index} value={d.index}>{d.name}</option>)}
                                    </select>
                                ) : (
                                    <p className="text-[11px] text-amber-600 bg-amber-50 px-3 py-2 rounded-lg">No DeckLink inputs detected.</p>
                                )}
                            </div>
                        )}

                        {/* NDI source picker */}
                        {sourceKind === 'ndi' && (
                            <div className="mt-3">
                                <label className="text-[10px] font-bold text-stone-400 uppercase tracking-wider mb-1 block">NDI Source</label>
                                <div className="flex gap-2">
                                    <select
                                        value={selectedNdiSource}
                                        onChange={e => setSelectedNdiSource(e.target.value)}
                                        disabled={running}
                                        className="flex-1 px-3 py-2 rounded-lg border border-stone-200 text-sm"
                                    >
                                        {ndiSources.length === 0 && <option value="">No sources found — click refresh</option>}
                                        {ndiSources.map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
                                    </select>
                                    <button
                                        onClick={scanNdi}
                                        disabled={ndiScanning || running}
                                        className="p-2 bg-stone-100 rounded-lg hover:bg-stone-200 disabled:opacity-50"
                                        title="Scan for NDI sources"
                                    >
                                        <RefreshCw size={14} className={`text-stone-600 ${ndiScanning ? 'animate-spin' : ''}`} />
                                    </button>
                                </div>
                            </div>
                        )}
                    </section>

                    {/* Step 2 — SDI Output */}
                    <section>
                        <div className="flex items-center gap-2 mb-3">
                            <div className="w-6 h-6 bg-forest-dark text-white rounded-full flex items-center justify-center text-[10px] font-bold">2</div>
                            <h3 className="text-sm font-bold text-forest-dark">SDI Output</h3>
                        </div>
                        <p className="text-[11px] text-stone-500 mb-3">This is the SDI cable that goes to your web presenter (Resi, Wowza, etc.) and on to YouTube.</p>
                        <label className="text-[10px] font-bold text-stone-400 uppercase tracking-wider mb-1 block">DeckLink Output</label>
                        {outputDevices.length > 0 ? (
                            <select
                                value={outputDevice}
                                onChange={e => {
                                    const idx = Number(e.target.value);
                                    setOutputDevice(idx);
                                    const dev = devices.find(d => d.index === idx);
                                    if (dev?.displayModes?.length) {
                                        setDisplayMode(dev.displayModes[0].mode);
                                        setFrameRate(dev.displayModes[0].fps.toFixed(2));
                                    }
                                }}
                                disabled={running}
                                className="w-full px-3 py-2 rounded-lg border border-stone-200 text-sm focus:outline-none focus:border-sage-500"
                            >
                                {outputDevices.map(d => <option key={d.index} value={d.index}>{d.name}</option>)}
                            </select>
                        ) : (
                            <p className="text-[11px] text-amber-600 bg-amber-50 px-3 py-2 rounded-lg">No DeckLink outputs detected.</p>
                        )}

                        <label className="text-[10px] font-bold text-stone-400 uppercase tracking-wider mb-1 mt-3 block">Display Mode</label>
                        <select
                            value={displayMode}
                            onChange={e => {
                                const m = Number(e.target.value);
                                setDisplayMode(m);
                                const mode = currentOutputModes.find(x => x.mode === m);
                                if (mode) setFrameRate(mode.fps.toFixed(2));
                            }}
                            disabled={running}
                            className="w-full px-3 py-2 rounded-lg border border-stone-200 text-sm"
                        >
                            {currentOutputModes.map(m => (
                                <option key={m.mode} value={m.mode}>{m.name} ({m.width}×{m.height} @ {m.fps.toFixed(2)}fps)</option>
                            ))}
                        </select>
                    </section>

                    {/* Step 3 — Encoding */}
                    <section>
                        <div className="flex items-center gap-2 mb-3">
                            <div className="w-6 h-6 bg-forest-dark text-white rounded-full flex items-center justify-center text-[10px] font-bold">3</div>
                            <h3 className="text-sm font-bold text-forest-dark">Caption Encoding</h3>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                            <button
                                onClick={() => setEncodingMode('cea608')}
                                disabled={running}
                                className={`p-3 rounded-lg border text-left transition-all ${encodingMode === 'cea608' ? 'border-sage-500 bg-sage-50' : 'border-stone-200 hover:border-sage-300'} disabled:opacity-50`}
                            >
                                <p className="text-xs font-bold text-stone-800">CEA-608</p>
                                <p className="text-[10px] text-stone-500">Roll-up · universal decoders · ~60 cps</p>
                            </button>
                            <button
                                onClick={() => setEncodingMode('dtvcc')}
                                disabled={running}
                                className={`p-3 rounded-lg border text-left transition-all ${encodingMode === 'dtvcc' ? 'border-sage-500 bg-sage-50' : 'border-stone-200 hover:border-sage-300'} disabled:opacity-50`}
                            >
                                <p className="text-xs font-bold text-stone-800">CEA-708 (DTVCC)</p>
                                <p className="text-[10px] text-stone-500">Higher throughput · 608 also sent</p>
                            </button>
                        </div>
                    </section>

                    {/* Big start/stop */}
                    <button
                        onClick={running ? handleStop : handleStart}
                        disabled={starting || !addonAvailable || (sourceKind === 'ndi' && !selectedNdiSource)}
                        className={`w-full py-4 rounded-xl font-bold text-base flex items-center justify-center gap-2 shadow-lg transition-all ${
                            running ? 'bg-red-500 hover:bg-red-600 text-white shadow-red-200' : 'bg-purple-500 hover:bg-purple-600 text-white shadow-purple-200'
                        } disabled:opacity-40 disabled:cursor-not-allowed`}
                    >
                        {starting ? (
                            <><Loader2 size={18} className="animate-spin" /> Starting…</>
                        ) : running ? (
                            <><Square size={18} /> Stop Injection</>
                        ) : (
                            <><Play size={18} /> Start Injecting Captions</>
                        )}
                    </button>
                    {startError && (
                        <p className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded-lg border border-red-200">{startError}</p>
                    )}
                </div>

                {/* Right column — live runtime panel */}
                <div className="flex-1 bg-stone-50 overflow-y-auto custom-scrollbar p-6 space-y-5">
                    {/* Caption source selector */}
                    <div className="bg-white border border-stone-200 rounded-2xl p-5 shadow-sm">
                        <div className="flex items-center gap-2 mb-3">
                            <Mic size={16} className="text-purple-500" />
                            <h3 className="text-sm font-bold text-forest-dark">Caption Source</h3>
                        </div>
                        <p className="text-[11px] text-stone-500 mb-3">Where the caption text comes from. Pick one — text is encoded as CEA-608/708 and embedded in VANC.</p>
                        <div className="grid grid-cols-3 gap-2">
                            <button
                                onClick={() => setCaptionSource('live_mic')}
                                className={`p-3 rounded-lg border text-left transition-all ${captionSource === 'live_mic' ? 'border-purple-400 bg-purple-50' : 'border-stone-200 hover:border-purple-200'}`}
                            >
                                <Mic size={14} className={captionSource === 'live_mic' ? 'text-purple-600 mb-1' : 'text-stone-500 mb-1'} />
                                <p className="text-xs font-bold text-stone-800">Browser Mic</p>
                                <p className="text-[10px] text-stone-500">Web Speech API</p>
                            </button>
                            <button
                                onClick={() => setCaptionSource('external_ws')}
                                className={`p-3 rounded-lg border text-left transition-all ${captionSource === 'external_ws' ? 'border-purple-400 bg-purple-50' : 'border-stone-200 hover:border-purple-200'}`}
                            >
                                <Plug size={14} className={captionSource === 'external_ws' ? 'text-purple-600 mb-1' : 'text-stone-500 mb-1'} />
                                <p className="text-xs font-bold text-stone-800">External</p>
                                <p className="text-[10px] text-stone-500">Use main Dashboard</p>
                            </button>
                            <button
                                onClick={() => setCaptionSource('manual')}
                                className={`p-3 rounded-lg border text-left transition-all ${captionSource === 'manual' ? 'border-purple-400 bg-purple-50' : 'border-stone-200 hover:border-purple-200'}`}
                            >
                                <Send size={14} className={captionSource === 'manual' ? 'text-purple-600 mb-1' : 'text-stone-500 mb-1'} />
                                <p className="text-xs font-bold text-stone-800">Manual</p>
                                <p className="text-[10px] text-stone-500">Type & send</p>
                            </button>
                        </div>

                        {captionSource === 'live_mic' && (
                            <div className="mt-4 space-y-3">
                                <button
                                    onClick={listening ? stopListening : startListening}
                                    disabled={!running}
                                    className={`w-full py-3 rounded-xl font-bold text-sm flex items-center justify-center gap-2 transition-all ${
                                        listening ? 'bg-red-500 text-white hover:bg-red-600' : 'bg-purple-500 text-white hover:bg-purple-600'
                                    } disabled:opacity-40 disabled:cursor-not-allowed`}
                                >
                                    {listening ? (
                                        <><Square size={14} /> Stop Listening</>
                                    ) : (
                                        <><Mic size={14} /> Start Listening</>
                                    )}
                                </button>
                                {!running && (
                                    <p className="text-[10px] text-amber-600 bg-amber-50 px-2 py-1.5 rounded">Start the SDI injection first, then begin listening.</p>
                                )}
                                {micPermissionError && (
                                    <p className="text-[10px] text-red-600 bg-red-50 px-2 py-1.5 rounded">{micPermissionError}</p>
                                )}
                                {interimText && (
                                    <div className="px-3 py-2 bg-purple-50 border border-purple-200 rounded-lg">
                                        <p className="text-[10px] font-bold text-purple-600 uppercase mb-0.5">Interim</p>
                                        <p className="text-sm text-stone-700 italic">{interimText}</p>
                                    </div>
                                )}
                            </div>
                        )}

                        {captionSource === 'external_ws' && (
                            <div className="mt-4 p-3 bg-stone-50 border border-stone-200 rounded-lg text-[11px] text-stone-600 space-y-1.5">
                                <p>Use the main <strong>Live Session</strong> dashboard to drive captions. Anything that lands as a final caption on session <code className="bg-stone-100 px-1 rounded">demo</code> will be encoded and embedded automatically.</p>
                                <p className="text-stone-500">Useful when you've already got a presenter speaking through the Dashboard mic + you want to mirror those captions onto the SDI feed.</p>
                            </div>
                        )}

                        {captionSource === 'manual' && (
                            <div className="mt-4 space-y-2">
                                <textarea
                                    value={manualText}
                                    onChange={e => setManualText(e.target.value)}
                                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendManual(); } }}
                                    placeholder="Type a caption and press Enter to send. Useful for testing or emergency captions."
                                    disabled={!running}
                                    className="w-full h-20 px-3 py-2 rounded-lg border border-stone-200 text-sm resize-none focus:outline-none focus:border-purple-400 disabled:opacity-50"
                                />
                                <button
                                    onClick={handleSendManual}
                                    disabled={!running || !manualText.trim()}
                                    className="w-full py-2 bg-purple-500 hover:bg-purple-600 text-white text-xs font-bold rounded-lg disabled:opacity-40 flex items-center justify-center gap-1.5"
                                >
                                    <Send size={12} /> Send Caption
                                </button>
                            </div>
                        )}

                        {recentCaptions.length > 0 && (
                            <div className="mt-4 pt-3 border-t border-stone-100">
                                <p className="text-[10px] font-bold text-stone-400 uppercase tracking-wider mb-2">Recent — sent to SDI</p>
                                <div className="space-y-1 max-h-32 overflow-y-auto">
                                    {recentCaptions.map((c, i) => (
                                        <p key={i} className={`text-xs px-2 py-1 rounded ${i === 0 ? 'bg-green-50 text-green-700 font-medium' : 'text-stone-500'}`}>{c}</p>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Live status */}
                    <div className="bg-white border border-stone-200 rounded-2xl p-5 shadow-sm">
                        <div className="flex items-center gap-2 mb-3">
                            <Tv size={16} className="text-sage-500" />
                            <h3 className="text-sm font-bold text-forest-dark">SDI Output Status</h3>
                            {running && <div className="ml-auto flex items-center gap-1.5 px-2 py-0.5 bg-green-50 rounded-full border border-green-200">
                                <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                                <span className="text-[10px] font-bold text-green-700">ON AIR</span>
                            </div>}
                        </div>
                        {status ? (
                            <div className="grid grid-cols-2 gap-3">
                                <div className="bg-stone-50 rounded-lg p-3">
                                    <p className="text-[9px] font-bold text-stone-400 uppercase">Frames Output</p>
                                    <p className="text-xl font-mono font-bold text-stone-800">{status.framesOutput.toLocaleString()}</p>
                                </div>
                                <div className="bg-stone-50 rounded-lg p-3">
                                    <p className="text-[9px] font-bold text-stone-400 uppercase">Dropped</p>
                                    <p className={`text-xl font-mono font-bold ${status.droppedFrames > 0 ? 'text-red-500' : 'text-stone-800'}`}>{status.droppedFrames}</p>
                                </div>
                                <div className="bg-stone-50 rounded-lg p-3">
                                    <p className="text-[9px] font-bold text-stone-400 uppercase">Encoder Queue</p>
                                    <p className="text-xl font-mono font-bold text-stone-800">{status.encoderQueueDepth}</p>
                                </div>
                                <div className="bg-stone-50 rounded-lg p-3">
                                    <p className="text-[9px] font-bold text-stone-400 uppercase">Mode</p>
                                    <p className="text-xl font-mono font-bold text-stone-800 uppercase">{status.encodingMode}</p>
                                </div>
                            </div>
                        ) : (
                            <p className="text-xs text-stone-400">Loading status…</p>
                        )}
                    </div>

                    {/* Web presenter info */}
                    <div className="bg-gradient-to-br from-purple-500 to-pink-500 rounded-2xl p-5 shadow-lg text-white relative overflow-hidden">
                        <div className="absolute top-0 right-0 w-24 h-24 bg-white/10 rounded-full -translate-y-1/2 translate-x-1/2 blur-2xl"></div>
                        <div className="relative z-10">
                            <div className="flex items-center gap-2 mb-3">
                                <Youtube size={18} />
                                <h3 className="text-sm font-bold">Web Presenter / YouTube</h3>
                            </div>
                            <div className="space-y-2 text-[11px] opacity-90 mb-3">
                                <div className="flex items-start gap-2">
                                    <div className="w-4 h-4 rounded-full bg-white/20 flex items-center justify-center text-[8px] font-bold mt-0.5 shrink-0">1</div>
                                    <p>Connect this SDI output to your web presenter encoder (Resi, Wowza Streaming Engine, Pearl Mini, etc.)</p>
                                </div>
                                <div className="flex items-start gap-2">
                                    <div className="w-4 h-4 rounded-full bg-white/20 flex items-center justify-center text-[8px] font-bold mt-0.5 shrink-0">2</div>
                                    <p>Enable "pass-through CEA-608" or "embedded captions" in the encoder so it forwards the VANC data to YouTube.</p>
                                </div>
                                <div className="flex items-start gap-2">
                                    <div className="w-4 h-4 rounded-full bg-white/20 flex items-center justify-center text-[8px] font-bold mt-0.5 shrink-0">3</div>
                                    <p>Captions will appear on the YouTube broadcast within 1–2 seconds.</p>
                                </div>
                            </div>
                            {status?.presenterUrl && (
                                <div className="mt-3 pt-3 border-t border-white/20">
                                    <p className="text-[10px] font-bold uppercase opacity-70 mb-1">Audience preview URL</p>
                                    <div className="flex gap-2">
                                        <input
                                            value={status.presenterUrl}
                                            readOnly
                                            className="flex-1 px-3 py-2 rounded-lg text-[11px] bg-white/15 placeholder:text-white/50 text-white font-mono outline-none"
                                        />
                                        <button onClick={copyPresenterUrl} className="px-3 py-2 bg-white text-purple-700 text-xs font-bold rounded-lg hover:bg-purple-50 flex items-center gap-1.5">
                                            {copied ? <><CheckCircle size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
                                        </button>
                                    </div>
                                    <p className="text-[9px] opacity-60 mt-1.5">Lets you preview the captions as they go out (does not affect the SDI broadcast).</p>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Tech reference */}
                    <div className="bg-white border border-stone-200 rounded-2xl p-4">
                        <p className="text-[10px] font-bold text-stone-400 uppercase tracking-wider mb-2">How injection works</p>
                        <ul className="text-[11px] text-stone-500 space-y-1 leading-relaxed">
                            <li>• Caption text → CEA-608 byte pairs (Roll-Up 2) or CEA-708 Service 1 blocks</li>
                            <li>• Wrapped in SMPTE 334 CDP packets</li>
                            <li>• Embedded in SDI VANC ancillary data (DID 0x61, SDID 0x01, line 9)</li>
                            <li>• Native DeckLink output emits the SDI with captions at {frameRate} fps</li>
                            <li>• Web presenter passes VANC through; YouTube re-renders as broadcast CC</li>
                        </ul>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default CaptionInjection;
