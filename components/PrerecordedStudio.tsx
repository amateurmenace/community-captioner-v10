
import React, { useState, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import { Upload, CheckCircle, Settings, AlertCircle, ArrowLeft, Loader2, Sparkles, Languages, FileAudio, Cloud, Server, ExternalLink, Youtube } from 'lucide-react';
import { DictionaryEntry, Caption } from '../types';
import { transcribeFile } from '../services/geminiService';

interface PrerecordedStudioProps {
  onBack: () => void;
  onComplete: (captions: Caption[], file?: File) => void;
  dictionary: DictionaryEntry[];
  apiKey?: string;
  localServerUrl?: string;
}

export const PrerecordedStudio: React.FC<PrerecordedStudioProps> = ({ onBack, onComplete, dictionary, apiKey, localServerUrl }) => {
  const [step, setStep] = useState<'mode' | 'upload'>('mode');
  const [mode, setMode] = useState<'cloud' | 'local'>('cloud');
  const [uploadTab, setUploadTab] = useState<'file' | 'youtube'>('file');
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<'idle' | 'uploading' | 'processing' | 'complete' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [detectSpeakers, setDetectSpeakers] = useState(true);
  const [tempKey, setTempKey] = useState(apiKey || '');
  const [youtubeUrl, setYoutubeUrl] = useState('');

  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles.length > 0) {
      setFile(acceptedFiles[0]);
      setStatus('idle');
      setErrorMsg('');
    }
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({ 
    onDrop, 
    accept: {'video/*': [], 'audio/*': []},
    maxFiles: 1 
  });

  const saveKeyAndContinue = () => {
      localStorage.setItem('cc_api_key', tempKey);
      setStep('upload');
  };

  const handleYoutubeDownload = async () => {
      if (!youtubeUrl) return;
      if (!localServerUrl) {
           setErrorMsg("YouTube download requires a Local Server configured.");
           setStatus('error');
           return;
      }
      
      try {
          setStatus('uploading'); 
          const res = await fetch(`${localServerUrl}/ytdl?url=${encodeURIComponent(youtubeUrl)}`);
          if (!res.ok) throw new Error("Server failed to download video. Ensure yt-dlp is installed on server.");
          
          const blob = await res.blob();
          const downloadedFile = new File([blob], "youtube_video.mp4", { type: 'video/mp4' });
          
          setFile(downloadedFile);
          setStatus('idle');
      } catch (e: any) {
          setStatus('error');
          setErrorMsg(e.message || "Failed to download YouTube video.");
      }
  };

  const processFile = async () => {
      if (!file) return;
      
      try {
          setStatus('uploading');
          
          if (mode === 'cloud') {
              if (!tempKey && !apiKey) {
                  setErrorMsg("API Key required for Cloud Mode.");
                  setStatus('error');
                  return;
              }

              if (file.size > 500 * 1024 * 1024) { 
                  setErrorMsg("File too large for browser cloud upload (Limit: 500MB). Use Local Mode or split file.");
                  setStatus('error');
                  return;
              }

              const reader = new FileReader();
              reader.onload = async (e) => {
                  if (e.target?.result) {
                      setStatus('processing');
                      await new Promise(r => setTimeout(r, 100));
                      
                      const base64Str = (e.target.result as string).split(',')[1];
                      try {
                          const results = await transcribeFile(base64Str, file.type, tempKey || apiKey);
                          if (results.length > 0) {
                              setCaptions(results);
                              setStatus('complete');
                          } else {
                              throw new Error("No captions generated");
                          }
                      } catch (err) {
                          setStatus('error');
                          setErrorMsg("Failed to transcribe via Cloud. Check API Key or file format.");
                      }
                  }
              };
              reader.readAsDataURL(file);
          } else {
              if (!localServerUrl) {
                  setErrorMsg("Local Server URL not configured.");
                  setStatus('error');
                  return;
              }
              
              setStatus('processing');
              
              setTimeout(() => {
                  setStatus('error');
                  setErrorMsg(`Could not connect to ${localServerUrl}. Is the Whisper server running?`);
              }, 2000);
          }

      } catch (e) {
          setStatus('error');
          setErrorMsg("File reading error.");
      }
  };

  const handleFinish = () => {
      const finalCaptions = captions.map(c => {
           let text = c.text;
           let corrected = false;
           dictionary.forEach(entry => {
               const regex = new RegExp(`\\b${entry.original}\\b`, 'gi');
               if (regex.test(text)) {
                   text = text.replace(regex, entry.replacement);
                   corrected = true;
               }
           });
           return { ...c, text, corrected };
       });
      onComplete(finalCaptions, file || undefined);
  };

  if (step === 'mode') {
      return (
        <div className="h-full bg-cream p-8 font-sans overflow-y-auto">
            <div className="max-w-4xl mx-auto">
                <button onClick={onBack} className="flex items-center gap-2 text-stone-500 hover:text-forest-dark mb-8 font-bold text-sm">
                    <ArrowLeft size={18} /> Back to Selection
                </button>
                <h1 className="text-3xl font-display font-bold text-forest-dark mb-2">Select Processing Engine</h1>
                <p className="text-stone-600 mb-10">Choose where your file is transcribed.</p>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div 
                        onClick={() => setMode('cloud')}
                        className={`p-6 rounded-2xl border-2 cursor-pointer transition-all ${mode === 'cloud' ? 'border-sage-500 bg-white shadow-lg' : 'border-stone-200 bg-stone-50 hover:border-sage-300'}`}
                    >
                        <div className="flex items-center gap-4 mb-4">
                            <div className="w-12 h-12 bg-sage-100 rounded-xl flex items-center justify-center text-forest-dark"><Cloud size={24} /></div>
                            <div>
                                <h3 className="font-bold text-lg">Cloud Processing</h3>
                                <span className="text-xs font-bold text-sage-600 bg-sage-50 px-2 py-1 rounded">Recommended</span>
                            </div>
                        </div>
                        <p className="text-sm text-stone-600 mb-4">Uses Gemini 1.5 Flash. Fastest and most accurate. Requires API Key.</p>
                        
                        {mode === 'cloud' && (
                            <div className="mt-4 pt-4 border-t border-stone-100 animate-slide-down">
                                <label className="text-xs font-bold text-stone-400 uppercase mb-2 block">API Key</label>
                                <div className="flex gap-2">
                                    <input 
                                        type="password" 
                                        value={tempKey}
                                        onChange={(e) => setTempKey(e.target.value)}
                                        placeholder="AIzaSy..."
                                        className="flex-1 border border-stone-200 bg-white text-stone-800 placeholder:text-stone-400 rounded px-3 py-2 text-sm outline-none focus:border-sage-500"
                                    />
                                    <a href="https://aistudio.google.com/app/apikey" target="_blank" className="p-2 bg-stone-100 rounded hover:bg-stone-200 text-stone-600" title="Get Key"><ExternalLink size={16} /></a>
                                </div>
                            </div>
                        )}
                    </div>

                    <div 
                        onClick={() => setMode('local')}
                        className={`p-6 rounded-2xl border-2 cursor-pointer transition-all ${mode === 'local' ? 'border-sage-500 bg-white shadow-lg' : 'border-stone-200 bg-stone-50 hover:border-sage-300'}`}
                    >
                        <div className="flex items-center gap-4 mb-4">
                            <div className="w-12 h-12 bg-stone-200 rounded-xl flex items-center justify-center text-stone-600"><Server size={24} /></div>
                            <div>
                                <h3 className="font-bold text-lg">Local Whisper</h3>
                                <span className="text-xs font-bold text-stone-500 bg-stone-100 px-2 py-1 rounded">Privacy First</span>
                            </div>
                        </div>
                        <p className="text-sm text-stone-600 mb-4">Runs on your hardware. Zero data leaves your machine. Requires Whisper server setup.</p>
                        
                        {mode === 'local' && (
                            <div className="mt-4 pt-4 border-t border-stone-100 animate-slide-down">
                                <div className="bg-stone-50 p-3 rounded text-xs text-stone-600 border border-stone-200 mb-3">
                                    <span className="font-bold block mb-1">Quick Setup:</span>
                                    1. Download <a href="#" className="underline text-blue-600">whisper-server</a><br/>
                                    2. Run <code>./server -port 9000</code><br/>
                                    3. Target: <span className="font-mono bg-white px-1">{localServerUrl || 'ws://localhost:9000'}</span>
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                <div className="mt-8 flex justify-end">
                    <button 
                        onClick={saveKeyAndContinue}
                        disabled={mode === 'cloud' && !tempKey}
                        className="bg-forest-dark text-white px-8 py-3 rounded-xl font-bold hover:bg-forest-light disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                    >
                        Continue to Upload <ArrowLeft className="rotate-180" size={18} />
                    </button>
                </div>
            </div>
        </div>
      );
  }

  return (
    <div className="h-full bg-cream p-8 font-sans overflow-y-auto">
        <div className="max-w-4xl mx-auto">
            <div className="flex justify-between items-center mb-8">
                <button onClick={() => setStep('mode')} className="flex items-center gap-2 text-stone-500 hover:text-forest-dark font-bold text-sm">
                    <ArrowLeft size={18} /> Change Engine ({mode === 'cloud' ? 'Cloud' : 'Local'})
                </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                <div className="md:col-span-2 space-y-6">
                    <div className="flex bg-white rounded-lg p-1 border border-stone-200 shadow-sm w-fit">
                        <button 
                            onClick={() => { setUploadTab('file'); setStatus('idle'); setErrorMsg(''); setFile(null); }}
                            className={`px-4 py-2 rounded-md text-sm font-bold flex items-center gap-2 transition-colors ${uploadTab === 'file' ? 'bg-forest-dark text-white' : 'text-stone-500 hover:text-stone-800'}`}
                        >
                            <Upload size={16} /> Upload File
                        </button>
                        <button 
                            onClick={() => { setUploadTab('youtube'); setStatus('idle'); setErrorMsg(''); setFile(null); }}
                            className={`px-4 py-2 rounded-md text-sm font-bold flex items-center gap-2 transition-colors ${uploadTab === 'youtube' ? 'bg-forest-dark text-white' : 'text-stone-500 hover:text-stone-800'}`}
                        >
                            <Youtube size={16} /> YouTube Link
                        </button>
                    </div>

                    {file ? (
                        <div className="bg-white border-2 border-forest-light/20 rounded-2xl p-8 flex flex-col items-center text-center shadow-lg relative overflow-hidden">
                             <div className={`w-16 h-16 rounded-full flex items-center justify-center mb-4 ${status === 'complete' ? 'bg-green-100 text-green-600' : 'bg-sage-100 text-forest-dark'}`}>
                                 {status === 'complete' ? <CheckCircle size={32} /> : <FileAudio size={32} />}
                             </div>
                             
                             <h3 className="font-bold text-xl text-stone-800 mb-1">{file.name}</h3>
                             <p className="text-stone-500 text-sm mb-6">{(file.size / (1024 * 1024)).toFixed(2)} MB</p>

                             {status === 'idle' && (
                                 <div className="flex gap-3">
                                     <button onClick={() => setFile(null)} className="px-4 py-2 text-stone-500 hover:text-red-500 font-bold text-sm">Change File</button>
                                     <button onClick={processFile} className="bg-forest-dark text-white px-6 py-2 rounded-lg font-bold hover:bg-forest-light flex items-center gap-2">
                                         <Sparkles size={16} /> Start Processing
                                     </button>
                                 </div>
                             )}

                             {(status === 'uploading' || status === 'processing') && (
                                 <div className="space-y-4 w-full max-w-xs">
                                     <div className="flex items-center justify-center gap-2 text-forest-dark font-bold animate-pulse">
                                         <Loader2 className="animate-spin" />
                                         {status === 'uploading' ? (uploadTab === 'youtube' ? 'Downloading from YouTube...' : 'Reading File...') : 'AI Transcribing...'}
                                     </div>
                                     <div className="h-2 bg-stone-100 rounded-full overflow-hidden">
                                         <div className="h-full bg-forest-dark animate-pulse w-2/3 rounded-full"></div>
                                     </div>
                                 </div>
                             )}

                             {status === 'error' && (
                                 <div className="text-red-500 flex flex-col items-center gap-2">
                                     <AlertCircle size={24} />
                                     <p className="font-bold text-sm max-w-xs">{errorMsg}</p>
                                     <button onClick={() => setStatus('idle')} className="text-xs underline">Try Again</button>
                                 </div>
                             )}

                             {status === 'complete' && (
                                 <button onClick={handleFinish} className="bg-green-600 text-white px-8 py-3 rounded-xl font-bold hover:bg-green-700 animate-slide-up shadow-xl flex items-center gap-2">
                                     Review Transcript <ArrowLeft className="rotate-180" size={18} />
                                 </button>
                             )}
                        </div>
                    ) : (
                        uploadTab === 'file' ? (
                            <div 
                                {...getRootProps()} 
                                className={`h-80 border-2 border-dashed rounded-2xl flex flex-col items-center justify-center cursor-pointer transition-all ${isDragActive ? 'border-forest-dark bg-sage-50' : 'border-stone-200 bg-white hover:border-sage-400'}`}
                            >
                                <input {...getInputProps()} />
                                <div className="bg-sage-50 p-4 rounded-full mb-4">
                                    <Upload size={32} className="text-forest-dark" />
                                </div>
                                <h3 className="font-bold text-lg text-stone-700">Drag & Drop Media Here</h3>
                                <p className="text-stone-400 text-sm mt-2">Supports MP3, WAV, MP4, MOV, WEBM</p>
                            </div>
                        ) : (
                            <div className="h-80 border-2 border-stone-200 rounded-2xl flex flex-col items-center justify-center bg-white p-8">
                                <div className="bg-red-50 p-4 rounded-full mb-4">
                                    <Youtube size={32} className="text-red-600" />
                                </div>
                                <h3 className="font-bold text-lg text-stone-700 mb-4">Import from YouTube</h3>
                                <div className="flex gap-2 w-full max-w-md">
                                    <input 
                                        value={youtubeUrl}
                                        onChange={e => setYoutubeUrl(e.target.value)}
                                        placeholder="https://www.youtube.com/watch?v=..."
                                        className="flex-1 border border-stone-300 rounded-lg px-4 py-2 outline-none focus:border-red-500"
                                    />
                                    <button 
                                        onClick={handleYoutubeDownload}
                                        disabled={!youtubeUrl || status === 'uploading'}
                                        className="bg-red-600 text-white px-4 py-2 rounded-lg font-bold hover:bg-red-700 disabled:opacity-50"
                                    >
                                        Download
                                    </button>
                                </div>
                                <p className="text-stone-400 text-xs mt-4 max-w-sm text-center">
                                    Requires a Local Server running <code>yt-dlp</code> to fetch the file. This downloads the video to your local machine for processing.
                                </p>
                            </div>
                        )
                    )}
                </div>

                <div className="bg-white p-6 rounded-2xl border border-stone-100 h-fit">
                    <h3 className="text-xs font-bold text-stone-400 uppercase tracking-wider mb-6 flex items-center gap-2">
                        <Settings size={14} /> Configuration
                    </h3>

                    <div className="space-y-6">
                        <div>
                            <label className="flex items-center gap-3 p-3 border border-stone-200 rounded-lg cursor-pointer hover:bg-stone-50">
                                <input 
                                    type="checkbox" 
                                    checked={detectSpeakers}
                                    onChange={(e) => setDetectSpeakers(e.target.checked)}
                                    disabled={status !== 'idle'}
                                    className="w-4 h-4 text-forest-dark rounded focus:ring-forest-light"
                                />
                                <div>
                                    <span className="block text-sm font-bold text-stone-700">Speaker Labels</span>
                                    <span className="block text-xs text-stone-400">Attempt to identify speakers</span>
                                </div>
                            </label>
                        </div>
                        
                        <div className="bg-sage-50 p-4 rounded-lg border border-sage-100">
                             <h4 className="font-bold text-sm text-forest-dark mb-1 flex items-center gap-2">
                                 <Languages size={14} /> Context Active
                             </h4>
                             <p className="text-xs text-stone-600 mb-2">
                                 Corrections will be applied after transcription.
                             </p>
                             <div className="text-xs font-mono bg-white p-2 rounded border border-sage-200 text-stone-500">
                                 {dictionary.length} rules loaded
                             </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
    );
};
