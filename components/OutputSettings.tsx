
import React, { useState, useRef, useEffect } from 'react';
import { X, Layout, Cast, Check, Move, Type } from 'lucide-react';
import { OverlaySettings } from '../types';

interface OutputSettingsProps {
  settings: OverlaySettings;
  setSettings: (s: OverlaySettings) => void;
  outputMode: 'browser_overlay' | 'rtmp_embed';
  setOutputMode: (m: 'browser_overlay' | 'rtmp_embed') => void;
  onClose: () => void;
  onLaunch: () => void;
  previewText?: string;
}

const OutputSettings: React.FC<OutputSettingsProps> = ({ settings, setSettings, onClose, onLaunch, outputMode, setOutputMode, previewText }) => {
  
  const canvasRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);

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
                <div className="grid grid-cols-2 gap-2">
                    <button 
                        onClick={() => setOutputMode('browser_overlay')}
                        className={`p-3 rounded-lg border text-sm font-bold ${outputMode === 'browser_overlay' ? 'border-sage-500 bg-sage-50 text-forest-dark' : 'border-stone-200 text-stone-500'}`}
                    >
                        Overlay
                    </button>
                    <button 
                        onClick={() => setOutputMode('rtmp_embed')}
                        className={`p-3 rounded-lg border text-sm font-bold ${outputMode === 'rtmp_embed' ? 'border-sage-500 bg-sage-50 text-forest-dark' : 'border-stone-200 text-stone-500'}`}
                    >
                        RTMP
                    </button>
                </div>
            </div>

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
            <div className="absolute top-4 left-4 z-10 bg-white/80 px-4 py-2 rounded-lg text-xs font-bold text-stone-500 pointer-events-none">
                1920 x 1080 Canvas Preview
            </div>
            
            {/* The Canvas */}
            <div 
                ref={canvasRef}
                onMouseMove={handleMouseMove}
                className="aspect-video bg-[url('https://images.unsplash.com/photo-1556761175-5973dc0f32e7?ixlib=rb-4.0.3&auto=format&fit=crop&w=1920&q=80')] bg-cover relative shadow-2xl rounded-lg overflow-hidden w-full max-w-5xl ring-1 ring-stone-300"
            >
                {/* The Draggable Caption Box */}
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
                        padding: `${PADDING_PX/2}px`, // Apply approximate scaled padding
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
        </div>
      </div>

      <div className="p-6 border-t border-stone-200 bg-white flex justify-end gap-3 sticky bottom-0 z-20">
             <button onClick={onLaunch} className="bg-forest-dark hover:bg-forest-light text-white px-8 py-3 rounded-xl font-bold transition-all shadow-lg flex items-center gap-2">
                 Launch Output Window <Layout size={18} />
             </button>
      </div>
    </div>
  );
};

export default OutputSettings;
