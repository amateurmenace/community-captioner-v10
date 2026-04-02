
import React, { useState, useRef, useEffect } from 'react';
import { X, Layout, Cast, Check, Move, Type, Tv, Copy, RefreshCw, Trash2, Signal, AlertTriangle, Monitor, Play, Square } from 'lucide-react';
import { OverlaySettings, DeckLinkDevice, DeckLinkStatus } from '../types';

interface Cea708Status {
  endpoint: string;
  localEndpoint: string;
  networkEndpoint: string;
  connectedBridges: number;
  status: 'active' | 'waiting';
}

interface OutputSettingsProps {
  settings: OverlaySettings;
  setSettings: (s: OverlaySettings) => void;
  outputMode: 'browser_overlay' | 'rtmp_embed' | 'sdi_cea708';
  setOutputMode: (m: 'browser_overlay' | 'rtmp_embed' | 'sdi_cea708') => void;
  onClose: () => void;
  onLaunch: () => void;
  previewText?: string;
  cea708Enabled: boolean;
  setCea708Enabled: (v: boolean) => void;
  onCea708Clear?: () => void;
}

const OutputSettings: React.FC<OutputSettingsProps> = ({ settings, setSettings, onClose, onLaunch, outputMode, setOutputMode, previewText, cea708Enabled, setCea708Enabled, onCea708Clear }) => {

  const canvasRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [cea708Status, setCea708Status] = useState<Cea708Status | null>(null);
  const [copied, setCopied] = useState(false);

  // DeckLink state — works via Electron IPC or REST API
  const hasElectronDeckLink = !!(window as any).decklink?.available;
  const [hasDeckLink, setHasDeckLink] = useState(hasElectronDeckLink);
  const [isDesktopApp, setIsDesktopApp] = useState(false);
  const [addonError, setAddonError] = useState<string | null>(null);
  const [dlDevices, setDlDevices] = useState<DeckLinkDevice[]>([]);
  const [dlSelectedDevice, setDlSelectedDevice] = useState<number>(0);
  const [dlSelectedInputDevice, setDlSelectedInputDevice] = useState<number>(0);
  const [dlSelectedMode, setDlSelectedMode] = useState<number>(0);
  const [dlOutputMode, setDlOutputMode] = useState<'standalone' | 'passthrough' | 'ndi_passthrough'>('standalone');
  const [dlStatus, setDlStatus] = useState<DeckLinkStatus | null>(null);
  const [dlStarting, setDlStarting] = useState(false);
  const [ndiSources, setNdiSources] = useState<{name: string; url: string}[]>([]);
  const [selectedNdiSource, setSelectedNdiSource] = useState<string>('');
  const [ndiScanning, setNdiScanning] = useState(false);

  // Drag Logic
  const handleMouseDown = (e: React.MouseEvent) => {
    setIsDragging(true);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging || !canvasRef.current) return;

    const rect = canvasRef.current.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;

    // Clamp values
    const clampedX = Math.max(0, Math.min(100 - settings.width, x));
    const clampedY = Math.max(0, Math.min(100 - 10, y));

    setSettings({ ...settings, x: clampedX, y: clampedY });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  useEffect(() => {
    window.addEventListener('mouseup', handleMouseUp);
    return () => window.removeEventListener('mouseup', handleMouseUp);
  }, []);

  // Helper: get relay base URL
  const getRelayUrl = () => {
    const port = window.location.port || (window.location.protocol === 'https:' ? '443' : '80');
    const p = parseInt(port);
    const relayPort = (p >= 5173 && p <= 5199) ? '8080' : port;
    return `${window.location.protocol}//${window.location.hostname}:${relayPort}`;
  };

  // Check if DeckLink is available (Electron IPC or REST API)
  useEffect(() => {
    if (outputMode !== 'sdi_cea708') return;
    if (hasElectronDeckLink) { setHasDeckLink(true); setIsDesktopApp(true); return; }

    // Check via REST API
    const check = async () => {
      try {
        const res = await fetch(`${getRelayUrl()}/api/decklink/devices`);
        if (res.ok) {
          const data = await res.json();
          if (data.isDesktopApp) setIsDesktopApp(true);
          if (data.available) {
            setHasDeckLink(true);
            setAddonError(null);
          } else if (data.isDesktopApp) {
            // We're in the desktop app but addon didn't load
            setAddonError(data.error || 'DeckLink addon not loaded');
          }
        }
      } catch(e) {}
    };
    check();
  }, [outputMode]);

  // Enumerate DeckLink devices when SDI tab opens
  useEffect(() => {
    if (outputMode !== 'sdi_cea708' || !hasDeckLink) return;

    const enumerate = async () => {
        try {
            let devices: DeckLinkDevice[];
            if (hasElectronDeckLink) {
                devices = await (window as any).decklink.enumerateDevices();
            } else {
                const res = await fetch(`${getRelayUrl()}/api/decklink/devices`);
                const data = await res.json();
                devices = data.devices || [];
            }
            setDlDevices(devices);
            const firstOutput = devices.find((d: DeckLinkDevice) => d.hasOutput);
            if (firstOutput) {
                setDlSelectedDevice(firstOutput.index);
                if (firstOutput.displayModes?.length > 0) {
                    setDlSelectedMode(firstOutput.displayModes[0].mode);
                }
            }
            const firstInput = devices.find((d: DeckLinkDevice) => d.hasInput);
            if (firstInput) setDlSelectedInputDevice(firstInput.index);
        } catch(e) {
            console.warn('DeckLink enumerate failed', e);
        }
    };
    enumerate();
  }, [outputMode, hasDeckLink]);

  // Poll DeckLink status
  useEffect(() => {
    if (outputMode !== 'sdi_cea708' || !hasDeckLink) return;

    const pollStatus = async () => {
        try {
            let status: DeckLinkStatus;
            if (hasElectronDeckLink) {
                status = await (window as any).decklink.getStatus();
            } else {
                const res = await fetch(`${getRelayUrl()}/api/decklink/status`);
                status = await res.json();
            }
            setDlStatus(status);
        } catch(e) {}
    };
    pollStatus();
    const interval = setInterval(pollStatus, 1000);
    return () => clearInterval(interval);
  }, [outputMode, hasDeckLink]);

  // Scan NDI sources
  const scanNdiSources = async () => {
    setNdiScanning(true);
    try {
      const res = await fetch(`${getRelayUrl()}/api/ndi/sources`);
      const data = await res.json();
      setNdiSources(data.sources || []);
      if (data.sources?.length > 0 && !selectedNdiSource) {
        setSelectedNdiSource(data.sources[0].name);
      }
    } catch(e) {
      console.warn('NDI scan failed', e);
    }
    setNdiScanning(false);
  };

  // Auto-scan NDI sources when NDI mode selected
  useEffect(() => {
    if (outputMode === 'sdi_cea708' && dlOutputMode === 'ndi_passthrough' && hasDeckLink) {
      scanNdiSources();
    }
  }, [dlOutputMode, outputMode, hasDeckLink]);

  // Poll CEA-708 bridge status (only if no DeckLink available — pure bridge mode)
  useEffect(() => {
    if (outputMode !== 'sdi_cea708' || hasDeckLink) return;

    const fetchStatus = async () => {
        try {
            const res = await fetch(`${getRelayUrl()}/api/cea708`);
            if (res.ok) {
                const data = await res.json();
                setCea708Status(data);
            }
        } catch(e) {
            console.warn('Failed to fetch CEA-708 status', e);
        }
    };

    fetchStatus();
    const interval = setInterval(fetchStatus, 3000);
    return () => clearInterval(interval);
  }, [outputMode, hasDeckLink]);

  const handleCopyUrl = (url: string) => {
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Constants for Preview Calculation (Must match Overlay.tsx logic but scaled)
  const PREVIEW_SCALE = 0.6;
  const LINE_HEIGHT = 1.5;
  const PADDING_PX = 32 * PREVIEW_SCALE; // 1rem padding scaled

  const previewFontSize = settings.fontSize * PREVIEW_SCALE;
  const maxHeight = (previewFontSize * LINE_HEIGHT * settings.maxLines) + PADDING_PX;

  const defaultText = "This is a preview of your captions. Drag this box to position it exactly where you want it on the stream. It will grow to fit text.";

  return (
    <div className="absolute inset-0 z-50 bg-cream flex flex-col animate-fade-in font-sans">
      <div className="h-20 border-b border-stone-200 px-8 flex items-center justify-between bg-white/80 backdrop-blur sticky top-0">
          <h2 className="text-xl font-bold font-display text-forest-dark">Caption Output Designer</h2>
          <button onClick={onClose} className="p-2 hover:bg-stone-100 rounded-full text-stone-500"><X /></button>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar Controls */}
        <div className="w-80 bg-white border-r border-stone-200 p-6 overflow-y-auto space-y-8 z-10">
            <div>
                <label className="text-xs font-bold text-stone-400 uppercase tracking-wider mb-4 block">Output Method</label>
                <div className="grid grid-cols-3 gap-2">
                    <button
                        onClick={() => setOutputMode('browser_overlay')}
                        className={`p-3 rounded-lg border text-xs font-bold ${outputMode === 'browser_overlay' ? 'border-sage-500 bg-sage-50 text-forest-dark' : 'border-stone-200 text-stone-500'}`}
                    >
                        Overlay
                    </button>
                    <button
                        onClick={() => setOutputMode('sdi_cea708')}
                        className={`p-3 rounded-lg border text-xs font-bold ${outputMode === 'sdi_cea708' ? 'border-sage-500 bg-sage-50 text-forest-dark' : 'border-stone-200 text-stone-500'}`}
                    >
                        SDI CC
                    </button>
                    <button
                        onClick={() => setOutputMode('rtmp_embed')}
                        className={`p-3 rounded-lg border text-xs font-bold ${outputMode === 'rtmp_embed' ? 'border-sage-500 bg-sage-50 text-forest-dark' : 'border-stone-200 text-stone-500'}`}
                    >
                        RTMP
                    </button>
                </div>
            </div>

            {outputMode === 'sdi_cea708' && hasDeckLink && (
                <>
                    {/* DeckLink Output Device */}
                    <div>
                        <label className="text-xs font-bold text-stone-400 uppercase tracking-wider mb-4 block">DeckLink Output</label>
                        {dlDevices.length > 0 ? (
                            <select
                                value={dlSelectedDevice}
                                onChange={e => {
                                    const idx = Number(e.target.value);
                                    setDlSelectedDevice(idx);
                                    const dev = dlDevices.find(d => d.index === idx);
                                    if (dev?.displayModes?.length) setDlSelectedMode(dev.displayModes[0].mode);
                                }}
                                className="w-full bg-stone-50 border border-stone-200 rounded-lg p-3 text-sm font-bold"
                            >
                                {dlDevices.filter(d => d.hasOutput).map(d => (
                                    <option key={d.index} value={d.index}>{d.name}</option>
                                ))}
                            </select>
                        ) : (
                            <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg">
                                <p className="text-sm font-bold text-amber-700">No DeckLink Devices Found</p>
                                <p className="text-xs text-amber-600 mt-1">Install Blackmagic Desktop Video drivers and connect a DeckLink card.</p>
                            </div>
                        )}
                    </div>

                    {dlDevices.length > 0 && (
                        <>
                            {/* Output Mode — 3 options */}
                            <div>
                                <label className="text-xs font-bold text-stone-400 uppercase tracking-wider mb-4 block">Video Source</label>
                                <div className="grid grid-cols-3 gap-2">
                                    <button
                                        onClick={() => setDlOutputMode('standalone')}
                                        className={`p-3 rounded-lg border text-xs font-bold text-left ${dlOutputMode === 'standalone' ? 'border-sage-500 bg-sage-50 text-forest-dark' : 'border-stone-200 text-stone-500'}`}
                                    >
                                        <Monitor size={14} className="mb-1" />
                                        Standalone
                                        <p className="text-[10px] font-normal opacity-60 mt-0.5">Black + CC</p>
                                    </button>
                                    <button
                                        onClick={() => setDlOutputMode('passthrough')}
                                        className={`p-3 rounded-lg border text-xs font-bold text-left ${dlOutputMode === 'passthrough' ? 'border-sage-500 bg-sage-50 text-forest-dark' : 'border-stone-200 text-stone-500'}`}
                                    >
                                        <Signal size={14} className="mb-1" />
                                        SDI In
                                        <p className="text-[10px] font-normal opacity-60 mt-0.5">Pass-Through</p>
                                    </button>
                                    <button
                                        onClick={() => setDlOutputMode('ndi_passthrough')}
                                        className={`p-3 rounded-lg border text-xs font-bold text-left ${dlOutputMode === 'ndi_passthrough' ? 'border-sage-500 bg-sage-50 text-forest-dark' : 'border-stone-200 text-stone-500'}`}
                                    >
                                        <Cast size={14} className="mb-1" />
                                        NDI
                                        <p className="text-[10px] font-normal opacity-60 mt-0.5">IP → SDI + CC</p>
                                    </button>
                                </div>
                            </div>

                            {/* SDI Input Device (pass-through only) */}
                            {dlOutputMode === 'passthrough' && (
                                <div>
                                    <label className="text-xs font-bold text-stone-400 uppercase tracking-wider mb-4 block">SDI Input Device</label>
                                    <select
                                        value={dlSelectedInputDevice}
                                        onChange={e => setDlSelectedInputDevice(Number(e.target.value))}
                                        className="w-full bg-stone-50 border border-stone-200 rounded-lg p-3 text-sm"
                                    >
                                        {dlDevices.filter(d => d.hasInput).map(d => (
                                            <option key={d.index} value={d.index}>{d.name}</option>
                                        ))}
                                    </select>
                                </div>
                            )}

                            {/* NDI Source (NDI passthrough only) */}
                            {dlOutputMode === 'ndi_passthrough' && (
                                <div>
                                    <label className="text-xs font-bold text-stone-400 uppercase tracking-wider mb-4 block">NDI Source</label>
                                    <div className="space-y-2">
                                        <div className="flex gap-2">
                                            <select
                                                value={selectedNdiSource}
                                                onChange={e => setSelectedNdiSource(e.target.value)}
                                                className="flex-1 bg-stone-50 border border-stone-200 rounded-lg p-3 text-sm"
                                            >
                                                {ndiSources.length === 0 && <option value="">No sources found</option>}
                                                {ndiSources.map(s => (
                                                    <option key={s.name} value={s.name}>{s.name}</option>
                                                ))}
                                            </select>
                                            <button
                                                onClick={scanNdiSources}
                                                disabled={ndiScanning}
                                                className="p-3 bg-stone-100 rounded-lg hover:bg-stone-200 transition-colors disabled:opacity-50"
                                                title="Scan for NDI sources"
                                            >
                                                <RefreshCw size={14} className={`text-stone-600 ${ndiScanning ? 'animate-spin' : ''}`} />
                                            </button>
                                        </div>
                                        {ndiSources.length === 0 && !ndiScanning && (
                                            <p className="text-[10px] text-stone-400">No NDI sources on network. Click refresh to scan.</p>
                                        )}
                                    </div>
                                </div>
                            )}

                            {/* Display Mode */}
                            <div>
                                <label className="text-xs font-bold text-stone-400 uppercase tracking-wider mb-4 block">Display Mode</label>
                                <select
                                    value={dlSelectedMode}
                                    onChange={e => setDlSelectedMode(Number(e.target.value))}
                                    className="w-full bg-stone-50 border border-stone-200 rounded-lg p-3 text-sm"
                                >
                                    {(dlDevices.find(d => d.index === dlSelectedDevice)?.displayModes || []).map(m => (
                                        <option key={m.mode} value={m.mode}>
                                            {m.name} ({m.width}x{m.height} @ {m.fps.toFixed(2)}fps)
                                        </option>
                                    ))}
                                </select>
                            </div>

                            {/* Status */}
                            {dlStatus && dlStatus.running && (
                                <div>
                                    <label className="text-xs font-bold text-stone-400 uppercase tracking-wider mb-4 block">Output Status</label>
                                    <div className="bg-green-50 p-4 rounded-lg border border-green-200">
                                        <div className="flex items-center gap-2 mb-2">
                                            <Signal size={14} className="text-green-600 animate-pulse" />
                                            <span className="text-sm font-bold text-green-700">
                                                {dlStatus.mode === 'ndi_passthrough' ? 'NDI → SDI Active' :
                                                 dlStatus.mode === 'passthrough' ? 'SDI Pass-Through Active' :
                                                 'Standalone Output Active'}
                                            </span>
                                        </div>
                                        <div className="grid grid-cols-2 gap-2 mt-2">
                                            <div className="text-xs text-stone-500">
                                                <span className="font-bold">{dlStatus.framesOutput.toLocaleString()}</span> frames
                                            </div>
                                            <div className="text-xs text-stone-500">
                                                <span className="font-bold text-red-500">{dlStatus.droppedFrames}</span> dropped
                                            </div>
                                        </div>
                                        {(dlStatus as any).ndiSource && (
                                            <p className="text-[10px] text-stone-400 mt-2">Source: {(dlStatus as any).ndiSource}</p>
                                        )}
                                    </div>
                                </div>
                            )}

                            {/* Controls */}
                            <div>
                                <label className="text-xs font-bold text-stone-400 uppercase tracking-wider mb-4 block">Controls</label>
                                <div className="space-y-2">
                                    <button
                                        onClick={async () => {
                                            if (dlStatus?.running) {
                                                // Stop
                                                if (hasElectronDeckLink) {
                                                    await (window as any).decklink.stop();
                                                } else {
                                                    await fetch(`${getRelayUrl()}/api/decklink/stop`, { method: 'POST' });
                                                }
                                                setCea708Enabled(false);
                                            } else {
                                                setDlStarting(true);
                                                try {
                                                    const selectedDev = dlDevices.find(d => d.index === dlSelectedDevice);
                                                    const mode = selectedDev?.displayModes?.find(m => m.mode === dlSelectedMode);
                                                    const fpsStr = mode ? String(mode.fps.toFixed(2)) : '29.97';

                                                    let ok = false;

                                                    if (hasElectronDeckLink) {
                                                        // Electron IPC path
                                                        if (dlOutputMode === 'passthrough') {
                                                            ok = await (window as any).decklink.startPassthrough({
                                                                inputDevice: dlSelectedInputDevice, outputDevice: dlSelectedDevice,
                                                                displayMode: dlSelectedMode, frameRate: fpsStr
                                                            });
                                                        } else if (dlOutputMode === 'ndi_passthrough') {
                                                            ok = await (window as any).decklink.startNdiPassthrough({
                                                                ndiSource: selectedNdiSource, outputDevice: dlSelectedDevice,
                                                                displayMode: dlSelectedMode, frameRate: fpsStr
                                                            });
                                                        } else {
                                                            ok = await (window as any).decklink.startOutput({
                                                                deviceIndex: dlSelectedDevice, displayMode: dlSelectedMode, frameRate: fpsStr
                                                            });
                                                        }
                                                    } else {
                                                        // REST API path
                                                        let endpoint = '';
                                                        let body: any = {};

                                                        if (dlOutputMode === 'ndi_passthrough') {
                                                            endpoint = '/api/ndi/start';
                                                            body = { ndiSource: selectedNdiSource, outputDevice: dlSelectedDevice,
                                                                     displayMode: dlSelectedMode, frameRate: fpsStr };
                                                        } else if (dlOutputMode === 'passthrough') {
                                                            endpoint = '/api/decklink/start';
                                                            body = { mode: 'passthrough', inputDevice: dlSelectedInputDevice,
                                                                     outputDevice: dlSelectedDevice, displayMode: dlSelectedMode, frameRate: fpsStr };
                                                        } else {
                                                            endpoint = '/api/decklink/start';
                                                            body = { mode: 'standalone', deviceIndex: dlSelectedDevice,
                                                                     displayMode: dlSelectedMode, frameRate: fpsStr };
                                                        }

                                                        const res = await fetch(`${getRelayUrl()}${endpoint}`, {
                                                            method: 'POST',
                                                            headers: { 'Content-Type': 'application/json' },
                                                            body: JSON.stringify(body)
                                                        });
                                                        const data = await res.json();
                                                        ok = data.ok;
                                                    }
                                                    if (ok) setCea708Enabled(true);
                                                } catch(e) {
                                                    console.error('DeckLink start failed', e);
                                                }
                                                setDlStarting(false);
                                            }
                                        }}
                                        disabled={dlStarting || (dlOutputMode === 'ndi_passthrough' && !selectedNdiSource)}
                                        className={`w-full p-3 rounded-lg font-bold text-sm flex items-center justify-center gap-2 transition-all ${
                                            dlStatus?.running
                                                ? 'bg-red-500 hover:bg-red-600 text-white'
                                                : 'bg-forest-dark hover:bg-forest-light text-white'
                                        } disabled:opacity-50`}
                                    >
                                        {dlStarting ? (
                                            <><RefreshCw size={14} className="animate-spin" /> Starting...</>
                                        ) : dlStatus?.running ? (
                                            <><Square size={14} /> Stop Output</>
                                        ) : (
                                            <><Play size={14} /> Start Output</>
                                        )}
                                    </button>
                                    <button
                                        onClick={async () => {
                                            if (hasElectronDeckLink) {
                                                (window as any).decklink.clearCaptions();
                                            } else {
                                                await fetch(`${getRelayUrl()}/api/decklink/clear`, { method: 'POST' });
                                            }
                                        }}
                                        disabled={!dlStatus?.running}
                                        className="w-full p-3 rounded-lg border border-stone-200 text-sm font-bold text-stone-600 hover:bg-red-50 hover:border-red-200 hover:text-red-600 transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                                    >
                                        <Trash2 size={14} /> Clear Captions
                                    </button>
                                </div>
                            </div>
                        </>
                    )}

                    {/* Info */}
                    <div className="bg-stone-50 p-4 rounded-lg border border-stone-200">
                        <p className="text-xs font-bold text-stone-600 mb-2">
                            {dlOutputMode === 'ndi_passthrough' ? 'NDI → SDI + Captions' : 'Direct DeckLink Output'}
                        </p>
                        <p className="text-[11px] text-stone-500">
                            {dlOutputMode === 'ndi_passthrough'
                                ? 'Receives NDI video, converts to SDI, and embeds CEA-708 captions in VANC. Audio is resampled to 48kHz.'
                                : 'CEA-608 Roll-Up 2 encoded in-app and embedded as CEA-708 CDP in SDI VANC data via DeckLink SDK.'}
                        </p>
                        <div className="mt-3 pt-3 border-t border-stone-200">
                            <p className="text-[10px] text-stone-400">ASCII only (0x20-0x7E) | ~60 chars/sec at 29.97fps</p>
                        </div>
                    </div>
                </>
            )}

            {outputMode === 'sdi_cea708' && !hasDeckLink && isDesktopApp && (
                <>
                    {/* Desktop app is running but native addon not loaded */}
                    <div className="p-5 bg-amber-50 border border-amber-200 rounded-xl">
                        <div className="flex items-start gap-3 mb-4">
                            <Monitor size={24} className="text-amber-600 mt-0.5 shrink-0" />
                            <div>
                                <p className="text-sm font-bold text-amber-800">DeckLink Addon Not Found</p>
                                <p className="text-xs text-amber-700 mt-1 leading-relaxed">
                                    The native DeckLink addon (<code className="bg-amber-100 px-1 rounded">decklink_addon.node</code>) was not found.
                                    It must be compiled on this machine and placed next to the executable.
                                </p>
                            </div>
                        </div>
                        {addonError && (
                            <div className="bg-amber-100 rounded-lg p-3 mb-3">
                                <p className="text-[11px] font-mono text-amber-800">{addonError}</p>
                            </div>
                        )}
                        <div className="bg-white rounded-lg p-4 border border-amber-200">
                            <p className="text-xs font-bold text-stone-700 mb-2">Setup Steps</p>
                            <ol className="text-[11px] text-stone-600 space-y-1.5 list-decimal list-inside">
                                <li>Install <a href="https://www.blackmagicdesign.com/support/" target="_blank" rel="noopener noreferrer" className="text-blue-600 underline">Blackmagic Desktop Video</a> drivers</li>
                                <li>Install <a href="https://visualstudio.microsoft.com/visual-cpp-build-tools/" target="_blank" rel="noopener noreferrer" className="text-blue-600 underline">Visual Studio Build Tools</a> with C++ workload</li>
                                <li>Clone the repo and run: <code className="bg-stone-100 px-1 rounded">npm run build:native</code></li>
                                <li>Copy <code className="bg-stone-100 px-1 rounded">decklink_addon.node</code> next to the .exe</li>
                                <li>Restart the application</li>
                            </ol>
                        </div>
                    </div>
                </>
            )}

            {outputMode === 'sdi_cea708' && !hasDeckLink && !isDesktopApp && (
                <>
                    {/* Not running from desktop app at all */}
                    <div className="p-5 bg-amber-50 border border-amber-200 rounded-xl">
                        <div className="flex items-start gap-3 mb-4">
                            <Monitor size={24} className="text-amber-600 mt-0.5 shrink-0" />
                            <div>
                                <p className="text-sm font-bold text-amber-800">Desktop App Required</p>
                                <p className="text-xs text-amber-700 mt-1 leading-relaxed">
                                    Embedded SDI captions require the desktop app with a Blackmagic DeckLink device.
                                    The desktop app includes NDI receive, DeckLink SDI output, and CEA-708 caption embedding.
                                </p>
                            </div>
                        </div>
                        <div className="space-y-2">
                            <a href="https://github.com/amateurmenace/community-captioner-v10/releases/latest"
                               target="_blank" rel="noopener noreferrer"
                               className="w-full p-3 rounded-lg bg-forest-dark hover:bg-forest-light text-white text-sm font-bold flex items-center justify-center gap-2 transition-all">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                                Download Desktop App
                            </a>
                            <div className="grid grid-cols-2 gap-2">
                                <a href="https://github.com/amateurmenace/community-captioner-v10/releases/latest/download/Community.Captioner-6.1.0-arm64.dmg"
                                   className="p-2 rounded-lg border border-stone-200 text-xs font-bold text-stone-600 hover:bg-stone-100 text-center transition-all">
                                    macOS (Apple Silicon)
                                </a>
                                <a href="https://github.com/amateurmenace/community-captioner-v10/releases/latest/download/CommuntiCaptioner.exe"
                                   className="p-2 rounded-lg border border-stone-200 text-xs font-bold text-stone-600 hover:bg-stone-100 text-center transition-all">
                                    Windows (x64)
                                </a>
                            </div>
                        </div>
                    </div>

                    <div className="bg-stone-50 p-4 rounded-lg border border-stone-200">
                        <p className="text-xs font-bold text-stone-600 mb-2">What You Get</p>
                        <ul className="text-[11px] text-stone-500 space-y-1.5 list-disc list-inside">
                            <li>NDI video receive with audio passthrough</li>
                            <li>DeckLink SDI output with VANC caption embedding</li>
                            <li>CEA-608 Roll-Up 2 / CEA-708 Service 1 encoding</li>
                            <li>All cloud features (Context Engine, translation, etc.)</li>
                        </ul>
                        <div className="mt-3 pt-3 border-t border-stone-200">
                            <p className="text-[10px] text-stone-400">Requires Blackmagic DeckLink hardware + Desktop Video drivers</p>
                        </div>
                    </div>
                </>
            )}

            {outputMode === 'browser_overlay' && (
                <>
                    <div>
                        <label className="text-xs font-bold text-stone-400 uppercase tracking-wider mb-4 block">Dimensions</label>
                        <div className="space-y-4">
                            <div>
                                <div className="flex justify-between text-xs mb-1 font-bold text-stone-600"><span>Width</span><span>{Math.round(settings.width)}%</span></div>
                                <input
                                    type="range" min="20" max="100"
                                    value={settings.width}
                                    onChange={(e) => setSettings({...settings, width: Number(e.target.value)})}
                                    className="w-full accent-forest-dark"
                                />
                            </div>
                             <div>
                                <div className="flex justify-between text-xs mb-1 font-bold text-stone-600"><span>Max Lines</span><span>{settings.maxLines}</span></div>
                                <input
                                    type="range" min="1" max="10"
                                    value={settings.maxLines}
                                    onChange={(e) => setSettings({...settings, maxLines: Number(e.target.value)})}
                                    className="w-full accent-forest-dark"
                                />
                            </div>
                        </div>
                    </div>

                    <div>
                        <label className="text-xs font-bold text-stone-400 uppercase tracking-wider mb-4 block">Typography</label>
                         <div className="space-y-4">
                            <div>
                                <div className="flex justify-between text-xs mb-1 font-bold text-stone-600"><span>Size</span><span>{settings.fontSize}px</span></div>
                                <input
                                    type="range" min="16" max="96"
                                    value={settings.fontSize}
                                    onChange={(e) => setSettings({...settings, fontSize: Number(e.target.value)})}
                                    className="w-full accent-forest-dark"
                                />
                            </div>
                            <select
                                value={settings.fontFamily}
                                onChange={e => setSettings({...settings, fontFamily: e.target.value})}
                                className="w-full bg-stone-50 border border-stone-200 rounded p-2 text-sm"
                            >
                                <option value="sans-serif">Inter (Sans)</option>
                                <option value="serif">Merriweather (Serif)</option>
                                <option value="monospace">Roboto Mono</option>
                                <option value="'Space Grotesk', sans-serif">Space Grotesk</option>
                            </select>
                            <div className="flex gap-2">
                                {['left', 'center', 'right'].map((align) => (
                                    <button
                                        key={align}
                                        onClick={() => setSettings({...settings, textAlign: align as any})}
                                        className={`flex-1 p-2 rounded border ${settings.textAlign === align ? 'bg-sage-100 border-sage-500' : 'border-stone-200'}`}
                                    >
                                        <Type size={16} className="mx-auto" />
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>

                    <div>
                        <label className="text-xs font-bold text-stone-400 uppercase tracking-wider mb-4 block">Colors</label>
                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className="text-xs block mb-1">Text</label>
                                <div className="flex items-center gap-2">
                                    <input type="color" value={settings.color} onChange={e => setSettings({...settings, color: e.target.value})} className="w-8 h-8 rounded cursor-pointer border-none" />
                                    <span className="text-xs font-mono">{settings.color}</span>
                                </div>
                            </div>
                            <div>
                                <label className="text-xs block mb-1">Background</label>
                                <select
                                    value={settings.backgroundColor}
                                    onChange={e => setSettings({...settings, backgroundColor: e.target.value})}
                                    className="w-full text-xs p-2 bg-stone-50 rounded"
                                >
                                    <option value="rgba(0,0,0,0.8)">Black 80%</option>
                                    <option value="rgba(0,0,0,0.5)">Black 50%</option>
                                    <option value="rgba(0,0,255,0.8)">Blue</option>
                                    <option value="transparent">Transparent</option>
                                </select>
                            </div>
                        </div>
                    </div>

                    {/* Overlay Output URL */}
                    <div>
                        <label className="text-xs font-bold text-stone-400 uppercase tracking-wider mb-4 block">Overlay URL</label>
                        <p className="text-[11px] text-stone-500 mb-2">Add this URL as a Browser Source in OBS/vMix/Wirecast:</p>
                        <div className="flex items-center gap-2">
                            <input type="text" readOnly
                                value={`${window.location.protocol}//${window.location.hostname}:${(() => { const p = parseInt(window.location.port || '80'); return (p >= 5173 && p <= 5199) ? '8080' : window.location.port || '80'; })()}/?view=overlay&session=demo`}
                                className="flex-1 bg-stone-900 text-green-400 text-xs font-mono p-3 rounded-lg border-none" />
                            <button onClick={() => {
                                const p = parseInt(window.location.port || '80');
                                const relayPort = (p >= 5173 && p <= 5199) ? '8080' : (window.location.port || '80');
                                navigator.clipboard.writeText(`${window.location.protocol}//${window.location.hostname}:${relayPort}/?view=overlay&session=demo`);
                            }}
                                className="p-3 bg-stone-100 rounded-lg hover:bg-stone-200 transition-colors">
                                <Copy size={14} className="text-stone-500" />
                            </button>
                        </div>
                        <p className="text-[10px] text-stone-400 mt-1">Transparent background, auto-sizes to your settings above.</p>
                    </div>
                </>
            )}
        </div>

        {/* Preview Area */}
        <div className="flex-1 bg-stone-100 flex items-center justify-center p-8 overflow-hidden relative">
            {outputMode === 'sdi_cea708' ? (
                /* CEA-708 SDI Preview */
                <div className="max-w-3xl w-full">
                    <div className="aspect-video bg-stone-900 rounded-xl overflow-hidden shadow-2xl ring-1 ring-stone-700 relative">
                        {/* Simulated broadcast monitor */}
                        <div className="absolute inset-0 flex flex-col">
                            {/* Monitor header */}
                            <div className="flex items-center justify-between px-4 py-2 bg-stone-800/50">
                                <div className="flex items-center gap-2">
                                    <div className={`w-2 h-2 rounded-full ${dlStatus?.running ? 'bg-green-400 animate-pulse' : cea708Enabled ? 'bg-amber-400' : 'bg-stone-600'}`} />
                                    <span className="text-[10px] font-mono text-stone-400">
                                        {dlStatus?.running
                                            ? dlStatus.mode === 'ndi_passthrough' ? 'NDI → SDI OUTPUT' : dlStatus.mode === 'passthrough' ? 'SDI PASSTHROUGH' : 'SDI OUTPUT'
                                            : 'SDI OUTPUT'}
                                    </span>
                                </div>
                                <div className="flex items-center gap-3">
                                    {dlStatus?.running && (
                                        <span className="text-[10px] font-mono text-stone-500">
                                            {dlStatus.framesOutput.toLocaleString()} frames
                                        </span>
                                    )}
                                    <span className="text-[10px] font-mono text-stone-500">CEA-708</span>
                                    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${dlStatus?.running ? 'bg-green-900 text-green-300' : cea708Enabled ? 'bg-amber-900 text-amber-300' : 'bg-stone-700 text-stone-400'}`}>
                                        CC {dlStatus?.running ? 'LIVE' : cea708Enabled ? 'ON' : 'OFF'}
                                    </span>
                                </div>
                            </div>

                            {/* Video area with CC simulation */}
                            <div className="flex-1 flex items-end justify-center p-4 bg-gradient-to-t from-stone-900/80 to-transparent">
                                {(cea708Enabled || dlStatus?.running) && (
                                    <div className="w-full max-w-lg">
                                        {/* Simulated CEA-608 Roll-Up 2 display */}
                                        <div className="bg-black/80 px-4 py-2 font-mono text-sm text-white">
                                            <p className="text-stone-400 text-xs mb-1 opacity-60">Row 14</p>
                                            <p>{previewText && previewText.length > 32 ? previewText.slice(0, 32) : ''}</p>
                                            <p className="text-stone-400 text-xs mt-2 mb-1 opacity-60">Row 15</p>
                                            <p>
                                                {previewText
                                                    ? (previewText.length > 32 ? previewText.slice(32, 64) : previewText.slice(0, 32))
                                                    : 'Captions will appear here'
                                                }
                                                <span className="animate-pulse">_</span>
                                            </p>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* Signal flow diagram — adapts to current mode */}
                    <div className="mt-6 flex items-center justify-center gap-3 text-xs text-stone-400">
                        {dlOutputMode === 'ndi_passthrough' ? (
                            <>
                                <div className="bg-white px-3 py-1.5 rounded border border-stone-200 text-stone-600 font-bold">NDI Source</div>
                                <div className="text-stone-300">→</div>
                                <div className="bg-white px-3 py-1.5 rounded border border-sage-300 text-forest-dark font-bold">Community Captioner</div>
                                <div className="text-stone-300">→ VANC →</div>
                                <div className="bg-white px-3 py-1.5 rounded border border-stone-200 text-stone-600 font-bold">DeckLink SDI/HDMI</div>
                            </>
                        ) : dlOutputMode === 'passthrough' ? (
                            <>
                                <div className="bg-white px-3 py-1.5 rounded border border-stone-200 text-stone-600 font-bold">SDI Input</div>
                                <div className="text-stone-300">→</div>
                                <div className="bg-white px-3 py-1.5 rounded border border-sage-300 text-forest-dark font-bold">Community Captioner</div>
                                <div className="text-stone-300">→ VANC →</div>
                                <div className="bg-white px-3 py-1.5 rounded border border-stone-200 text-stone-600 font-bold">SDI Output</div>
                            </>
                        ) : (
                            <>
                                <div className="bg-white px-3 py-1.5 rounded border border-sage-300 text-forest-dark font-bold">Community Captioner</div>
                                <div className="text-stone-300">→ VANC →</div>
                                <div className="bg-white px-3 py-1.5 rounded border border-stone-200 text-stone-600 font-bold">DeckLink SDI/HDMI</div>
                            </>
                        )}
                    </div>

                    {/* Live stats when running */}
                    {dlStatus?.running && (
                        <div className="mt-4 grid grid-cols-4 gap-3">
                            <div className="bg-white p-3 rounded-lg border border-stone-200 text-center">
                                <p className="text-lg font-bold text-forest-dark">{dlStatus.framesOutput.toLocaleString()}</p>
                                <p className="text-[10px] text-stone-400 uppercase font-bold">Frames</p>
                            </div>
                            <div className="bg-white p-3 rounded-lg border border-stone-200 text-center">
                                <p className={`text-lg font-bold ${dlStatus.droppedFrames > 0 ? 'text-red-500' : 'text-green-600'}`}>{dlStatus.droppedFrames}</p>
                                <p className="text-[10px] text-stone-400 uppercase font-bold">Dropped</p>
                            </div>
                            <div className="bg-white p-3 rounded-lg border border-stone-200 text-center">
                                <p className="text-lg font-bold text-stone-700">{dlStatus.mode === 'ndi_passthrough' ? 'NDI' : dlStatus.mode === 'passthrough' ? 'SDI' : 'BLK'}</p>
                                <p className="text-[10px] text-stone-400 uppercase font-bold">Source</p>
                            </div>
                            <div className="bg-white p-3 rounded-lg border border-stone-200 text-center">
                                <p className="text-lg font-bold text-stone-700">{dlStatus.frameRate || '29.97'}</p>
                                <p className="text-[10px] text-stone-400 uppercase font-bold">FPS</p>
                            </div>
                        </div>
                    )}
                </div>
            ) : (
                /* Existing Browser Overlay Preview */
                <>
                    <div className="absolute top-4 left-4 z-10 bg-white/80 px-4 py-2 rounded-lg text-xs font-bold text-stone-500 pointer-events-none">
                        1920 x 1080 Canvas Preview
                    </div>

                    <div
                        ref={canvasRef}
                        onMouseMove={handleMouseMove}
                        className="aspect-video bg-[url('https://images.unsplash.com/photo-1556761175-5973dc0f32e7?ixlib=rb-4.0.3&auto=format&fit=crop&w=1920&q=80')] bg-cover relative shadow-2xl rounded-lg overflow-hidden w-full max-w-5xl ring-1 ring-stone-300"
                    >
                        <div
                            onMouseDown={handleMouseDown}
                            style={{
                                position: 'absolute',
                                left: `${settings.x}%`,
                                top: `${settings.y}%`,
                                width: `${settings.width}%`,
                                backgroundColor: settings.backgroundColor,
                                color: settings.color,
                                fontFamily: settings.fontFamily,
                                fontSize: `${previewFontSize}px`,
                                textAlign: settings.textAlign,
                                cursor: isDragging ? 'grabbing' : 'grab',
                                padding: `${PADDING_PX/2}px`,
                                borderRadius: '6px',
                                maxHeight: `${maxHeight}px`,
                                display: 'flex',
                                flexDirection: 'column',
                                justifyContent: 'flex-end',
                            }}
                            className="hover:ring-2 ring-forest-light select-none group"
                        >
                            <div className="absolute -top-3 -right-3 bg-white text-forest-dark p-1 rounded-full shadow-sm opacity-0 group-hover:opacity-100 transition-opacity z-10">
                                <Move size={14} />
                            </div>
                            <p style={{
                                lineHeight: LINE_HEIGHT,
                                margin: 0,
                                display: '-webkit-box',
                                WebkitLineClamp: settings.maxLines,
                                WebkitBoxOrient: 'vertical',
                                overflow: 'hidden'
                            }}>
                                {previewText && previewText.trim().length > 0 ? previewText : defaultText}
                            </p>
                        </div>
                    </div>
                </>
            )}
        </div>
      </div>

      <div className="p-6 border-t border-stone-200 bg-white flex justify-end gap-3 sticky bottom-0 z-20">
             {outputMode === 'browser_overlay' && (
                 <button onClick={onLaunch} className="bg-forest-dark hover:bg-forest-light text-white px-8 py-3 rounded-xl font-bold transition-all shadow-lg flex items-center gap-2">
                     Launch Output Window <Layout size={18} />
                 </button>
             )}
             {outputMode === 'sdi_cea708' && (
                 <div className="flex items-center gap-4">
                     {dlStatus?.running && (
                         <div className="flex items-center gap-2 text-green-600 text-sm font-bold">
                             <Signal size={16} className="animate-pulse" />
                             {dlStatus.mode === 'ndi_passthrough' ? 'NDI → SDI Live' : dlStatus.mode === 'passthrough' ? 'SDI Live' : 'Output Live'}
                             <span className="text-stone-400 font-normal">|</span>
                             <span className="text-stone-500 font-normal">{dlStatus.framesOutput.toLocaleString()} frames</span>
                         </div>
                     )}
                     {!hasDeckLink && (
                         <button
                            onClick={() => setCea708Enabled(!cea708Enabled)}
                            className={`px-8 py-3 rounded-xl font-bold transition-all shadow-lg flex items-center gap-2 ${cea708Enabled ? 'bg-red-500 hover:bg-red-600 text-white' : 'bg-forest-dark hover:bg-forest-light text-white'}`}
                         >
                             <Tv size={18} />
                             {cea708Enabled ? 'Disable CC Output' : 'Enable CC Output'}
                         </button>
                     )}
                 </div>
             )}
      </div>
    </div>
  );
};

export default OutputSettings;
