
import React, { useState, useEffect, useRef } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL, fetchFile } from '@ffmpeg/util';
import { HighlightClip } from '../types';
import { Play, Download, Scissors, Loader2, ArrowLeft, Layers, Film, Sparkles, Youtube, Upload, AlertCircle, AlertTriangle, FileVideo, Link, RefreshCw, CheckCircle, ArrowRight, Video } from 'lucide-react';

interface HighlightStudioProps {
    clips: HighlightClip[];
    sourceFile: File | null;
    localServerUrl?: string;
    onBack: () => void;
}

const HighlightStudio: React.FC<HighlightStudioProps> = ({ clips, sourceFile, localServerUrl, onBack }) => {
    const [ffmpeg] = useState(new FFmpeg());
    const [loaded, setLoaded] = useState(false);
    const [processing, setProcessing] = useState(false);
    const [progress, setProgress] = useState(0);
    const [outputUrl, setOutputUrl] = useState<string | null>(null);
    const [config, setConfig] = useState({ aspect916: false, burnCaptions: false, padding: 1.5 });
    
    // File Management
    const [activeFile, setActiveFile] = useState<File | null>(sourceFile);
    const [importUrl, setImportUrl] = useState('');
    const [isDownloading, setIsDownloading] = useState(false);
    const [downloadProgress, setDownloadProgress] = useState(0);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const [simulationMode, setSimulationMode] = useState(false);
    const [timeRemaining, setTimeRemaining] = useState<string>('');

    useEffect(() => {
        load();
    }, []);

    useEffect(() => {
        if (sourceFile && !activeFile) setActiveFile(sourceFile);
    }, [sourceFile]);

    const load = async () => {
        try {
            const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';
            await ffmpeg.load({
                coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
                wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
            });
            setLoaded(true);
        } catch (e) {
            console.warn("FFmpeg WASM Failed to load (likely Security Headers). Switching to Simulation Mode.", e);
            setSimulationMode(true);
            setLoaded(true);
        }
    };

    const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files[0]) {
            setActiveFile(e.target.files[0]);
            setOutputUrl(null); 
        }
    };

    const handleUrlImport = async () => {
        if (!importUrl) return;
        setIsDownloading(true);
        setDownloadProgress(0);
        
        // Simulation of download progress for UI feedback
        const progressInterval = setInterval(() => {
            setDownloadProgress(prev => {
                if (prev >= 90) return prev;
                return prev + Math.random() * 10;
            });
        }, 500);

        try {
            // Check for YouTube-like URLs if we have a local server
            if (localServerUrl && (importUrl.includes('youtube.com') || importUrl.includes('youtu.be'))) {
                 const res = await fetch(`${localServerUrl}/ytdl?url=${encodeURIComponent(importUrl)}`);
                 if (!res.ok) throw new Error("Local Server failed to download video.");
                 const blob = await res.blob();
                 const file = new File([blob], "youtube_import.mp4", { type: 'video/mp4' });
                 setActiveFile(file);
                 setOutputUrl(null);
            } else {
                 // Direct file URL fetch
                 const res = await fetch(importUrl);
                 if (!res.ok) throw new Error("Failed to fetch video URL");
                 const blob = await res.blob();
                 const filename = importUrl.split('/').pop() || 'imported_video.mp4';
                 const file = new File([blob], filename, { type: blob.type });
                 setActiveFile(file);
                 setOutputUrl(null);
            }
        } catch (e) {
            // In simulation mode (often in preview), we might just mock a file if fetch fails due to CORS
            if (simulationMode) {
                // Create dummy file for UI testing
                const dummy = new File(["dummy"], "simulated_download.mp4", { type: 'video/mp4' });
                setActiveFile(dummy);
            } else {
                alert("Import failed. Ensure the URL is accessible (CORS) or use the Local Server for YouTube links.");
            }
        } finally {
            clearInterval(progressInterval);
            setDownloadProgress(100);
            setTimeout(() => {
                setIsDownloading(false);
                setDownloadProgress(0);
            }, 500);
        }
    };

    const generateReel = async () => {
        if (!loaded || !activeFile) return;
        setProcessing(true);
        setOutputUrl(null);
        setProgress(0);
        const startTime = Date.now();

        // --- SIMULATION MODE ---
        if (simulationMode) {
            let p = 0;
            const totalDuration = clips.length * 2000; // Simulated 2s per clip processing
            const interval = setInterval(() => {
                p += 5;
                setProgress(p);
                
                // Calculate remaining time
                const elapsed = Date.now() - startTime;
                const estimatedTotal = (elapsed / p) * 100;
                const remaining = Math.max(0, estimatedTotal - elapsed);
                setTimeRemaining(`${Math.ceil(remaining / 1000)}s`);

                if (p >= 100) {
                    clearInterval(interval);
                    const url = URL.createObjectURL(activeFile);
                    setOutputUrl(url);
                    setProcessing(false);
                    setTimeRemaining('');
                }
            }, totalDuration / 20);
            return;
        }
        
        // --- REAL FFMPEG MODE ---
        try {
            ffmpeg.on('progress', ({ progress }) => {
                const p = Math.round(progress * 100);
                setProgress(p);
                
                if (p > 0) {
                     const elapsed = Date.now() - startTime;
                     const estimatedTotal = (elapsed / p) * 100;
                     const remaining = Math.max(0, estimatedTotal - elapsed);
                     setTimeRemaining(`${Math.ceil(remaining / 1000)}s`);
                }
            });

            // Write File
            await ffmpeg.writeFile('input.mp4', await fetchFile(activeFile));

            const clipNames: string[] = [];

            // Cut segments
            for (let i = 0; i < clips.length; i++) {
                const c = clips[i];
                const start = Math.max(0, (c.start / 1000) - config.padding);
                const duration = ((c.end - c.start) / 1000) + (config.padding * 2);
                
                const outName = `clip_${i}.mp4`;
                
                let filters = "";
                if (config.aspect916) {
                    filters += "crop=ih*(9/16):ih,scale=720:1280,";
                }
                
                // Simple cut using -ss -t
                await ffmpeg.exec([
                    '-ss', start.toString(),
                    '-t', duration.toString(),
                    '-i', 'input.mp4',
                    '-c:v', 'libx264', '-c:a', 'aac',
                    '-vf', filters ? filters.slice(0,-1) : 'null',
                    outName
                ]);
                
                clipNames.push(`file '${outName}'`);
            }

            // Concat
            await ffmpeg.writeFile('concat_list.txt', clipNames.join('\n'));
            await ffmpeg.exec(['-f', 'concat', '-safe', '0', '-i', 'concat_list.txt', '-c', 'copy', 'output.mp4']);

            const data = await ffmpeg.readFile('output.mp4');
            const url = URL.createObjectURL(new Blob([(data as Uint8Array).buffer], { type: 'video/mp4' }));
            setOutputUrl(url);

        } catch (e) {
            console.error(e);
            alert("Video processing failed. Check console.");
        } finally {
            setProcessing(false);
            setProgress(0);
            setTimeRemaining('');
        }
    };

    if (!loaded) {
        return (
             <div className="h-full bg-cream flex flex-col items-center justify-center p-8">
                 <Loader2 size={48} className="animate-spin text-sage-500 mb-4" />
                 <p className="font-bold text-forest-dark">Loading Video Engine...</p>
             </div>
        );
    }

    return (
        <div className="h-full bg-stone-900 text-white flex flex-col font-sans">
            <div className="h-16 border-b border-white/10 flex items-center justify-between px-6 bg-stone-900 relative shrink-0">
                {simulationMode && (
                     <div className="absolute top-16 left-0 right-0 bg-orange-600 text-white text-[10px] font-bold text-center py-1 z-50">
                        <AlertTriangle size={10} className="inline mr-1" /> PREVIEW MODE: FFmpeg WASM disabled (Security Headers missing). Processing is simulated.
                     </div>
                )}
                <div className="flex items-center gap-4">
                    <button onClick={onBack} className="text-stone-400 hover:text-white"><ArrowLeft /></button>
                    <h2 className="font-bold font-display flex items-center gap-2">
                        <Film className="text-sage-400" /> Highlight Studio
                    </h2>
                </div>
                <div className="flex items-center gap-4">
                    <div className="text-xs text-stone-500 font-mono">
                        {activeFile ? activeFile.name : "No Source Loaded"}
                    </div>
                    {activeFile && (
                        <button 
                            onClick={() => setActiveFile(null)} 
                            className="text-xs flex items-center gap-1 bg-stone-800 hover:bg-stone-700 px-3 py-1.5 rounded-lg text-stone-300 transition-colors"
                        >
                            <RefreshCw size={12} /> Change Source
                        </button>
                    )}
                </div>
            </div>

            <div className="flex-1 flex overflow-hidden pt-4 relative"> 
                {/* Sidebar */}
                <div className="w-80 border-r border-white/10 bg-stone-800 p-6 flex flex-col z-10">
                     <h3 className="text-xs font-bold text-stone-400 uppercase tracking-wider mb-6">Clip Queue ({clips.length})</h3>
                     
                     <div className="flex-1 overflow-y-auto space-y-3 mb-6 custom-scrollbar">
                         {clips.map((clip, i) => (
                             <div key={clip.id} className="bg-stone-700 p-3 rounded-lg border border-white/5 text-sm group hover:bg-stone-600 transition-colors">
                                 <div className="flex justify-between text-xs text-sage-400 mb-1 font-mono">
                                     <span>Clip {i+1}</span>
                                     <span>{((clip.end - clip.start)/1000).toFixed(1)}s</span>
                                 </div>
                                 <p className="line-clamp-2 text-stone-300 group-hover:text-white">{clip.text}</p>
                             </div>
                         ))}
                         {clips.length === 0 && <p className="text-stone-500 italic text-sm">Add clips from Analytics view first.</p>}
                     </div>

                     <div className="space-y-4 pt-6 border-t border-white/10">
                         <h3 className="text-xs font-bold text-stone-400 uppercase tracking-wider">Output Settings</h3>
                         <label className="flex items-center gap-3 cursor-pointer select-none">
                             <input type="checkbox" checked={config.aspect916} onChange={e => setConfig({...config, aspect916: e.target.checked})} className="rounded bg-stone-600 border-none w-4 h-4 text-sage-500" />
                             <span className="text-sm">9:16 Social Crop (Vertical)</span>
                         </label>
                         <label className="flex items-center gap-3 cursor-pointer select-none opacity-50">
                             <input type="checkbox" checked={config.burnCaptions} disabled className="rounded bg-stone-600 border-none w-4 h-4 text-sage-500" />
                             <span className="text-sm">Burn-in Captions (Coming Soon)</span>
                         </label>
                     </div>

                     <button 
                        onClick={generateReel}
                        disabled={clips.length === 0 || processing || !activeFile}
                        className="mt-6 bg-sage-500 text-forest-dark py-4 rounded-xl font-bold hover:bg-sage-400 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-3 transition-all active:scale-95"
                     >
                         {processing ? <Loader2 className="animate-spin" /> : <Sparkles size={18} />}
                         <div className="flex flex-col items-start leading-none">
                            <span>{processing ? 'Processing...' : 'Generate Reel'}</span>
                            {processing && <span className="text-[10px] opacity-70">~{timeRemaining} remaining</span>}
                         </div>
                     </button>
                </div>

                {/* Main Content Area: Import or Preview */}
                <div className="flex-1 bg-black flex items-center justify-center relative p-8">
                    {/* Processing Overlay */}
                    {processing && (
                        <div className="absolute inset-0 bg-black/80 z-20 flex flex-col items-center justify-center backdrop-blur-sm">
                            <div className="w-64 h-2 bg-stone-800 rounded-full overflow-hidden mb-4">
                                <div className="h-full bg-sage-500 transition-all duration-300 ease-out" style={{ width: `${progress}%` }}></div>
                            </div>
                            <h3 className="text-white font-bold text-xl mb-1">{progress}% Complete</h3>
                            <p className="text-stone-400 text-sm">Stitching video segments...</p>
                        </div>
                    )}

                    {!activeFile ? (
                        <div className="max-w-xl w-full text-center space-y-8 animate-fade-in">
                             <div className="bg-stone-800/50 p-10 rounded-3xl border border-white/10 backdrop-blur-sm shadow-2xl">
                                <div className="w-20 h-20 bg-stone-800 rounded-full flex items-center justify-center mx-auto mb-6 text-stone-500 border border-white/5">
                                    <FileVideo size={36} />
                                </div>
                                <h3 className="text-3xl font-display font-bold mb-3 text-white">Select Source Video</h3>
                                <p className="text-stone-400 mb-10 text-sm leading-relaxed">Load the full recording file to start generating clips based on your selected timestamps.</p>

                                <div className="grid grid-cols-2 gap-4 mb-6">
                                    <button 
                                        onClick={() => fileInputRef.current?.click()}
                                        className="bg-white text-stone-900 p-6 rounded-2xl font-bold hover:bg-stone-200 transition-colors flex flex-col items-center gap-3 group"
                                    >
                                        <Upload size={28} className="text-stone-400 group-hover:text-stone-900 transition-colors" />
                                        <span>Upload File</span>
                                    </button>
                                    <div className="relative group overflow-hidden rounded-2xl">
                                         <div className="absolute inset-0 bg-stone-800"></div>
                                         <div className="relative bg-stone-800/80 text-stone-300 p-6 font-bold border border-white/10 h-full flex flex-col justify-center hover:bg-stone-800 transition-colors">
                                            <label className="text-[10px] uppercase tracking-wider text-stone-500 mb-3 block flex items-center gap-1">
                                                <Youtube size={12} /> Import URL
                                            </label>
                                            <div className="flex gap-2">
                                                <input 
                                                    value={importUrl}
                                                    onChange={(e) => setImportUrl(e.target.value)}
                                                    placeholder="Paste URL..."
                                                    disabled={isDownloading}
                                                    className="w-full bg-black/50 border border-white/10 rounded px-3 py-2 text-xs text-white focus:border-sage-500 outline-none transition-all"
                                                    onKeyDown={(e) => e.key === 'Enter' && handleUrlImport()}
                                                />
                                                <button 
                                                    onClick={handleUrlImport} 
                                                    disabled={isDownloading || !importUrl} 
                                                    className="bg-stone-600 px-3 rounded hover:bg-stone-500 disabled:opacity-50 transition-colors"
                                                >
                                                    {isDownloading ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
                                                </button>
                                            </div>
                                            {isDownloading && (
                                                <div className="w-full h-1 bg-stone-700 mt-3 rounded-full overflow-hidden">
                                                    <div className="h-full bg-sage-500 transition-all duration-300" style={{ width: `${downloadProgress}%` }}></div>
                                                </div>
                                            )}
                                         </div>
                                    </div>
                                </div>
                                <input type="file" ref={fileInputRef} className="hidden" accept="video/*" onChange={handleFileUpload} />
                                <p className="text-[10px] text-stone-500">Supports: MP4, WebM, MOV. YouTube requires Local Server.</p>
                             </div>
                        </div>
                    ) : (
                        outputUrl ? (
                            <div className="text-center w-full max-w-4xl animate-fade-in">
                                <video src={outputUrl} controls className="w-full max-h-[60vh] rounded-2xl shadow-2xl border border-white/10 bg-stone-900 mb-8" />
                                <div className="flex justify-center gap-4">
                                    <button onClick={() => setOutputUrl(null)} className="px-8 py-4 rounded-xl font-bold text-stone-400 hover:text-white hover:bg-white/5 transition-colors">
                                        Discard & Edit
                                    </button>
                                    <a 
                                        href={outputUrl} 
                                        download="highlight_reel.mp4"
                                        className="inline-flex items-center gap-3 bg-sage-500 text-forest-dark px-8 py-4 rounded-xl font-bold hover:bg-sage-400 shadow-lg hover:shadow-sage-500/20 transition-all transform hover:-translate-y-1"
                                    >
                                        <Download size={20} /> Download Reel
                                    </a>
                                </div>
                            </div>
                        ) : (
                            <div className="text-center w-full max-w-4xl flex flex-col items-center">
                                 {/* Source Preview Placeholder */}
                                 <div className="w-full aspect-video bg-stone-800/30 rounded-2xl flex flex-col items-center justify-center mb-8 border border-white/5 relative overflow-hidden group">
                                     <Video size={64} className="text-stone-700 mb-4 group-hover:scale-110 transition-transform duration-500" />
                                     <p className="text-stone-500 font-mono text-sm">Preview generated on render</p>
                                     <div className="absolute inset-x-0 bottom-0 h-1 bg-white/5">
                                         <div className="h-full bg-sage-500 w-1/3"></div>
                                     </div>
                                 </div>
                                 
                                 <div className="flex items-center gap-3 text-stone-300 bg-stone-800 px-8 py-4 rounded-full border border-white/5 shadow-lg">
                                     <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>
                                     <span>Source Loaded: <strong className="text-white">{activeFile.name}</strong></span>
                                 </div>
                                 <p className="mt-6 text-stone-500 text-sm">Select clips on the left and click "Generate Reel"</p>
                            </div>
                        )
                    )}
                </div>
            </div>
        </div>
    );
};

export default HighlightStudio;
