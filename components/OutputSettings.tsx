
import React, { useState, useRef, useEffect } from 'react';
import { X, Layout, Cast, Check, Move, Type, Tv, Copy, RefreshCw, Trash2, Signal, AlertTriangle } from 'lucide-react';
import { OverlaySettings } from '../types';

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

  // Poll CEA-708 status when SDI tab is active
  useEffect(() => {
    if (outputMode !== 'sdi_cea708') return;

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

            {outputMode === 'sdi_cea708' && (
                <>
                    {/* CEA-708 Enable Toggle */}
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

                    {/* Connection Status */}
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

                    {/* WebSocket URL */}
                    <div>
                        <label className="text-xs font-bold text-stone-400 uppercase tracking-wider mb-4 block">Bridge WebSocket URL</label>
                        <div className="space-y-2">
                            {cea708Status && (
                                <>
                                    <div className="flex items-center gap-2">
                                        <input
                                            type="text"
                                            readOnly
                                            value={cea708Status.networkEndpoint}
                                            className="flex-1 bg-stone-900 text-green-400 text-xs font-mono p-3 rounded-lg border-none"
                                        />
                                        <button
                                            onClick={() => handleCopyUrl(cea708Status.networkEndpoint)}
                                            className="p-3 bg-stone-100 rounded-lg hover:bg-stone-200 transition-colors"
                                        >
                                            {copied ? <Check size={14} className="text-green-500" /> : <Copy size={14} className="text-stone-500" />}
                                        </button>
                                    </div>
                                    <p className="text-[10px] text-stone-400">
                                        Localhost: <span className="font-mono">{cea708Status.localEndpoint}</span>
                                    </p>
                                </>
                            )}
                            {!cea708Status && (
                                <div className="flex items-center gap-2 text-stone-400 text-xs">
                                    <RefreshCw size={12} className="animate-spin" />
                                    <span>Fetching endpoint...</span>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Clear Captions */}
                    <div>
                        <label className="text-xs font-bold text-stone-400 uppercase tracking-wider mb-4 block">Controls</label>
                        <button
                            onClick={onCea708Clear}
                            disabled={!cea708Enabled || !cea708Status || cea708Status.connectedBridges === 0}
                            className="w-full p-3 rounded-lg border border-stone-200 text-sm font-bold text-stone-600 hover:bg-red-50 hover:border-red-200 hover:text-red-600 transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                        >
                            <Trash2 size={14} />
                            Clear SDI Captions
                        </button>
                    </div>

                    {/* Info Box */}
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
