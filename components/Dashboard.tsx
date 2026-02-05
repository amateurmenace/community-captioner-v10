import React, { useState, useEffect, useRef } from 'react';
import { Mic, StopCircle, Home, Activity, Play, Globe, Layout, ShieldCheck, Zap, Lock, CloudLightning, Wifi, Info, Captions, ExternalLink, Link as LinkIcon, Copy, Monitor, Network, Check, Pause, X, Download, ShieldAlert, Edit2, Clock, Signal, AlertTriangle, Server, Video, QrCode, Eye, Terminal, ChevronRight, ChevronDown, WifiOff, Cloud } from 'lucide-react';
import { Caption, DictionaryEntry, OperationMode, SessionStats, Notification, AudioDevice, UILanguage, OverlaySettings } from '../types';
import { useTranslation } from '../utils/i18n';
import GlobalSettings from './GlobalSettings'; 

interface DashboardProps {
  isRecording: boolean;
  setIsRecording: (val: boolean) => void;
  captions: Caption[];
  setCaptions: React.Dispatch<React.SetStateAction<Caption[]>>;
  interimText: string;
  setInterimText: (val: string) => void;
  dictionary: DictionaryEntry[];
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
}

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
  overlaySettings
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
      // Logic to determine WS URL dynamically if not set
      const getWsUrl = () => {
        const manual = localStorage.getItem('cc_relay_url');
        if (manual) return manual;
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const host = window.location.hostname;
        const port = window.location.port === '5173' ? '8080' : window.location.port;
        return `${protocol}//${host}:${port}`;
      };

      const relayUrl = getWsUrl();
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

  const MetricCard = ({ label, value, colorClass, icon: Icon }: any) => (
      <Tooltip text={`Real-time statistic for ${label}`}>
          <div className="flex flex-col items-start px-4 border-r border-stone-100 last:border-0 cursor-help min-w-[100px]">
              <span className="text-[10px] font-bold text-stone-400 uppercase tracking-wider mb-1 flex items-center gap-1">
                  {Icon && <Icon size={10} />} {label}
              </span>
              <span className={`text-xl font-display font-bold leading-none transition-colors duration-300 ${colorClass}`}>{value}</span>
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

      {/* Top Bar */}
      <div className="h-24 border-b border-stone-200 bg-white/90 backdrop-blur flex items-center justify-between px-8 shrink-0 z-30 shadow-sm relative">
        {/* Relay Disconnected Alert */}
        {!relayConnected && (
            <div className="absolute top-0 left-0 right-0 h-1 bg-red-500 overflow-hidden">
                <div className="w-full h-full bg-red-400 animate-pulse"></div>
            </div>
        )}

        <div className="flex items-center gap-6">
          <Tooltip text="Return to the main landing page">
              <button onClick={goHome} className="p-2 hover:bg-stone-100 rounded-xl transition-all hover:scale-105 active:scale-95 flex items-center justify-center">
                <BrandLogo />
              </button>
          </Tooltip>
          <div id="metrics" className="hidden lg:flex items-center bg-stone-50 rounded-xl p-2 border border-stone-100 shadow-inner">
               <MetricCard label="Duration" value={formatDuration(stats.durationSeconds)} colorClass="text-stone-800" icon={Clock} />
               <MetricCard label={t.latency} value={`${stats.latencyMs}ms`} colorClass={stats.latencyMs > 400 ? "text-red-500 animate-pulse" : "text-stone-800"} icon={Signal} />
               <MetricCard label={t.wpm} value={`${stats.wpmHistory.length > 0 ? Math.round(stats.wpmHistory[stats.wpmHistory.length - 1].wpm) : 0}`} colorClass="text-stone-800" />
               <MetricCard label={t.confidence} value={`${(stats.averageConfidence * 100).toFixed(0)}%`} colorClass={stats.averageConfidence > 0.9 ? "text-green-600" : "text-yellow-600"} />
          </div>
        </div>

        <div className="flex items-center gap-8">
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
                <Tooltip text="Manage dictionary definitions, scrape websites for context, and configure engine settings.">
                    <button id="context-btn" onClick={onOpenContext} className="flex items-center gap-2 px-6 py-2.5 bg-sage-200 hover:bg-sage-300 text-forest-dark text-sm font-bold rounded-xl border border-sage-400 transition-all shadow-sm active:scale-95">
                        <ShieldCheck size={16} /> Context Engine
                    </button>
                </Tooltip>
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
                  <select value={targetLanguage} onChange={(e) => setTargetLanguage(e.target.value)} className="bg-transparent text-xs font-bold text-stone-700 outline-none cursor-pointer py-1 w-20">
                      <option value="en">English</option>
                      <option value="es">Español</option>
                      <option value="fr">Français</option>
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
           </div>
           
           <Tooltip text="Pauses the recording (Stop) or Finishes the session completely.">
             <button 
                onClick={() => isRecording ? setIsRecording(false) : setIsRecording(true)} 
                className={`flex items-center gap-2 px-6 py-3 rounded-xl font-bold text-sm transition-all shadow-lg transform hover:-translate-y-0.5 ${isRecording ? 'bg-orange-50 text-orange-600 border border-orange-200 hover:bg-orange-100' : 'bg-forest-dark text-white hover:bg-forest-light'}`}
             >
                {isRecording ? <><Pause size={20} /> Stop</> : <><Play size={20} /> Start</>}
             </button>
          </Tooltip>
        </div>
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
                                text={m.replace('_', ' ').toUpperCase()}
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
      {showQrModal && <QrModal onClose={() => setShowQrModal(false)} />}
      {showLinkModal && <LinkModal onClose={() => setShowLinkModal(false)} />}
      <GlobalSettings isOpen={!!openSettingsTab} onClose={() => setOpenSettingsTab(null)} initialTab={openSettingsTab === 'cloud' ? 'cloud' : 'local'} appState={{...stats, ...{apiKey: localStorage.getItem('cc_api_key'), localServerUrl: localStorage.getItem('cc_local_url')}} as any} setAppState={() => {}} />
    </div>
  );
};

export default Dashboard;