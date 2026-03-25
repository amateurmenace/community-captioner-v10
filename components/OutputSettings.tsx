
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

  // DeckLink direct mode state (Electron only)
  const hasDeckLink = !!(window as any).decklink?.available;
  const [dlDevices, setDlDevices] = useState<DeckLinkDevice[]>([]);
  const [dlSelectedDevice, setDlSelectedDevice] = useState<number>(0);
  const [dlSelectedInputDevice, setDlSelectedInputDevice] = useState<number>(0);
  const [dlSelectedMode, setDlSelectedMode] = useState<number>(0);
  const [dlOutputMode, setDlOutputMode] = useState<'standalone' | 'passthrough'>('standalone');
  const [dlStatus, setDlStatus] = useState<DeckLinkStatus | null>(null);
  const [dlStarting, setDlStarting] = useState(false);

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

  // Enumerate DeckLink devices when SDI tab opens (Electron only)
  useEffect(() => {
    if (outputMode !== 'sdi_cea708' || !hasDeckLink) return;

    const enumerate = async () => {
        try {
            const devices = await (window as any).decklink.enumerateDevices();
            setDlDevices(devices);
            // Default to first output device
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

  // Poll DeckLink status when running
  useEffect(() => {
    if (outputMode !== 'sdi_cea708' || !hasDeckLink) return;

    const pollStatus = async () => {
        try {
            const status = await (window as any).decklink.getStatus();
            setDlStatus(status);
        } catch(e) {}
    };
    pollStatus();
    const interval = setInterval(pollStatus, 1000);
    return () => clearInterval(interval);
  }, [outputMode, hasDeckLink]);

  // Poll CEA-708 bridge status when SDI tab is active (web mode fallback)
  useEffect(() => {
    if (outputMode !== 'sdi_cea708' || hasDeckLink) return;

    const fetchStatus = async () => {
        try {
            const port = window.location.port || (window.location.protocol === 'https:' ? '443' : '80');
            const devPort = port === '5173' ? '8080' : port;
            const res = await fetch(`${window.location.protocol}//${window.location.hostname}:${devPort}/api/cea708`);
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
  }, [outputMode]);

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
                    {/* Direct DeckLink Mode (Electron) */}
                    <div>
                        <label className="text-xs font-bold text-stone-400 uppercase tracking-wider mb-4 block">DeckLink Device</label>
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
                            {/* Output Mode */}
                            <div>
                                <label className="text-xs font-bold text-stone-400 uppercase tracking-wider mb-4 block">Mode</label>
                                <div className="grid grid-cols-2 gap-2">
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
                                        Pass-Through
                                        <p className="text-[10px] font-normal opacity-60 mt-0.5">SDI In + CC Out</p>
                                    </button>
                                </div>
                            </div>

                            {/* Input Device (pass-through only) */}
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
                                                {dlStatus.mode === 'passthrough' ? 'Pass-Through Active' : 'Standalone Output Active'}
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
                                                await (window as any).decklink.stop();
                                                setCea708Enabled(false);
                                            } else {
                                                setDlStarting(true);
                                                try {
                                                    const selectedDev = dlDevices.find(d => d.index === dlSelectedDevice);
                                                    const mode = selectedDev?.displayModes?.find(m => m.mode === dlSelectedMode);
                                                    const fpsStr = mode ? String(mode.fps.toFixed(2)) : '29.97';

                                                    let ok = false;
                                                    if (dlOutputMode === 'passthrough') {
                                                        ok = await (window as any).decklink.startPassthrough({
                                                            inputDevice: dlSelectedInputDevice,
                                                            outputDevice: dlSelectedDevice,
                                                            displayMode: dlSelectedMode,
                                                            frameRate: fpsStr
                                                        });
                                                    } else {
                                                        ok = await (window as any).decklink.startOutput({
                                                            deviceIndex: dlSelectedDevice,
                                                            displayMode: dlSelectedMode,
                                                            frameRate: fpsStr
                                                        });
                                                    }
                                                    if (ok) setCea708Enabled(true);
                                                } catch(e) {
                                                    console.error('DeckLink start failed', e);
                                                }
                                                setDlStarting(false);
                                            }
                                        }}
                                        disabled={dlStarting}
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
                                        onClick={() => (window as any).decklink.clearCaptions()}
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
                        <p className="text-xs font-bold text-stone-600 mb-2">Direct DeckLink Output</p>
                        <p className="text-[11px] text-stone-500">CEA-608 Roll-Up 2 encoded in-app and embedded as CEA-708 CDP in SDI VANC data via DeckLink SDK.</p>
                        <div className="mt-3 pt-3 border-t border-stone-200">
                            <p className="text-[10px] text-stone-400">ASCII only (0x20-0x7E) | ~60 chars/sec at 29.97fps</p>
                        </div>
                    </div>
                </>
            )}

            {outputMode === 'sdi_cea708' && !hasDeckLink && (
                <>
                    {/* Web Mode: External Bridge UI */}
                    <div>
                        <label className="text-xs font-bold text-stone-400 uppercase tracking-wider mb-4 block">CEA-708 Closed Captions</label>
                        <div className="flex items-center justify-between bg-stone-50 p-4 rounded-lg border border-stone-200">
                            <div className="flex items-center gap-3">
                                <Tv size={20} className={cea708Enabled ? 'text-green-600' : 'text-stone-400'} />
                                <div>
                                    <p className="text-sm font-bold text-stone-700">SDI Embedding</p>
                                    <p className="text-xs text-stone-400">SMPTE 334 / CEA-708</p>
                                </div>
                            </div>
                            <button
                                onClick={() => setCea708Enabled(!cea708Enabled)}
                                className={`relative w-12 h-6 rounded-full transition-colors ${cea708Enabled ? 'bg-green-500' : 'bg-stone-300'}`}
                            >
                                <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${cea708Enabled ? 'translate-x-6' : 'translate-x-0.5'}`} />
                            </button>
                        </div>
                    </div>

                    <div>
                        <label className="text-xs font-bold text-stone-400 uppercase tracking-wider mb-4 block">Bridge Status</label>
                        <div className={`p-4 rounded-lg border ${cea708Status && cea708Status.connectedBridges > 0 ? 'bg-green-50 border-green-200' : 'bg-amber-50 border-amber-200'}`}>
                            <div className="flex items-center gap-2 mb-2">
                                {cea708Status && cea708Status.connectedBridges > 0 ? (
                                    <>
                                        <Signal size={14} className="text-green-600" />
                                        <span className="text-sm font-bold text-green-700">
                                            {cea708Status.connectedBridges} Bridge{cea708Status.connectedBridges !== 1 ? 's' : ''} Connected
                                        </span>
                                    </>
                                ) : (
                                    <>
                                        <AlertTriangle size={14} className="text-amber-600" />
                                        <span className="text-sm font-bold text-amber-700">Waiting for Bridge</span>
                                    </>
                                )}
                            </div>
                            <p className="text-xs text-stone-500">
                                {cea708Status && cea708Status.connectedBridges > 0
                                    ? 'Captions are being forwarded to SDI output via VANC.'
                                    : 'Connect the NDI-to-SDI Bridge to the WebSocket URL below.'}
                            </p>
                        </div>
                    </div>

                    <div>
                        <label className="text-xs font-bold text-stone-400 uppercase tracking-wider mb-4 block">Bridge WebSocket URL</label>
                        <div className="space-y-2">
                            {cea708Status && (
                                <>
                                    <div className="flex items-center gap-2">
                                        <input type="text" readOnly value={cea708Status.networkEndpoint}
                                            className="flex-1 bg-stone-900 text-green-400 text-xs font-mono p-3 rounded-lg border-none" />
                                        <button onClick={() => handleCopyUrl(cea708Status.networkEndpoint)}
                                            className="p-3 bg-stone-100 rounded-lg hover:bg-stone-200 transition-colors">
                                            {copied ? <Check size={14} className="text-green-500" /> : <Copy size={14} className="text-stone-500" />}
                                        </button>
                                    </div>
                                    <p className="text-[10px] text-stone-400">
                                        Localhost: <span className="font-mono">{cea708Status.localEndpoint}</span>
                                    </p>
                                </>
                            )}
                        </div>
                    </div>

                    <div>
                        <label className="text-xs font-bold text-stone-400 uppercase tracking-wider mb-4 block">Controls</label>
                        <button onClick={onCea708Clear}
                            disabled={!cea708Enabled || !cea708Status || cea708Status.connectedBridges === 0}
                            className="w-full p-3 rounded-lg border border-stone-200 text-sm font-bold text-stone-600 hover:bg-red-50 hover:border-red-200 hover:text-red-600 transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2">
                            <Trash2 size={14} /> Clear SDI Captions
                        </button>
                    </div>

                    <div className="bg-stone-50 p-4 rounded-lg border border-stone-200">
                        <p className="text-xs font-bold text-stone-600 mb-2">How It Works</p>
                        <ol className="text-[11px] text-stone-500 space-y-1.5 list-decimal list-inside">
                            <li>Captions are sent to the bridge via WebSocket</li>
                            <li>Bridge encodes as CEA-608 Roll-Up 2 mode</li>
                            <li>Embedded as CEA-708 CDP in SDI VANC data</li>
                            <li>Viewers toggle CC on their equipment</li>
                        </ol>
                        <div className="mt-3 pt-3 border-t border-stone-200">
                            <p className="text-[10px] text-stone-400">ASCII only (0x20-0x7E) | ~60 chars/sec at 29.97fps</p>
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
                                    <div className={`w-2 h-2 rounded-full ${cea708Enabled && cea708Status && cea708Status.connectedBridges > 0 ? 'bg-green-400 animate-pulse' : 'bg-stone-600'}`} />
                                    <span className="text-[10px] font-mono text-stone-400">SDI OUTPUT</span>
                                </div>
                                <div className="flex items-center gap-3">
                                    <span className="text-[10px] font-mono text-stone-500">CEA-708</span>
                                    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${cea708Enabled ? 'bg-green-900 text-green-300' : 'bg-stone-700 text-stone-400'}`}>
                                        CC {cea708Enabled ? 'ON' : 'OFF'}
                                    </span>
                                </div>
                            </div>

                            {/* Video area with CC simulation */}
                            <div className="flex-1 flex items-end justify-center p-4 bg-gradient-to-t from-stone-900/80 to-transparent">
                                {cea708Enabled && (
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

                    {/* Signal flow diagram */}
                    <div className="mt-6 flex items-center justify-center gap-3 text-xs text-stone-400">
                        <div className="bg-white px-3 py-1.5 rounded border border-stone-200 text-stone-600 font-bold">Community Captioner</div>
                        <div className="text-stone-300">--ws--&gt;</div>
                        <div className="bg-white px-3 py-1.5 rounded border border-stone-200 text-stone-600 font-bold">NDI-to-SDI Bridge</div>
                        <div className="text-stone-300">--VANC--&gt;</div>
                        <div className="bg-white px-3 py-1.5 rounded border border-stone-200 text-stone-600 font-bold">DeckLink SDI</div>
                    </div>
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
                     {cea708Status && cea708Status.connectedBridges > 0 && cea708Enabled && (
                         <div className="flex items-center gap-2 text-green-600 text-sm font-bold">
                             <Signal size={16} className="animate-pulse" />
                             Live
                         </div>
                     )}
                     <button
                        onClick={() => setCea708Enabled(!cea708Enabled)}
                        className={`px-8 py-3 rounded-xl font-bold transition-all shadow-lg flex items-center gap-2 ${cea708Enabled ? 'bg-red-500 hover:bg-red-600 text-white' : 'bg-forest-dark hover:bg-forest-light text-white'}`}
                     >
                         <Tv size={18} />
                         {cea708Enabled ? 'Disable CC Output' : 'Enable CC Output'}
                     </button>
                 </div>
             )}
      </div>
    </div>
  );
};

export default OutputSettings;
