import React, { useState, useEffect, useRef } from 'react';
import { Cpu, Mic, StopCircle, Home, Activity, Play, Globe, Layout, ShieldCheck, Zap, Lock, CloudLightning, Wifi, Info, Captions, ExternalLink, Link as LinkIcon, Copy, Monitor, Network, Check, Pause, X, Download, ShieldAlert, Edit2, Clock, Signal, AlertTriangle, Server, Video, QrCode, Eye, Terminal, ChevronRight, ChevronDown, WifiOff, Cloud } from 'lucide-react';
import { Caption, DictionaryEntry, OperationMode, SessionStats, Notification, AudioDevice, UILanguage, OverlaySettings, LocalEngineInfo } from '../types';
import { useTranslation } from '../utils/i18n';
import { LANGUAGES } from '../utils/languages';
import GlobalSettings from './GlobalSettings';

interface DashboardProps {
  isRecording: boolean;
  setIsRecording: (val: boolean) => void;
  captions: Caption[];
  setCaptions: React.Dispatch<React.SetStateAction<Caption[]>>;
  interimText: string;
  setInterimText: (val: string) => void;
  dictionary: DictionaryEntry[];
  setDictionary?: React.Dispatch<React.SetStateAction<DictionaryEntry[]>>;
  mode: OperationMode;
  setMode: (val: OperationMode) => void;
  stats: SessionStats;
  updateStats: (words: number, confidence: number, correction?: string) => void;
  onOpenContext: () => void;
  onEndSession: () => void;
  openObsView: () => void;
  targetLanguage: string;
  setTargetLanguage: (lang: string) => void;
  goHome: () => void;
  notifications: Notification[];
  audioSourceId: string;
  setAudioSourceId: (val: string) => void;
  activeContextName: string | null;
  uiLanguage: UILanguage;
  profanityFilter: boolean;
  currentStream: MediaStream | null; 
  onEditCaption: (id: string, newText: string) => void;
  overlaySettings: OverlaySettings; // Added Prop
  cea708Enabled: boolean;
  /** Rules proposed from the operator's caption edits (App.handleEditCaption) */
  editSuggestions?: { id: string; original: string; replacement: string }[];
  onAcceptEditSuggestion?: (id: string) => void;
  onDismissEditSuggestion?: (id: string) => void;
  /** Local speech server status (Local / Fully Local modes) */
  localEngine?: LocalEngineInfo;
  onOpenLocalSetup?: () => void;
}

// What each capture mode does — shown as tooltips on the mode switcher
const MODE_INFO: Record<OperationMode, { label: string; desc: string }> = {
    balanced:    { label: 'Browser',       desc: 'Web Speech API — Chrome/Edge send audio to Google\'s speech service. Free, zero setup.' },
    cloud:       { label: 'Cloud',         desc: 'Gemini Transcribe Live. Best accuracy on names; needs a Gemini API key.' },
    local:       { label: 'Local speech',  desc: 'Whisper running on this machine. Audio never leaves the computer. The Context Engine uses the local AI brain if you set one up, otherwise Gemini.' },
    fully_local: { label: 'Fully local',   desc: 'Local speech + Ollama for the Context Engine. Works with no internet at all.' },
    resilience:  { label: 'Resilience',    desc: 'Browser speech with aggressive automatic retry when the network drops.' },
};

// Relay URL (WebSocket). Vite dev ports 5170-5199 map to the relay on 8080;
// a tunnel/cloud host with no explicit port keeps the default port.
const getRelayWsUrl = () => {
    const manual = localStorage.getItem('cc_relay_url');
    if (manual) return manual;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.hostname;
    const port = window.location.port;
    const p = parseInt(port || '0');
    if (p >= 5170 && p <= 5199) return `${protocol}//${host}:8080`;
    const portSuffix = port ? `:${port}` : '';
    return `${protocol}//${host}${portSuffix}`;
};
const getRelayHttpUrl = () => getRelayWsUrl().replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');

type LearnToast = { id: string; original: string; replacement: string; type: string; createdAt: number; expiresAt: number };
const LEARN_TOAST_TTL_MS = 10000;

const BrandLogo = () => (
    <div className="flex items-center gap-2">
        <svg width="28" height="28" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" className="transform hover:scale-105 transition-transform opacity-90 hover:opacity-100">
            <rect x="8" y="12" width="32" height="6" rx="3" fill="#3A574A" />
            <rect x="8" y="22" width="24" height="6" rx="3" fill="#64947F" />
            <rect x="8" y="32" width="16" height="6" rx="3" fill="#A3C0B0" />
        </svg>
        <div className="flex flex-col leading-none select-none">
            <span className="font-display font-bold text-sm tracking-tight text-forest-dark uppercase">Community Captioner</span>
            <span className="font-bold text-[10px] text-forest-dark opacity-60 ml-0.5">[CC]</span>
        </div>
    </div>
);

const LiveWaveform = ({ stream, isRecording }: { stream: MediaStream | null, isRecording: boolean }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const audioContextRef = useRef<AudioContext | null>(null);
    const analyserRef = useRef<AnalyserNode | null>(null);
    const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
    const rafRef = useRef<number | null>(null);
    const historyRef = useRef<number[]>(new Array(100).fill(0));

    useEffect(() => {
        if (!stream || !canvasRef.current) return;
        const init = async () => {
            if (!audioContextRef.current || audioContextRef.current.state === 'closed') audioContextRef.current = new AudioContext();
            const ctx = audioContextRef.current;
            if (sourceRef.current) try { sourceRef.current.disconnect(); } catch(e) {}
            if (analyserRef.current) try { analyserRef.current.disconnect(); } catch(e) {}
            analyserRef.current = ctx.createAnalyser();
            analyserRef.current.smoothingTimeConstant = 0.3;
            analyserRef.current.fftSize = 256;
            sourceRef.current = ctx.createMediaStreamSource(stream);
            sourceRef.current.connect(analyserRef.current);
            const bufferLength = analyserRef.current.frequencyBinCount;
            const dataArray = new Uint8Array(bufferLength);
            const canvas = canvasRef.current;
            const canvasCtx = canvas?.getContext('2d');
            if (!canvas || !canvasCtx) return;
            const draw = () => {
                if (!analyserRef.current) return;
                rafRef.current = requestAnimationFrame(draw);
                analyserRef.current.getByteFrequencyData(dataArray);
                let sum = 0;
                for(let i = 0; i < bufferLength; i++) sum += dataArray[i];
                const average = sum / bufferLength;
                const normalizedVol = Math.min(1.0, (average / 255) * 2.5);
                canvasCtx.clearRect(0, 0, canvas.width, canvas.height);
                if (isRecording) {
                    historyRef.current.push(normalizedVol);
                    historyRef.current.shift();
                    canvasCtx.lineWidth = 2;
                    canvasCtx.strokeStyle = '#4D7563';
                    canvasCtx.fillStyle = 'rgba(77, 117, 99, 0.2)';
                    canvasCtx.beginPath();
                    canvasCtx.moveTo(0, canvas.height);
                    for (let i = 0; i < historyRef.current.length; i++) {
                        const x = (i / historyRef.current.length) * canvas.width;
                        const h = historyRef.current[i] * canvas.height;
                        canvasCtx.lineTo(x, canvas.height - h);
                    }
                    canvasCtx.lineTo(canvas.width, canvas.height);
                    canvasCtx.closePath();
                    canvasCtx.fill();
                    canvasCtx.beginPath();
                    for (let i = 0; i < historyRef.current.length; i++) {
                         const x = (i / historyRef.current.length) * canvas.width;
                         const h = historyRef.current[i] * canvas.height;
                         if (i===0) canvasCtx.moveTo(x, canvas.height - h);
                         else canvasCtx.lineTo(x, canvas.height - h);
                    }
                    canvasCtx.stroke();
                } else {
                    const barWidth = (canvas.width / 5) - 2;
                    const meterLevel = normalizedVol; 
                    for (let i = 0; i < 5; i++) {
                         const x = i * (barWidth + 2);
                         const threshold = (i + 1) * 0.2;
                         let barHeight = 0;
                         if (meterLevel > threshold - 0.2) {
                             if (meterLevel < threshold) barHeight = ((meterLevel - (threshold - 0.2)) / 0.2) * canvas.height;
                             else barHeight = canvas.height;
                         }
                         canvasCtx.fillStyle = '#E0E0DC';
                         canvasCtx.fillRect(x, 0, barWidth, canvas.height);
                         if (barHeight > 0) {
                             canvasCtx.fillStyle = i > 3 ? '#EAB308' : '#4D7563';
                             canvasCtx.fillRect(x, canvas.height - barHeight, barWidth, barHeight);
                         }
                    }
                }
            };
            draw();
        };
        init();
        return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
    }, [stream, isRecording]);
    if (!stream) return <div className="w-24 h-8 bg-stone-100 rounded-lg flex items-center justify-center text-[10px] text-stone-400 font-bold">No Audio</div>;
    return <canvas ref={canvasRef} width={100} height={32} className="rounded-lg bg-stone-50 border border-stone-200" />;
};

const Tooltip: React.FC<{ children: React.ReactNode, text: React.ReactNode }> = ({ children, text }) => (
    <div className="relative group flex items-center justify-center">
        {children}
        <div className="absolute top-full mt-3 left-1/2 -translate-x-1/2 w-max max-w-xs px-3 py-2 bg-stone-800 text-white text-xs rounded-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50 shadow-xl whitespace-normal text-center">
            {text}
            <div className="absolute bottom-full left-1/2 -translate-x-1/2 -mb-1 border-4 border-transparent border-b-stone-800"></div>
        </div>
    </div>
);

const QrModal = ({ onClose }: { onClose: () => void }) => {
    // Generate Network URL based on LinkModal logic
    const [networkUrl, setNetworkUrl] = useState<string | null>(null);
    const [publicUrl, setPublicUrl] = useState<string | null>(null);

    useEffect(() => {
        // Same logic as LinkModal to fetch IP
        const fetchIp = async () => {
            try {
                const protocol = window.location.protocol;
                const host = window.location.hostname;
                const port = window.location.port === '5173' ? '8080' : window.location.port;
                const apiUrl = `${protocol}//${host}:${port}/api/ip`;
                const res = await fetch(apiUrl);
                if (res.ok) {
                    const data = await res.json();
                    if (data.ip) setNetworkUrl(`http://${data.ip}:${data.port}?view=audience&session=demo`);
                    if (data.publicUrl) setPublicUrl(`${data.publicUrl}?view=audience&session=demo`);
                }
            } catch (e) {}
        };
        fetchIp();
    }, []);

    // Prefer Public URL if available (better for mobile users not on VPN/Wifi)
    const url = publicUrl || networkUrl || `${window.location.origin}?view=audience&session=demo`;
    
    return (
        <div className="fixed inset-0 z-[60] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in">
             <div className="bg-white rounded-2xl shadow-2xl p-8 max-w-sm w-full text-center relative">
                 <button onClick={onClose} className="absolute top-4 right-4 text-stone-400 hover:text-stone-600"><X size={20} /></button>
                 <div className="w-16 h-16 bg-sage-100 rounded-full flex items-center justify-center mx-auto mb-4 text-forest-dark">
                     <QrCode size={32} />
                 </div>
                 <h3 className="text-xl font-bold text-forest-dark mb-2">Audience Relay</h3>
                 <p className="text-stone-500 text-sm mb-6">Scan to view live captions on a second device.</p>
                 
                 <div className="bg-white p-4 rounded-xl border border-stone-200 shadow-inner mb-6 flex justify-center">
                      <img src={`https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(url)}`} alt="QR Code" className="w-40 h-40" />
                 </div>
                 
                 <div className="flex items-center gap-2 bg-stone-50 p-3 rounded-lg border border-stone-200 text-left">
                     <div className="flex-1 truncate text-xs font-mono text-stone-600">{url}</div>
                     <button onClick={() => navigator.clipboard.writeText(url)} className="p-2 hover:bg-stone-200 rounded text-stone-500"><Copy size={14} /></button>
                 </div>
                 <div className="mt-2 text-[10px] text-stone-400 flex justify-center gap-1">
                    {publicUrl ? <span className="flex items-center gap-1 text-green-600"><Cloud size={10} /> Public Cloud Link</span> : "⚠️ Using Local Network URL"}
                 </div>
             </div>
        </div>
    );
};

const LinkModal = ({ onClose }: { onClose: () => void }) => {
     const [networkUrl, setNetworkUrl] = useState<string | null>(null);
     const [publicUrl, setPublicUrl] = useState<string | null>(null);
     const localhostUrl = `${window.location.origin}?view=output`;
     const isDevMode = window.location.port === '5173';
     
     useEffect(() => {
        const fetchIp = async () => {
            try {
                // If we are on port 5173 (vite dev), assume api is on 8080.
                // If we are on port 8080 (prod), api is relative.
                const protocol = window.location.protocol;
                const host = window.location.hostname;
                const port = window.location.port === '5173' ? '8080' : window.location.port;
                
                const apiUrl = `${protocol}//${host}:${port}/api/ip`;
                const res = await fetch(apiUrl);
                if (res.ok) {
                    const data = await res.json();
                    if (data.ip) setNetworkUrl(`http://${data.ip}:${data.port}?view=output`);
                    if (data.publicUrl) setPublicUrl(`${data.publicUrl}?view=output`);
                }
            } catch (e) {
                console.warn("Could not fetch network IP", e);
            }
        };
        fetchIp();
     }, []);

     const copy = (text: string) => {
         navigator.clipboard.writeText(text);
         // Don't close immediately to allow copying both
     };

     return (
        <div className="fixed inset-0 z-[60] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in">
             <div className="bg-white rounded-2xl shadow-2xl p-8 max-w-md w-full relative">
                 <button onClick={onClose} className="absolute top-4 right-4 text-stone-400 hover:text-stone-600"><X size={20} /></button>
                 <div className="flex items-center gap-4 mb-6">
                     <div className="w-12 h-12 bg-sage-100 rounded-xl flex items-center justify-center text-forest-dark shrink-0">
                         <Layout size={24} />
                     </div>
                     <div>
                         <h3 className="text-xl font-bold text-forest-dark">OBS / vMix Overlay</h3>
                         <p className="text-stone-500 text-sm">Add this URL as a Browser Source.</p>
                     </div>
                 </div>

                 <div className="space-y-6">
                     {/* Public Cloud URL */}
                     {publicUrl && (
                        <div className="bg-indigo-50 p-4 rounded-xl border border-indigo-100">
                             <label className="text-xs font-bold text-indigo-400 uppercase tracking-wider mb-2 flex justify-between">
                                <span className="flex items-center gap-1"><Cloud size={12} /> Public Cloud URL</span>
                                <span className="text-[10px] bg-indigo-100 text-indigo-600 px-1 rounded">Recommended</span>
                            </label>
                            <div className="flex gap-2">
                                <input readOnly value={publicUrl} className="flex-1 bg-white border border-indigo-200 rounded-lg px-4 py-3 text-sm font-mono text-indigo-900 outline-none focus:border-indigo-500" />
                                <button onClick={() => copy(publicUrl)} className="bg-indigo-600 text-white px-4 rounded-lg font-bold hover:bg-indigo-700 transition-colors">Copy</button>
                            </div>
                            <p className="text-[10px] text-indigo-400 mt-2">Accessible anywhere via the internet. Great for remote guests.</p>
                        </div>
                     )}

                     {/* Network URL */}
                     <div>
                         <label className="text-xs font-bold text-stone-400 uppercase tracking-wider mb-2 flex justify-between">
                            <span>Local Network URL</span>
                            <span className="text-[10px] bg-green-100 text-green-700 px-1 rounded">Same WiFi</span>
                         </label>
                         {networkUrl ? (
                             <div className="flex gap-2 animate-fade-in">
                                 <input readOnly value={networkUrl} className="flex-1 bg-stone-50 border border-stone-200 rounded-lg px-4 py-3 text-sm font-mono text-stone-800 outline-none focus:border-sage-500" />
                                 <button onClick={() => copy(networkUrl)} className="bg-forest-dark text-white px-4 rounded-lg font-bold hover:bg-forest-light transition-colors">Copy</button>
                             </div>
                         ) : (
                             <div className="bg-orange-50 p-3 rounded-lg border border-orange-100 text-xs text-orange-800 flex items-center gap-2">
                                <AlertTriangle size={14} />
                                Could not detect Network IP. Ensure Relay Server is running (port 8080).
                             </div>
                         )}
                     </div>
                     
                     <div className="bg-blue-50 p-4 rounded-xl border border-blue-100 text-blue-900 text-sm">
                         <strong>Pro Tip:</strong> Set CSS <code>background: transparent;</code> in OBS if the background is not clearing automatically.
                     </div>
                 </div>
             </div>
        </div>
     );
};

const Dashboard: React.FC<DashboardProps> = ({
  isRecording,
  setIsRecording,
  captions,
  setCaptions,
  interimText,
  dictionary,
  setDictionary,
  mode,
  setMode,
  stats,
  updateStats,
  onOpenContext,
  onEndSession,
  openObsView,
  targetLanguage,
  setTargetLanguage,
  goHome,
  audioSourceId,
  setAudioSourceId,
  activeContextName,
  uiLanguage,
  profanityFilter,
  currentStream,
  onEditCaption,
  notifications,
  overlaySettings,
  cea708Enabled,
  editSuggestions = [],
  onAcceptEditSuggestion,
  onDismissEditSuggestion,
  localEngine,
  onOpenLocalSetup
}) => {
  const t = useTranslation(uiLanguage);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [audioDevices, setAudioDevices] = useState<AudioDevice[]>([]);
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [showQrModal, setShowQrModal] = useState(false);
  const [showCorrections, setShowCorrections] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);
  const [openSettingsTab, setOpenSettingsTab] = useState<'cloud' | 'local' | null>(null);
  
  // Relay Logic & Broadcast Channel
  const relayWsRef = useRef<WebSocket | null>(null);
  const bcRef = useRef<BroadcastChannel | null>(null);
  const [relayConnected, setRelayConnected] = useState(false);

  // Monitor Mode (PiP)
  const pipVideoRef = useRef<HTMLVideoElement>(null);
  const pipCanvasRef = useRef<HTMLCanvasElement>(null);
  const [isPiPActive, setIsPiPActive] = useState(false);

  // 1. Establish BroadcastChannel (Zero-config local)
  useEffect(() => {
      bcRef.current = new BroadcastChannel('cc_channel');
      return () => bcRef.current?.close();
  }, []);

  // 2. Establish Connection to Relay Server (Robust Reconnect)
  useEffect(() => {
      const relayUrl = getRelayWsUrl();
      let retryTimeout: any;
      let active = true;

      const connectRelay = () => {
          const ws = new WebSocket(relayUrl);
          
          ws.onopen = () => {
              if (active) {
                  setRelayConnected(true);
                  console.log("Dashboard connected to Relay");
                  ws.send(JSON.stringify({ type: 'join', sessionId: 'demo', role: 'broadcaster' }));
              }
          };
          
          ws.onclose = () => {
              if (active) {
                  setRelayConnected(false);
                  // console.log("Relay closed, retrying in 3s...");
                  retryTimeout = setTimeout(connectRelay, 3000);
              }
          };
          
          ws.onerror = () => {
              if (active) setRelayConnected(false);
              ws.close();
          };
          
          relayWsRef.current = ws;
      };

      connectRelay();
      return () => { 
          active = false; 
          if (relayWsRef.current) relayWsRef.current.close(); 
          clearTimeout(retryTimeout);
      };
  }, []);

  // 2b. Auto-Learn: poll the relay for learned-name suggestions while it is enabled
  //     and surface them as toasts. Each toast auto-accepts after 10s unless rejected
  //     (or auto-accept is paused). Accepted entries go straight into the dictionary.
  const [learnEnabled, setLearnEnabled] = useState(false);
  const [learnKeyReady, setLearnKeyReady] = useState(true);
  const [learnToasts, setLearnToasts] = useState<LearnToast[]>([]);
  const [learnAutoAccept, setLearnAutoAccept] = useState(true);
  const [learnFlash, setLearnFlash] = useState<string | null>(null);
  const seenSuggestionIds = useRef<Set<string>>(new Set());
  const learnToastsRef = useRef<LearnToast[]>([]);
  useEffect(() => { learnToastsRef.current = learnToasts; }, [learnToasts]);

  const addToDictionary = (entry: { original: string; replacement: string; type?: string }) => {
      if (!setDictionary) return;
      setDictionary(prev => {
          const k = `${entry.original.toLowerCase()}→${entry.replacement.toLowerCase()}`;
          if (prev.some(e => `${e.original.toLowerCase()}→${e.replacement.toLowerCase()}` === k)) return prev;
          return [...prev, { original: entry.original, replacement: entry.replacement, type: (entry.type as any) || 'proper_noun', source: 'auto_learned' }];
      });
  };

  const acceptLearnToast = async (t: LearnToast, silent = false) => {
      setLearnToasts(prev => prev.filter(x => x.id !== t.id));
      try {
          const res = await fetch(`${getRelayHttpUrl()}/api/context/accept`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: t.id }) });
          const data = await res.json();
          if (data.ok && data.entry) addToDictionary(data.entry);
          else addToDictionary(t);
          if (!silent) { setLearnFlash(`Learned: ${t.replacement}`); setTimeout(() => setLearnFlash(null), 2500); }
      } catch { addToDictionary(t); }
  };

  const rejectLearnToast = (t: LearnToast) => {
      setLearnToasts(prev => prev.filter(x => x.id !== t.id));
      fetch(`${getRelayHttpUrl()}/api/context/dismiss`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: t.id }) }).catch(() => {});
  };

  const toggleLearn = async () => {
      const next = !learnEnabled;
      setLearnEnabled(next);
      try {
          await fetch(`${getRelayHttpUrl()}/api/context/enable`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: next }) });
      } catch { setLearnEnabled(!next); }
  };

  useEffect(() => {
      let active = true;
      const poll = async () => {
          if (!relayConnected) return;
          try {
              const status = await fetch(`${getRelayHttpUrl()}/api/context/status`).then(r => r.json());
              if (!active) return;
              setLearnEnabled(!!status.enabled);
              setLearnKeyReady(!!status.geminiKeySet);
              if (!status.enabled) return;
              const list = await fetch(`${getRelayHttpUrl()}/api/context/suggestions`).then(r => r.json());
              if (!active || !Array.isArray(list)) return;
              const now = Date.now();
              const fresh = list.filter((s: any) => s?.id && !seenSuggestionIds.current.has(s.id));
              if (fresh.length) {
                  fresh.forEach((s: any) => seenSuggestionIds.current.add(s.id));
                  setLearnToasts(prev => [...prev, ...fresh.map((s: any) => ({ id: s.id, original: s.original, replacement: s.replacement, type: s.type || 'proper_noun', createdAt: now, expiresAt: now + LEARN_TOAST_TTL_MS }))].slice(-6));
              }
          } catch {}
      };
      poll();
      const interval = setInterval(poll, 5000);
      return () => { active = false; clearInterval(interval); };
  }, [relayConnected]);

  // Countdown ticker: auto-accept (or quietly drop) expired toasts
  const [, forceTick] = useState(0);
  useEffect(() => {
      const t = setInterval(() => {
          const now = Date.now();
          const expired = learnToastsRef.current.filter(x => x.expiresAt <= now);
          if (expired.length) {
              if (learnAutoAccept) expired.forEach(x => acceptLearnToast(x, true));
              else setLearnToasts(prev => prev.filter(x => x.expiresAt > now));
          }
          forceTick(n => n + 1);
      }, 250);
      return () => clearInterval(t);
  }, [learnAutoAccept]);

  // 3. Transmit Data (Interim)
  useEffect(() => {
      if (interimText) {
          const msg = { type: 'caption', isFinal: false, payload: { text: interimText } };
          
          // A. BroadcastChannel (Same Browser Tab)
          bcRef.current?.postMessage(msg);
          
          // B. LocalStorage (Cross-Tab Same Browser - Fallback)
          localStorage.setItem('cc_live_data', JSON.stringify(msg));
          
          // C. WebSocket (OBS / Network)
          if (relayWsRef.current && relayWsRef.current.readyState === 1) {
              relayWsRef.current.send(JSON.stringify(msg));
          }
      } 
  }, [interimText]);

  // 4. Transmit Data (Final)
  useEffect(() => {
      if (captions.length > 0) {
          const last = captions[captions.length - 1];
          // Only send recent to prevent spamming history on mount
          if (Date.now() - last.timestamp < 3000) {
               const msg = { type: 'caption', isFinal: true, payload: last };
               
               bcRef.current?.postMessage(msg);
               localStorage.setItem('cc_live_data', JSON.stringify(msg));
               
               if (relayWsRef.current && relayWsRef.current.readyState === 1) {
                   relayWsRef.current.send(JSON.stringify(msg));
               }
          }
      }
  }, [captions]);

  // 5. Transmit Settings Changes
  useEffect(() => {
      // Debounce slightly to avoid flooding WS on slider drag
      const timer = setTimeout(() => {
          if (relayWsRef.current && relayWsRef.current.readyState === 1) {
              relayWsRef.current.send(JSON.stringify({ type: 'settings', payload: overlaySettings }));
          }
      }, 100);
      return () => clearTimeout(timer);
  }, [overlaySettings]);

  useEffect(() => {
    const getDevices = async () => {
        try {
            const permStream = await navigator.mediaDevices.getUserMedia({ audio: true }); 
            permStream.getTracks().forEach(track => track.stop());
            const devices = await navigator.mediaDevices.enumerateDevices();
            const inputs = devices.filter(d => d.kind === 'audioinput').map(d => ({
                deviceId: d.deviceId,
                label: d.label || `Microphone ${d.deviceId.slice(0, 5)}...`
            }));
            setAudioDevices(inputs);
            if (inputs.length > 0 && !audioSourceId) setAudioSourceId(inputs[0].deviceId);
        } catch (err) {}
    };
    getDevices();
  }, []);

  useEffect(() => {
    if (isRecording) {
        if (previewStream) { previewStream.getTracks().forEach(t => t.stop()); setPreviewStream(null); }
        return;
    }
    let localStream: MediaStream | null = null;
    let active = true;
    const startPreview = async () => {
        if (!audioSourceId) return;
        try {
            localStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: audioSourceId } } });
            if (active) setPreviewStream(localStream);
            else localStream.getTracks().forEach(t => t.stop());
        } catch (e) {}
    };
    startPreview();
    return () => { active = false; if (localStream) localStream.getTracks().forEach(t => t.stop()); setPreviewStream(null); };
  }, [audioSourceId, isRecording]);

  useEffect(() => {
    if (scrollRef.current && !editingId) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [captions, interimText, editingId]);

  // --- PiP Monitor Logic ---
  useEffect(() => {
      // We draw to a hidden canvas to create a video stream for PiP
      // This "hacks" the browser into thinking we are playing video, keeping audio process priority high
      if (!pipCanvasRef.current || !pipVideoRef.current) return;
      
      const ctx = pipCanvasRef.current.getContext('2d');
      if (!ctx) return;
      
      let animationFrame: number;
      
      const draw = () => {
          ctx.fillStyle = isRecording ? '#1F3A2F' : '#292524';
          ctx.fillRect(0, 0, 300, 150);
          
          ctx.font = 'bold 24px sans-serif';
          ctx.fillStyle = '#fff';
          ctx.textAlign = 'center';
          ctx.fillText(isRecording ? 'ON AIR' : 'STANDBY', 150, 60);

          ctx.font = '14px sans-serif';
          ctx.fillStyle = isRecording ? '#4ade80' : '#a8a29e';
          ctx.fillText(isRecording ? `Capturing Audio...` : 'Ready', 150, 90);
          
          if (isRecording) {
             const time = Date.now() / 500;
             const size = 10 + Math.sin(time) * 5;
             ctx.beginPath();
             ctx.arc(150, 120, size, 0, Math.PI * 2);
             ctx.fillStyle = '#ef4444';
             ctx.fill();
          }

          animationFrame = requestAnimationFrame(draw);
      };
      
      draw();
      
      const stream = pipCanvasRef.current.captureStream(30);
      pipVideoRef.current.srcObject = stream;
      pipVideoRef.current.play().catch(() => {});

      return () => cancelAnimationFrame(animationFrame);
  }, [isRecording]);

  const togglePiP = async () => {
      try {
          if (document.pictureInPictureElement) {
              await document.exitPictureInPicture();
              setIsPiPActive(false);
          } else if (pipVideoRef.current) {
              await pipVideoRef.current.requestPictureInPicture();
              setIsPiPActive(true);
          }
      } catch (e) {
          console.error("PiP failed", e);
      }
  };

  const handleModeSwitch = (newMode: OperationMode) => {
      if (isRecording) return;
      const apiKey = localStorage.getItem('cc_api_key');
      
      if (newMode === 'cloud' && !apiKey) {
          setOpenSettingsTab('cloud');
          return;
      }
      setMode(newMode);
  };

  // ---- Live machine metrics (CPU / RAM / GPU / network) -------------------
  // Local models are only as good as the machine running them, so the relay
  // samples the host every 2 s (GET /api/system/metrics) while we ask for it.
  type SysMetrics = {
      ts: number;
      cpu: { percent: number | null; cores: number; loadAvg1: number; model: string };
      memory: { usedGB: number; totalGB: number; percent: number; pressure: string | null };
      gpu: { available: boolean; percent?: number; rendererPercent?: number | null; memoryUsedGB?: number | null; memoryTotalGB?: number | null; unified?: boolean; name?: string };
      network: { downKBps: number | null; upKBps: number | null; iface: string | null };
      processes: { name: string; pid: number; cpu: number | null; memGB: number; count?: number }[];
  };
  const [sys, setSys] = useState<SysMetrics | null>(null);
  const [sysHistory, setSysHistory] = useState<{ cpu: number; gpu: number; mem: number; down: number; up: number }[]>([]);
  const [showSys, setShowSys] = useState(false);
  const [sysError, setSysError] = useState(false);
  useEffect(() => {
      let stopped = false;
      const tick = async () => {
          try {
              const r = await fetch(`${getRelayHttpUrl()}/api/system/metrics`);
              const d = await r.json();
              if (stopped || !d.ok) return;
              setSys(d);
              setSysError(false);
              setSysHistory(h => [...h.slice(-39), { cpu: d.cpu.percent ?? 0, gpu: d.gpu.available ? (d.gpu.percent ?? 0) : 0, mem: d.memory.percent, down: d.network.downKBps ?? 0, up: d.network.upKBps ?? 0 }]);
          } catch { if (!stopped) setSysError(true); }
      };
      tick();
      const id = setInterval(tick, isRecording || showSys ? 2000 : 4000);
      return () => { stopped = true; clearInterval(id); };
  }, [isRecording, showSys]);
  const sysTone = (pct: number | null | undefined) => pct == null ? 'text-stone-400' : pct >= 90 ? 'text-red-500' : pct >= 70 ? 'text-amber-500' : 'text-stone-800';
  const sysBar = (pct: number | null | undefined) => pct == null ? 'bg-stone-300' : pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-400' : 'bg-sage-500';
  const fmtRate = (kb: number | null) => kb == null ? '—' : kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB/s` : `${kb} KB/s`;
  const memTone = sys?.memory.pressure === 'critical' ? 'text-red-500' : sys?.memory.pressure === 'warning' ? 'text-amber-500' : sysTone(sys?.memory.percent);
  const Spark = ({ values, max = 100, tone }: { values: number[]; max?: number; tone: string }) => (
      <div className={`flex items-end gap-px h-5 w-24 ${tone}`} aria-hidden>
          {values.map((v, i) => <div key={i} className="flex-1 bg-current rounded-[1px] opacity-70" style={{ height: `${Math.max(6, Math.min(100, (v / (max || 1)) * 100))}%` }} />)}
      </div>
  );
  const SysRow = ({ icon: Icon, label, value, pct, tone, bar, spark, sparkMax, note }: any) => (
      <div className="py-2 border-b border-stone-100 last:border-0">
          <div className="flex items-center gap-2">
              <Icon size={13} className="text-stone-400 shrink-0" />
              <span className="text-[11px] font-bold text-stone-500 uppercase tracking-wider w-16">{label}</span>
              <span className={`font-mono text-sm font-bold flex-1 ${tone}`}>{value}</span>
              <Spark values={spark} max={sparkMax} tone={tone} />
          </div>
          {pct != null && <div className="mt-1.5 ml-[22px] h-1.5 bg-stone-100 rounded-full overflow-hidden"><div className={`h-full rounded-full transition-all duration-500 ${bar}`} style={{ width: `${Math.max(1, Math.min(100, pct))}%` }} /></div>}
          {note && <p className="ml-[22px] mt-1 text-[10px] text-stone-400">{note}</p>}
      </div>
  );
  const sysWarnings: string[] = [];
  if (sys) {
      if ((sys.cpu.percent ?? 0) >= 90) sysWarnings.push(mode === 'local' || mode === 'fully_local' ? 'CPU is saturated: captions may lag. On a machine without a GPU, pick a smaller Whisper model in Local AI setup.' : 'CPU is saturated: close other apps if captions start to lag.');
      if (sys.memory.pressure === 'critical' || sys.memory.percent >= 92) sysWarnings.push('Memory is nearly full: the OS will start swapping and the models will slow down. Close other apps or choose a smaller model.');
      else if (sys.memory.pressure === 'warning') sysWarnings.push('Memory pressure is elevated. Fine for now; avoid opening more large apps.');
      if (sys.gpu.available && (sys.gpu.percent ?? 0) >= 97 && isRecording) sysWarnings.push('GPU is fully busy, which is normal while transcribing. If captions lag, Auto-Learn and translation are competing for it.');
  }
  const StatCell = ({ icon: Icon, label, value, sub, tone, spark, sparkMax }: any) => (
      <div className="flex items-center gap-2.5 min-w-0 shrink-0">
          <Icon size={13} className="text-stone-400 shrink-0" />
          <div className="leading-none">
              <div className="text-[9px] font-bold text-stone-400 uppercase tracking-wider mb-0.5">{label}</div>
              <div className={`font-display font-bold text-base whitespace-nowrap ${tone}`}>{value}{sub && <span className="text-[10px] font-sans font-medium text-stone-400 ml-1">{sub}</span>}</div>
          </div>
          <div className={`flex items-end gap-px h-6 w-24 ${tone}`} aria-hidden>
              {(spark as number[]).map((v: number, i: number) => <div key={i} className="flex-1 bg-current rounded-[1px] opacity-60" style={{ height: `${Math.max(6, Math.min(100, (v / ((sparkMax as number) || 100)) * 100))}%` }} />)}
          </div>
      </div>
  );
  const netMax = Math.max(64, ...sysHistory.map(h => h.down + h.up));
  const systemStrip = (
      <div className="relative hidden md:flex items-center gap-5 px-5 py-1.5 border-t border-stone-100 bg-stone-50/70">
          <button onClick={() => setShowSys(v => !v)} className="flex items-center gap-1.5 text-[10px] font-bold text-stone-500 uppercase tracking-wider shrink-0 hover:text-forest-dark">
              <Cpu size={12} /> This machine
          </button>
          {sys ? (
              <div className="flex items-center gap-6 flex-1 min-w-0 overflow-hidden">
                  <StatCell icon={Cpu} label="CPU" value={`${sys.cpu.percent ?? '—'}%`} sub={`${sys.cpu.cores} cores`} tone={sysTone(sys.cpu.percent)} spark={sysHistory.map(h => h.cpu)} />
                  {sys.gpu.available && <StatCell icon={Zap} label="GPU" value={`${sys.gpu.percent}%`} sub={sys.gpu.memoryUsedGB != null ? `${sys.gpu.memoryUsedGB} GB` : undefined} tone={sysTone(sys.gpu.percent)} spark={sysHistory.map(h => h.gpu)} />}
                  <StatCell icon={Activity} label="RAM" value={`${sys.memory.usedGB} GB`} sub={`of ${sys.memory.totalGB}${sys.memory.pressure && sys.memory.pressure !== 'normal' ? ` · pressure ${sys.memory.pressure}` : ''}`} tone={memTone} spark={sysHistory.map(h => h.mem)} />
                  <StatCell icon={Wifi} label="Network" value={`↓ ${fmtRate(sys.network.downKBps)}`} sub={`↑ ${fmtRate(sys.network.upKBps)}`} tone="text-stone-800" spark={sysHistory.map(h => h.down + h.up)} sparkMax={netMax} />
                  <div className="hidden xl:flex items-center gap-1.5 min-w-0">
                      {sys.processes.filter(p => !p.name.startsWith('Captioner')).map(p => (
                          <span key={p.pid} className="text-[10px] font-medium text-stone-500 bg-white border border-stone-200 rounded-full px-2 py-0.5 whitespace-nowrap">
                              {p.name.replace(' speech server', '').replace(' (local AI brain)', '')} <span className="font-mono text-stone-700">{p.cpu != null ? `${p.cpu}% · ` : ''}{p.memGB} GB</span>
                          </span>
                      ))}
                  </div>
              </div>
          ) : (
              <span className="text-xs text-stone-400 flex-1">{sysError ? 'Relay offline — no machine stats' : 'Measuring…'}</span>
          )}
          {sysWarnings.length > 0 && (
              <Tooltip text={sysWarnings.join(' ')}>
                  <span className="flex items-center gap-1 text-[10px] font-bold text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full shrink-0 cursor-help"><AlertTriangle size={11} /> {sysWarnings.length === 1 ? 'Watch this' : `${sysWarnings.length} warnings`}</span>
              </Tooltip>
          )}
          <button onClick={() => setShowSys(v => !v)} className="text-[10px] font-bold text-stone-500 hover:text-forest-dark shrink-0 flex items-center gap-1">{showSys ? <ChevronDown size={12} /> : <ChevronRight size={12} />} {showSys ? 'Hide details' : 'Details'}</button>
          {showSys && (
              <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowSys(false)} />
                  <div className="absolute top-full right-4 mt-1 w-[460px] bg-white rounded-2xl shadow-2xl border border-stone-200 p-4 z-50 text-left">
                      <div className="flex items-center justify-between mb-1">
                          <div>
                              <p className="text-sm font-bold text-forest-dark">This machine</p>
                              <p className="text-[10px] text-stone-400">{sys?.cpu.model || ''}{sys ? ` · ${sys.cpu.cores} cores · ${sys.memory.totalGB} GB RAM` : ''}{sys?.gpu.available ? ` · ${sys.gpu.name}` : ''}</p>
                          </div>
                          <button onClick={() => setShowSys(false)} className="p-1 text-stone-400 hover:text-stone-700"><X size={14} /></button>
                      </div>
                      {!sys ? (
                          <p className="text-xs text-stone-500 py-4">{sysError ? 'The relay is not reachable, so there are no machine stats.' : 'Measuring…'}</p>
                      ) : (
                          <>
                              <SysRow icon={Cpu} label="CPU" value={`${sys.cpu.percent ?? '—'}%`} pct={sys.cpu.percent} tone={sysTone(sys.cpu.percent)} bar={sysBar(sys.cpu.percent)} spark={sysHistory.map(h => h.cpu)} note={`Load ${sys.cpu.loadAvg1} on ${sys.cpu.cores} cores`} />
                              <SysRow icon={Activity} label="RAM" value={`${sys.memory.usedGB} / ${sys.memory.totalGB} GB`} pct={sys.memory.percent} tone={memTone} bar={sys.memory.pressure === 'critical' ? 'bg-red-500' : sys.memory.pressure === 'warning' ? 'bg-amber-400' : sysBar(sys.memory.percent)} spark={sysHistory.map(h => h.mem)} note={sys.memory.pressure ? `Memory pressure: ${sys.memory.pressure}` : undefined} />
                              {sys.gpu.available ? (
                                  <SysRow icon={Zap} label="GPU" value={`${sys.gpu.percent}%`} pct={sys.gpu.percent} tone={sysTone(sys.gpu.percent)} bar={sysBar(sys.gpu.percent)} spark={sysHistory.map(h => h.gpu)} note={sys.gpu.memoryUsedGB != null ? (sys.gpu.unified ? `${sys.gpu.memoryUsedGB} GB of unified memory in use by the GPU` : `${sys.gpu.memoryUsedGB} / ${sys.gpu.memoryTotalGB} GB VRAM`) : undefined} />
                              ) : (
                                  <SysRow icon={Zap} label="GPU" value="not reported" pct={null} tone="text-stone-400" bar="" spark={[]} note="Only Apple and NVIDIA GPUs report utilization here. Local models still use whatever GPU they can." />
                              )}
                              <SysRow icon={Wifi} label="Network" value={`↓ ${fmtRate(sys.network.downKBps)}   ↑ ${fmtRate(sys.network.upKBps)}`} pct={null} tone="text-stone-800" bar="" spark={sysHistory.map(h => h.down + h.up)} sparkMax={netMax} note={sys.network.iface ? `${sys.network.iface}${mode === 'local' || mode === 'fully_local' ? ' · local modes send no audio over the network; cloud modes stream it continuously' : ''}` : undefined} />
                              {sys.processes.length > 0 && (
                                  <div className="mt-2 pt-2 border-t border-stone-100">
                                      <p className="text-[10px] font-bold text-stone-400 uppercase tracking-wider mb-1">What the captioning stack is using</p>
                                      {sys.processes.map(p => (
                                          <div key={p.pid} className="flex items-center justify-between text-[11px] py-0.5">
                                              <span className="text-stone-600">{p.name}{p.count && p.count > 1 ? ` (${p.count} processes)` : ''}</span>
                                              <span className="font-mono text-stone-800">{p.cpu != null ? `${p.cpu}% CPU · ` : ''}{p.memGB} GB</span>
                                          </div>
                                      ))}
                                      {(mode === 'local' || mode === 'fully_local') && !sys.processes.some(p => p.name.startsWith('Whisper')) && (
                                          <p className="text-[10px] text-stone-400 mt-1">The speech server is not managed by this app (or not running), so it is not listed; its load still shows in the totals above.</p>
                                      )}
                                  </div>
                              )}
                              {sysWarnings.length > 0 && (
                                  <div className="mt-2 bg-amber-50 border border-amber-200 rounded-lg p-2 space-y-1">
                                      {sysWarnings.map((w, i) => <p key={i} className="text-[11px] text-amber-800 flex items-start gap-1"><AlertTriangle size={12} className="shrink-0 mt-0.5" /> {w}</p>)}
                                  </div>
                              )}
                              <p className="text-[10px] text-stone-400 mt-2">Sampled every {isRecording ? 2 : 4} seconds · {Math.max(0, Math.round((Date.now() - sys.ts) / 1000))} s ago</p>
                          </>
                      )}
                  </div>
              </>
          )}
      </div>
  );

  const MetricCard = ({ label, value, colorClass, icon: Icon }: any) => (
      <Tooltip text={`Real-time statistic for ${label}`}>
          <div className="flex flex-col items-start px-3 border-r border-stone-100 last:border-0 cursor-help min-w-[84px]">
              <span className="text-[10px] font-bold text-stone-400 uppercase tracking-wider mb-1 flex items-center gap-1">
                  {Icon && <Icon size={10} />} {label}
              </span>
              <span className={`text-lg font-display font-bold leading-none transition-colors duration-300 ${colorClass}`}>{value}</span>
          </div>
      </Tooltip>
  );

  const formatDuration = (seconds: number) => {
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = seconds % 60;
      return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const lastNotification = notifications.length > 0 ? notifications[notifications.length - 1] : null;
  const activeStream = isRecording ? currentStream : previewStream;

  return (
    <div className="flex flex-col h-full bg-cream relative">
      {/* Hidden elements for PiP Trick */}
      <canvas ref={pipCanvasRef} width={300} height={150} className="hidden" />
      <video ref={pipVideoRef} muted className="hidden" />

      {/* Top Bar — row 1: brand, session metrics, controls (wrap instead of overflowing), Start/Stop always visible; row 2: live machine stats */}
      <div className="border-b border-stone-200 bg-white/90 backdrop-blur shrink-0 z-30 shadow-sm relative">
        {/* Relay Disconnected Alert */}
        {!relayConnected && (
            <div className="absolute top-0 left-0 right-0 h-1 bg-red-500 overflow-hidden">
                <div className="w-full h-full bg-red-400 animate-pulse"></div>
            </div>
        )}

        <div className="flex items-center gap-4 px-5 py-2.5 min-h-[4.5rem]">
          <Tooltip text="Return to the main landing page">
              <button onClick={goHome} className="p-2 hover:bg-stone-100 rounded-xl transition-all hover:scale-105 active:scale-95 flex items-center justify-center shrink-0">
                <BrandLogo />
              </button>
          </Tooltip>
          <div id="metrics" className="hidden lg:flex items-center bg-stone-50 rounded-xl p-1.5 border border-stone-100 shadow-inner shrink-0">
               <MetricCard label="Duration" value={formatDuration(stats.durationSeconds)} colorClass="text-stone-800" icon={Clock} />
               <MetricCard label={t.latency} value={stats.latencySamples ? `${(stats.latencyMs / 1000).toFixed(1)}s` : '—'} colorClass={stats.latencySamples && stats.latencyMs > 3000 ? "text-red-500 animate-pulse" : stats.latencySamples && stats.latencyMs > 1500 ? "text-yellow-600" : "text-stone-800"} icon={Signal} />
               <MetricCard label={t.wpm} value={`${stats.wpmHistory.length > 0 ? Math.round(stats.wpmHistory[stats.wpmHistory.length - 1].wpm) : 0}`} colorClass="text-stone-800" />
               <MetricCard label={t.confidence} value={stats.confidenceSamples ? `${(stats.averageConfidence * 100).toFixed(0)}%` : '—'} colorClass={!stats.confidenceSamples ? "text-stone-400" : stats.averageConfidence > 0.9 ? "text-green-600" : "text-yellow-600"} />
          </div>

          <div className="flex-1 min-w-[8px]" />

          <div className="flex items-center justify-end gap-2.5 flex-wrap min-w-0">
           {/* Local speech server status (Local / Fully Local modes) */}
           {(mode === 'local' || mode === 'fully_local') && (
                <Tooltip text={isRecording
                    ? (localEngine?.connected ? `Connected to the local speech server${localEngine.model ? ` (${localEngine.model}${localEngine.device ? ` on ${localEngine.device}` : ''})` : ''}` : (localEngine?.error || 'The local speech server is not answering. Click to open the setup wizard.'))
                    : 'Local mode: audio stays on this machine. Click to check or change the speech server.'}>
                    <button onClick={onOpenLocalSetup} className={`hidden md:flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-bold transition-colors ${
                        !isRecording ? 'bg-white text-stone-600 border-stone-200 hover:bg-stone-50'
                        : localEngine?.connected ? 'bg-green-50 text-green-700 border-green-200'
                        : localEngine?.starting ? 'bg-amber-50 text-amber-700 border-amber-200'
                        : 'bg-red-50 text-red-600 border-red-200 animate-pulse'}`}>
                        <Server size={14} />
                        <span>{!isRecording ? `${MODE_INFO[mode].label} · setup` : localEngine?.connected ? `Local: ${localEngine.model ? localEngine.model.replace(/^mlx-community\//, '') : 'connected'}` : localEngine?.starting ? localEngine.starting : (localEngine?.error || 'Local server offline')}</span>
                        {isRecording && localEngine?.connected && <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />}
                    </button>
                </Tooltip>
           )}

           {/* Relay Error Indicator */}
           {!relayConnected && (
                <div className="hidden md:flex items-center gap-2 bg-red-50 text-red-600 px-3 py-1.5 rounded-lg border border-red-200 text-xs font-bold animate-pulse">
                    <WifiOff size={14} />
                    <span>Relay Disconnected</span>
                    <Tooltip text="The Relay Server (port 8080) is unreachable. Run 'npm run start' or check your terminal.">
                        <Info size={14} className="cursor-help opacity-70" />
                    </Tooltip>
                </div>
           )}

           <div className="flex flex-col items-end gap-1">
                <div className="flex items-center gap-2">
                    <Tooltip text={!learnKeyReady ? 'Auto-Learn needs a Gemini API key (Context Engine → Settings).' : learnEnabled ? 'Auto-Learn is ON: new names heard in live captions are suggested as toasts and added after 10s unless rejected.' : 'Auto-Learn is OFF. Turn on to learn names, places and acronyms from live speech.'}>
                        <button
                            onClick={toggleLearn}
                            className={`flex items-center gap-1.5 px-3 py-2.5 text-xs font-bold rounded-xl border transition-all active:scale-95 ${learnEnabled ? 'bg-green-50 text-green-700 border-green-300' : 'bg-white text-stone-500 border-stone-200 hover:bg-stone-50'}`}
                        >
                            <Zap size={14} className={learnEnabled ? 'text-green-600' : 'text-stone-400'} /> Learn
                            <span className={`w-1.5 h-1.5 rounded-full ${learnEnabled ? 'bg-green-500 animate-pulse' : 'bg-stone-300'}`} />
                            {dictionary.length > 0 && <span className="text-[10px] font-mono text-stone-400 ml-0.5">{dictionary.length}</span>}
                        </button>
                    </Tooltip>
                    <Tooltip text="Manage dictionary definitions, scrape websites for context, and configure engine settings.">
                        <button id="context-btn" onClick={onOpenContext} className="flex items-center gap-2 px-4 py-2.5 bg-sage-200 hover:bg-sage-300 text-forest-dark text-sm font-bold rounded-xl border border-sage-400 transition-all shadow-sm active:scale-95">
                            <ShieldCheck size={16} /> Context Engine
                        </button>
                    </Tooltip>
                </div>
                {activeContextName && (
                    <button onClick={() => setShowCorrections(!showCorrections)} className="flex items-center gap-1.5 bg-white text-forest-dark px-2 py-1 rounded border border-stone-200 text-[10px] font-bold hover:bg-stone-50 transition-colors shadow-sm">
                        <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></span>
                        <span className="max-w-[100px] truncate">{activeContextName}</span>
                    </button>
                )}
           </div>

           <div id="output-btn" className="hidden md:flex items-center gap-2 bg-stone-100 rounded-xl p-1.5 border border-stone-200">
              <div className="px-2 flex items-center gap-1 border-r border-stone-300/50">
                  <Globe size={14} className="text-stone-500" />
                  <select value={targetLanguage} onChange={(e) => setTargetLanguage(e.target.value)} className="bg-transparent text-xs font-bold text-stone-700 outline-none cursor-pointer py-1 w-24" title="Show a live translation next to the English captions (needs a Gemini key)">
                      {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.flag} {l.native}</option>)}
                  </select>
              </div>
              
              {/* Audience View - Shows server status */}
               <Tooltip text={`Audience Relay: ${relayConnected ? 'Online' : 'Offline (Check Terminal)'}`}>
                  <button 
                    onClick={() => setShowQrModal(true)} 
                    className={`p-2 rounded-lg transition-all shadow-sm ${relayConnected ? 'bg-green-100 text-green-700' : 'bg-red-50 text-red-600 animate-pulse'}`}
                  >
                      {relayConnected ? <QrCode size={16} /> : <WifiOff size={16} />}
                  </button>
              </Tooltip>

              {/* Monitor Mode (PiP) */}
              <Tooltip text="Monitor Mode (Keeps app active in background)">
                  <button 
                    onClick={togglePiP} 
                    className={`p-2 rounded-lg transition-all shadow-sm ${isPiPActive ? 'bg-forest-dark text-white' : 'hover:bg-white text-stone-600'}`}
                  >
                      <Eye size={16} />
                  </button>
              </Tooltip>

              <Tooltip text="Generate a URL for OBS or vMix">
                  <button onClick={() => setShowLinkModal(true)} className="p-2 hover:bg-white text-stone-600 rounded-lg transition-all shadow-sm"><LinkIcon size={16} /></button>
              </Tooltip>
              <Tooltip text="Configure size, font, and colors of the output">
                  <button onClick={openObsView} className="flex items-center gap-2 px-4 py-1.5 hover:bg-white text-xs font-bold text-stone-600 rounded-lg transition-all shadow-sm"><Layout size={16} /> Output</button>
              </Tooltip>

              {/* CEA-708 SDI Status */}
              {cea708Enabled && (
                  <Tooltip text="CEA-708 CC output is active. Captions are being forwarded to SDI bridge.">
                      <div className="flex items-center gap-1.5 px-3 py-1.5 bg-green-50 text-green-700 rounded-lg border border-green-200 text-xs font-bold">
                          <Captions size={14} />
                          <span>CC</span>
                          <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                      </div>
                  </Tooltip>
              )}
           </div>
           
          </div>

           <Tooltip text="Pauses the recording (Stop) or Finishes the session completely.">
             <button 
                onClick={() => isRecording ? setIsRecording(false) : setIsRecording(true)} 
                className={`shrink-0 flex items-center gap-2 px-6 py-3 rounded-xl font-bold text-sm transition-all shadow-lg transform hover:-translate-y-0.5 ${isRecording ? 'bg-orange-50 text-orange-600 border border-orange-200 hover:bg-orange-100' : 'bg-forest-dark text-white hover:bg-forest-light'}`}
             >
                {isRecording ? <><Pause size={20} /> Stop</> : <><Play size={20} /> Start</>}
             </button>
          </Tooltip>
        </div>

        {systemStrip}
      </div>

      <div className="flex flex-1 overflow-hidden relative">
        {/* ... (Rest of component remains the same) ... */}
        {showCorrections && (
            <div className="w-80 bg-white border-r border-stone-200 absolute left-0 top-0 bottom-0 z-20 shadow-2xl animate-slide-right flex flex-col">
                <div className="p-4 border-b border-stone-200 flex justify-between items-center bg-stone-50">
                    <h3 className="font-bold text-forest-dark flex items-center gap-2"><ShieldCheck size={16} /> Corrections Log</h3>
                    <button onClick={() => setShowCorrections(false)}><X size={16} /></button>
                </div>
                <div className="flex-1 overflow-y-auto p-4 space-y-2">
                    {stats.recentCorrections.map((c, i) => <div key={i} className="text-xs bg-sage-50 p-3 rounded-lg border border-sage-100 font-mono text-stone-700">{c}</div>)}
                </div>
            </div>
        )}

        <div className={`flex-1 flex flex-col p-8 overflow-hidden relative ${targetLanguage !== 'en' ? 'grid grid-cols-2 gap-8' : ''}`}>
           {/* Notification Banner */}
           {lastNotification && Date.now() - lastNotification.timestamp < 4000 && (
             <div onClick={() => setShowCorrections(true)} className="absolute top-4 left-1/2 -translate-x-1/2 z-20 bg-forest-dark text-white px-6 py-3 rounded-full shadow-2xl flex items-center gap-3 cursor-pointer animate-slide-down hover:scale-105 transition-transform">
                 <ShieldCheck size={18} className="text-sage-300" />
                 <div><span className="text-xs font-bold text-sage-300 block uppercase tracking-wider">Context Active</span><span className="text-sm font-medium">{lastNotification.message}</span></div>
             </div>
          )}

          <div className="flex flex-col h-full relative">
               <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-4 pr-4 pb-32 custom-scrollbar">
                    {captions.length === 0 && !interimText && (
                        <div className="h-full flex flex-col items-center justify-center text-stone-400 select-none">
                            <div className={`w-24 h-24 rounded-full flex items-center justify-center mb-6 transition-all duration-500 ${isRecording ? 'bg-red-50 scale-110 shadow-red-100 shadow-xl' : 'bg-white shadow-sm'}`}>
                                <Mic size={40} className={`transition-colors duration-300 ${isRecording ? "text-red-500" : "text-stone-300"}`} />
                            </div>
                            {isRecording ? (
                                 <p className="text-3xl font-display font-bold text-forest-dark mb-2 animate-pulse">Listening...</p>
                            ) : (
                                <div className="text-center">
                                     <p className="text-4xl sm:text-5xl font-display font-bold text-transparent bg-clip-text bg-gradient-to-r from-forest-dark via-sage-500 to-forest-dark bg-300% animate-gradient mb-2 pb-2">Ready to caption<span className="text-sage-500 animate-pulse">|</span></p>
                                     <p className="text-sm text-stone-400">Click 'Start' to begin</p>
                                </div>
                            )}
                        </div>
                    )}
                    {captions.map((cap) => (
                        <div key={cap.id} className="group relative p-4 rounded-2xl hover:bg-white transition-all border border-transparent hover:border-stone-100 hover:shadow-sm">
                            <div contentEditable={editingId === cap.id} onBlur={(e) => { onEditCaption(cap.id, e.currentTarget.textContent || ""); setEditingId(null); }} suppressContentEditableWarning className={`text-2xl leading-relaxed font-medium outline-none ${cap.corrected ? 'text-forest-dark' : 'text-stone-800'} ${editingId === cap.id ? 'bg-stone-50 p-2 rounded ring-2 ring-sage-400' : ''}`}>{cap.text}</div>
                            <button onClick={() => setEditingId(cap.id)} className="absolute top-2 right-2 text-stone-300 hover:text-forest-dark opacity-0 group-hover:opacity-100 transition-opacity"><Edit2 size={16} /></button>
                        </div>
                    ))}
                    {interimText && (
                        <div className="p-4 bg-white/50 border-2 border-dashed border-stone-200 rounded-2xl animate-pulse"><p className="text-2xl leading-relaxed text-stone-400 font-medium">{interimText}</p></div>
                    )}
               </div>
          </div>
          {targetLanguage !== 'en' && (
              <div className="flex flex-col h-full border-l border-stone-200 pl-8">
                  <h3 className="text-sm font-bold text-stone-400 uppercase tracking-wider mb-2">Translated ({targetLanguage.toUpperCase()})</h3>
                  <div className="flex-1 overflow-y-auto space-y-4 pr-4 pb-32 custom-scrollbar">
                       {captions.map((cap) => (
                           <div key={`trans-${cap.id}`} className="p-4 rounded-2xl hover:bg-sage-50 transition-all">
                               <p className="text-2xl leading-relaxed font-medium text-forest-dark">{cap.translatedText || <span className="opacity-30 animate-pulse">...</span>}</p>
                           </div>
                       ))}
                  </div>
              </div>
          )}
          
          <div className="absolute bottom-8 left-8 right-8 flex justify-center z-10 pointer-events-none">
             <div className="bg-white/90 backdrop-blur-md border border-stone-200 rounded-2xl p-3 shadow-2xl flex items-center gap-4 pointer-events-auto">
                <Tooltip text="Select Audio Source">
                    <div className="flex items-center gap-3 px-3">
                        <LiveWaveform stream={activeStream} isRecording={isRecording} />
                        <select value={audioSourceId} onChange={(e) => setAudioSourceId(e.target.value)} className="text-sm font-bold text-stone-700 bg-transparent outline-none max-w-[200px] truncate cursor-pointer" disabled={isRecording}>
                            {audioDevices.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
                        </select>
                    </div>
                </Tooltip>
                <div className="w-px h-10 bg-stone-200"></div>
                <div className="flex items-center gap-2 bg-stone-50 rounded-xl px-2 py-1">
                    <label className="text-[10px] font-bold text-stone-400 uppercase tracking-wider px-2">Mode</label>
                    <div className="flex items-center gap-1">
                        {(['balanced', 'local', 'fully_local', 'resilience', 'cloud'] as OperationMode[]).map((m) => (
                            <Tooltip
                                key={m}
                                text={`${MODE_INFO[m].label}: ${MODE_INFO[m].desc}`}
                            >
                                <button 
                                    onClick={() => handleModeSwitch(m)}
                                    className={`p-2.5 rounded-lg transition-all ${mode === m ? 'bg-white shadow-md text-forest-dark ring-1 ring-stone-200' : 'text-stone-400 hover:bg-stone-100'}`}
                                >
                                    {m === 'balanced' && <Zap size={20} />}
                                    {m === 'cloud' && <CloudLightning size={20} />}
                                    {m === 'local' && <Lock size={20} />}
                                    {m === 'fully_local' && <Server size={20} />}
                                    {m === 'resilience' && <ShieldAlert size={20} />}
                                </button>
                            </Tooltip>
                        ))}
                    </div>
                </div>
                
                <div className="w-px h-10 bg-stone-200"></div>
                
                <Tooltip text="End current session and view analytics.">
                    <button onClick={onEndSession} className="flex items-center gap-2 px-6 py-2.5 rounded-xl font-bold text-sm bg-red-50 text-red-600 border border-red-200 hover:bg-red-100 hover:border-red-300 transition-all shadow-sm active:scale-95">
                        <Download size={18} /> End
                    </button>
                </Tooltip>
             </div>
          </div>
        </div>
      </div>
      {/* Auto-Learn + operator-edit toasts (bottom-right, above the floating settings button) */}
      {(learnToasts.length > 0 || learnFlash || editSuggestions.length > 0) && (
          <div className="fixed bottom-24 right-6 z-40 w-80 space-y-2 pointer-events-none">
              {editSuggestions.map(s => (
                  <div key={s.id} className="pointer-events-auto bg-white border border-sage-300 rounded-xl shadow-xl overflow-hidden animate-slide-up">
                      <div className="p-3 flex items-center gap-3">
                          <div className="flex-1 min-w-0">
                              <p className="text-[10px] uppercase tracking-wider font-bold text-sage-600 flex items-center gap-1"><Edit2 size={10} /> From your edit — add a rule?</p>
                              <p className="text-sm truncate"><span className="text-red-400 line-through">{s.original}</span> <span className="text-stone-300">→</span> <span className="font-bold text-forest-dark">{s.replacement}</span></p>
                          </div>
                          <button onClick={() => onAcceptEditSuggestion?.(s.id)} className="px-2.5 py-1.5 rounded-lg bg-forest-dark hover:bg-forest-light text-white text-[10px] font-bold">Add rule</button>
                          <button onClick={() => onDismissEditSuggestion?.(s.id)} className="px-2.5 py-1.5 rounded-lg bg-stone-100 hover:bg-stone-200 text-stone-600 text-[10px] font-bold">No</button>
                      </div>
                  </div>
              ))}
              {learnFlash && (
                  <div className="pointer-events-auto bg-forest-dark text-white text-xs font-bold px-4 py-2 rounded-xl shadow-lg flex items-center gap-2 animate-fade-in">
                      <Check size={14} className="text-sage-300" /> {learnFlash}
                  </div>
              )}
              {learnToasts.length > 0 && (
                  <div className="pointer-events-auto flex items-center justify-between text-[10px] font-bold text-stone-500 px-1">
                      <span className="flex items-center gap-1"><Zap size={11} className="text-green-600" /> Auto-Learn suggestions</span>
                      <button onClick={() => setLearnAutoAccept(a => !a)} className={`px-2 py-0.5 rounded-full border ${learnAutoAccept ? 'bg-green-50 text-green-700 border-green-200' : 'bg-stone-100 text-stone-500 border-stone-200'}`}>
                          {learnAutoAccept ? 'auto-accept on' : 'auto-accept paused'}
                      </button>
                  </div>
              )}
              {learnToasts.map(t => {
                  const remaining = Math.max(0, t.expiresAt - Date.now());
                  const pct = Math.round((remaining / LEARN_TOAST_TTL_MS) * 100);
                  return (
                      <div key={t.id} className="pointer-events-auto bg-white border border-stone-200 rounded-xl shadow-xl overflow-hidden animate-slide-up">
                          <div className="p-3 flex items-center gap-3">
                              <div className="flex-1 min-w-0">
                                  <p className="text-[10px] uppercase tracking-wider font-bold text-stone-400">Heard in captions</p>
                                  <p className="text-sm truncate"><span className="text-red-400 line-through">{t.original}</span> <span className="text-stone-300">→</span> <span className="font-bold text-forest-dark">{t.replacement}</span></p>
                              </div>
                              <button onClick={() => acceptLearnToast(t)} className="px-2.5 py-1.5 rounded-lg bg-green-500 hover:bg-green-600 text-white text-[10px] font-bold">Accept</button>
                              <button onClick={() => rejectLearnToast(t)} className="px-2.5 py-1.5 rounded-lg bg-stone-100 hover:bg-stone-200 text-stone-600 text-[10px] font-bold">Reject</button>
                          </div>
                          <div className="h-1 bg-stone-100">
                              <div className={`h-1 ${learnAutoAccept ? 'bg-green-500' : 'bg-stone-300'}`} style={{ width: `${pct}%`, transition: 'width 250ms linear' }} />
                          </div>
                      </div>
                  );
              })}
          </div>
      )}
      {showQrModal && <QrModal onClose={() => setShowQrModal(false)} />}
      {showLinkModal && <LinkModal onClose={() => setShowLinkModal(false)} />}
      <GlobalSettings isOpen={!!openSettingsTab} onClose={() => setOpenSettingsTab(null)} initialTab={openSettingsTab === 'cloud' ? 'cloud' : 'local'} appState={{...stats, ...{apiKey: localStorage.getItem('cc_api_key'), localServerUrl: localStorage.getItem('cc_local_url')}} as any} setAppState={() => {}} />
    </div>
  );
};

export default Dashboard;