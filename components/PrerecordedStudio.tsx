import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useDropzone } from 'react-dropzone';
import { Upload, CheckCircle, Settings, AlertCircle, ArrowLeft, Loader2, Sparkles, Languages, FileAudio, Cloud, Server, ExternalLink, Youtube, X, Play } from 'lucide-react';
import { DictionaryEntry, Caption } from '../types';
import { transcribeFile } from '../services/geminiService';
import { buildCorrectionIndex, applyCorrections } from '../shared/corrections.js';

interface PrerecordedStudioProps {
  onBack: () => void;
  onComplete: (captions: Caption[], file?: File) => void;
  dictionary: DictionaryEntry[];
  apiKey?: string;
  localServerUrl?: string;
  onOpenLocalSetup?: () => void;
}

const getRelayUrl = () => {
    const port = window.location.port;
    const p = parseInt(port || '0');
    if (p >= 5170 && p <= 5199) return `${window.location.protocol}//${window.location.hostname}:8080`;
    return `${window.location.protocol}//${window.location.hostname}${port ? `:${port}` : ''}`;
};

type Segment = { start: number; end: number; text: string };
type Job = {
    id: string; kind: 'file' | 'youtube'; filename: string; bytes: number;
    status: 'queued' | 'downloading' | 'starting_server' | 'decoding' | 'transcribing' | 'done' | 'error' | 'cancelled';
    message?: string; progress: number; durationSec?: number; utterances?: number; speed?: number | null;
    engine?: { backend?: string; model?: string; device?: string }; segments?: Segment[]; segmentCount?: number;
    elapsedMs?: number; error?: string; needsSetup?: boolean; serverState?: string; serverLog?: string[];
};
type WhisperInfo = { running: boolean; managed: boolean; configured: boolean; savedModel?: string | null; hello?: any; outdated?: boolean; port: number };

const fmtTime = (s?: number) => {
    if (s == null || !isFinite(s)) return '--:--';
    const m = Math.floor(s / 60), r = Math.floor(s % 60);
    return `${m}:${r.toString().padStart(2, '0')}`;
};
const fmtBytes = (b: number) => b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;

export const PrerecordedStudio: React.FC<PrerecordedStudioProps> = ({ onBack, onComplete, dictionary, apiKey, localServerUrl, onOpenLocalSetup }) => {
  const [step, setStep] = useState<'mode' | 'upload'>('mode');
  const [mode, setMode] = useState<'cloud' | 'local'>('local');
  const [uploadTab, setUploadTab] = useState<'file' | 'youtube'>('file');
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<'idle' | 'uploading' | 'processing' | 'complete' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [detectSpeakers, setDetectSpeakers] = useState(true);
  const [tempKey, setTempKey] = useState(apiKey || '');
  const [youtubeUrl, setYoutubeUrl] = useState('');

  // ---- local engine state ----
  const [whisper, setWhisper] = useState<WhisperInfo | null>(null);
  const [whisperManaged, setWhisperManaged] = useState<{ state: string; message: string; model?: string | null } | null>(null);
  const [upload, setUpload] = useState<{ percent: number; mbps: number } | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [correctionsApplied, setCorrectionsApplied] = useState<number | null>(null);
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const jobStartedAtRef = useRef<number>(Date.now());

  const refreshWhisper = useCallback(async (fresh = false) => {
      try {
          const d = await fetch(`${getRelayUrl()}/api/local/info${fresh ? '?refresh=1' : ''}`).then(r => r.json());
          setWhisper(d.whisper);
          setWhisperManaged(d.managed ? { state: d.managed.state, message: d.managed.message, model: d.managed.model } : null);
      } catch { setWhisper(null); }
  }, []);
  useEffect(() => { refreshWhisper(); const id = setInterval(() => refreshWhisper(), 8000); return () => clearInterval(id); }, [refreshWhisper]);
  useEffect(() => () => { esRef.current?.close(); }, []);
  useEffect(() => { transcriptEndRef.current?.scrollIntoView({ block: 'nearest' }); }, [segments.length]);

  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles.length > 0) {
      setFile(acceptedFiles[0]);
      setStatus('idle');
      setErrorMsg('');
      setJob(null); setSegments([]); setUpload(null); setCorrectionsApplied(null);
    }
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({ onDrop, accept: { 'video/*': [], 'audio/*': [] }, maxFiles: 1 });

  const saveKeyAndContinue = () => {
      if (mode === 'cloud' && tempKey) localStorage.setItem('cc_api_key', tempKey);
      setStep('upload');
  };

  // ---- local: follow a relay job over SSE ----
  const followJob = (jobId: string) => {
      esRef.current?.close();
      const es = new EventSource(`${getRelayUrl()}/api/local/jobs/${jobId}/events`);
      esRef.current = es;
      es.onmessage = (e) => {
          let d: any; try { d = JSON.parse(e.data); } catch { return; }
          if (d.phase === 'snapshot') { setJob(d.job); if (Array.isArray(d.job.segments)) setSegments(d.job.segments); }
          else if (d.phase === 'job') setJob(d.job);
          else if (d.phase === 'segment') { setSegments(prev => [...prev, d.segment]); setJob(prev => prev ? { ...prev, status: 'transcribing', progress: d.progress, durationSec: d.durationSec, speed: d.speed, segmentCount: d.segmentCount } : prev); }
          else if (d.phase === 'done') {
              setJob(d.job);
              const segs: Segment[] = d.job.segments || [];
              setSegments(segs);
              finishLocal(segs, d.job);
              es.close();
          }
      };
      es.onerror = () => { /* the relay ends the stream itself; a dropped connection shows via the job poll below */ };
  };

  const finishLocal = (segs: Segment[], j: Job) => {
      const index = buildCorrectionIndex(dictionary);
      let fixed = 0;
      const base = jobStartedAtRef.current;
      const out: Caption[] = segs.map((sg, i) => {
          const r: any = applyCorrections(sg.text, index, { sensitivity: 60 });
          const text = typeof r === 'string' ? r : r.text;
          const changed = text !== sg.text;
          if (changed) fixed++;
          return { id: `${j.id}-${i}`, text, timestamp: base + Math.round(sg.start * 1000), confidence: 0.92, isFinal: true, corrected: changed };
      });
      setCorrectionsApplied(fixed);
      setCaptions(out);
      setStatus('complete');
  };

  const startLocalFile = () => {
      if (!file) return;
      setStatus('uploading'); setErrorMsg(''); setSegments([]); setJob(null); setCorrectionsApplied(null);
      jobStartedAtRef.current = Date.now();
      const xhr = new XMLHttpRequest();
      xhrRef.current = xhr;
      const t0 = Date.now();
      xhr.upload.onprogress = (e) => {
          if (!e.lengthComputable) return;
          const secs = Math.max(0.001, (Date.now() - t0) / 1000);
          setUpload({ percent: Math.round((e.loaded / e.total) * 100), mbps: +(e.loaded / 1e6 / secs).toFixed(1) });
      };
      xhr.onload = () => {
          let d: any = null; try { d = JSON.parse(xhr.responseText); } catch {}
          if (xhr.status >= 200 && xhr.status < 300 && d?.ok) {
              setUpload({ percent: 100, mbps: 0 });
              setStatus('processing');
              setJob(d.job);
              followJob(d.jobId);
          } else {
              setStatus('error'); setErrorMsg(d?.error || `Upload failed (HTTP ${xhr.status})`);
          }
      };
      xhr.onerror = () => { setStatus('error'); setErrorMsg('Upload failed: the relay on this machine did not answer.'); };
      xhr.onabort = () => { setStatus('idle'); setUpload(null); };
      const fd = new FormData();
      fd.append('file', file);
      xhr.open('POST', `${getRelayUrl()}/api/local/transcribe-file`);
      xhr.send(fd);
  };

  const startLocalYoutube = async () => {
      if (!youtubeUrl) return;
      setStatus('processing'); setErrorMsg(''); setSegments([]); setCorrectionsApplied(null);
      jobStartedAtRef.current = Date.now();
      setFile(new File([], youtubeUrl.replace(/^https?:\/\//, '').slice(0, 60)));
      try {
          const d = await fetch(`${getRelayUrl()}/api/local/youtube`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: youtubeUrl }) }).then(r => r.json());
          if (!d.ok) throw new Error(d.error || 'Could not start the download');
          setJob(d.job);
          followJob(d.jobId);
      } catch (e) { setStatus('error'); setErrorMsg((e as Error).message); }
  };

  const cancelLocal = async () => {
      xhrRef.current?.abort();
      if (job?.id) { try { await fetch(`${getRelayUrl()}/api/local/jobs/${job.id}/cancel`, { method: 'POST' }); } catch {} }
      esRef.current?.close();
      setStatus('idle'); setJob(null); setUpload(null);
  };

  const processFile = async () => {
      if (!file) return;
      if (mode === 'local') return startLocalFile();
      try {
          setStatus('uploading');
          if (!tempKey && !apiKey) { setErrorMsg('A Gemini API key is required for cloud processing.'); setStatus('error'); return; }
          if (file.size > 500 * 1024 * 1024) { setErrorMsg('Files over 500 MB cannot be sent to Gemini from the browser. Use the local engine, which has no size limit.'); setStatus('error'); return; }
          const reader = new FileReader();
          reader.onload = async (e) => {
              if (e.target?.result) {
                  setStatus('processing');
                  await new Promise(r => setTimeout(r, 100));
                  const base64Str = (e.target.result as string).split(',')[1];
                  try {
                      const results = await transcribeFile(base64Str, file.type, tempKey || apiKey);
                      if (results.length > 0) { setCaptions(results); setStatus('complete'); }
                      else throw new Error('No captions generated');
                  } catch (err) {
                      setStatus('error'); setErrorMsg('Gemini could not transcribe this file. Check the API key and the file format.');
                  }
              }
          };
          reader.readAsDataURL(file);
      } catch (e) { setStatus('error'); setErrorMsg('File reading error.'); }
  };

  const handleFinish = () => {
      if (mode === 'local') { onComplete(captions, file || undefined); return; }
      const index = buildCorrectionIndex(dictionary);
      const finalCaptions = captions.map(c => {
          const r: any = applyCorrections(c.text, index, { sensitivity: 60 });
          const text = typeof r === 'string' ? r : r.text;
          return { ...c, text, corrected: text !== c.text };
      });
      onComplete(finalCaptions, file || undefined);
  };

  // ---- engine status line (shared by both steps) ----
  const engineLine = (() => {
      if (!whisper) return { tone: 'stone', text: 'Checking the local speech engine…' };
      if (whisperManaged && ['installing', 'starting', 'loading'].includes(whisperManaged.state)) return { tone: 'amber', text: `${whisperManaged.message}` };
      if (whisper.running) return { tone: 'green', text: `Speech server running${whisper.hello?.model ? ` · ${String(whisper.hello.model).replace(/^mlx-community\//, '')}` : ''}${whisper.hello?.device ? ` on ${whisper.hello.device}` : ''}${whisper.outdated ? ' · older version, open Local AI setup to replace it' : ''}` };
      if (whisper.configured) return { tone: 'stone', text: `Speech server not running · ${whisper.savedModel || 'your model'} will start automatically when you process a file` };
      return { tone: 'amber', text: 'Local AI is not set up on this computer yet' };
  })();
  const toneCls = (t: string) => t === 'green' ? 'bg-green-50 border-green-200 text-green-800' : t === 'amber' ? 'bg-amber-50 border-amber-200 text-amber-800' : 'bg-stone-50 border-stone-200 text-stone-600';

  if (step === 'mode') {
      return (
        <div className="h-full bg-cream p-8 font-sans overflow-y-auto">
            <div className="max-w-4xl mx-auto">
                <button onClick={onBack} className="flex items-center gap-2 text-stone-500 hover:text-forest-dark mb-8 font-bold text-sm">
                    <ArrowLeft size={18} /> Back
                </button>
                <h1 className="text-3xl font-display font-bold text-forest-dark mb-2">Prerecorded</h1>
                <p className="text-stone-600 mb-10">Choose where the recording is transcribed.</p>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div onClick={() => setMode('local')} className={`p-6 rounded-2xl border-2 cursor-pointer transition-all ${mode === 'local' ? 'border-sage-500 bg-white shadow-lg' : 'border-stone-200 bg-stone-50 hover:border-sage-300'}`}>
                        <div className="flex items-center gap-4 mb-4">
                            <div className="w-12 h-12 bg-sage-100 rounded-xl flex items-center justify-center text-forest-dark"><Server size={24} /></div>
                            <div>
                                <h3 className="font-bold text-lg">On this computer</h3>
                                <span className="text-xs font-bold text-sage-600 bg-sage-50 px-2 py-1 rounded">Nothing leaves the machine</span>
                            </div>
                        </div>
                        <p className="text-sm text-stone-600 mb-4">Whisper on this machine, through the relay. Any file size, timestamps on every line, about 20–40× faster than real time on an Apple GPU.</p>
                        <div className={`rounded-lg border px-3 py-2 text-xs font-medium ${toneCls(engineLine.tone)}`}>
                            {engineLine.text}
                            {whisper && !whisper.running && !whisper.configured && onOpenLocalSetup && (
                                <button onClick={(e) => { e.stopPropagation(); onOpenLocalSetup(); }} className="ml-2 underline font-bold">Set up Local AI</button>
                            )}
                        </div>
                    </div>

                    <div onClick={() => setMode('cloud')} className={`p-6 rounded-2xl border-2 cursor-pointer transition-all ${mode === 'cloud' ? 'border-sage-500 bg-white shadow-lg' : 'border-stone-200 bg-stone-50 hover:border-sage-300'}`}>
                        <div className="flex items-center gap-4 mb-4">
                            <div className="w-12 h-12 bg-sage-100 rounded-xl flex items-center justify-center text-forest-dark"><Cloud size={24} /></div>
                            <div>
                                <h3 className="font-bold text-lg">Gemini cloud</h3>
                                <span className="text-xs font-bold text-stone-500 bg-stone-100 px-2 py-1 rounded">Speaker labels · files under 500 MB</span>
                            </div>
                        </div>
                        <p className="text-sm text-stone-600 mb-4">Sends the file to Google's Gemini. Can label speakers. Needs an API key and an internet connection.</p>
                        {mode === 'cloud' && (
                            <div className="mt-4 pt-4 border-t border-stone-100 animate-slide-down">
                                <label className="text-xs font-bold text-stone-400 uppercase mb-2 block">API Key</label>
                                <div className="flex gap-2">
                                    <input type="password" value={tempKey} onChange={(e) => setTempKey(e.target.value)} placeholder="AIzaSy..." onClick={e => e.stopPropagation()}
                                        className="flex-1 border border-stone-200 bg-white text-stone-800 placeholder:text-stone-400 rounded px-3 py-2 text-sm outline-none focus:border-sage-500" />
                                    <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener" className="p-2 bg-stone-100 rounded hover:bg-stone-200 text-stone-600" title="Get Key"><ExternalLink size={18} /></a>
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                <div className="mt-8 flex justify-end">
                    <button onClick={saveKeyAndContinue} disabled={mode === 'cloud' && !tempKey}
                        className="bg-forest-dark text-white px-8 py-3 rounded-xl font-bold hover:bg-forest-light disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2">
                        Continue <ArrowLeft className="rotate-180" size={18} />
                    </button>
                </div>
            </div>
        </div>
      );
  }

  const busy = status === 'uploading' || status === 'processing';
  const stageLabel = (() => {
      if (status === 'uploading') return `Uploading to this machine's captioner${upload ? ` · ${upload.percent}%${upload.mbps ? ` · ${upload.mbps} MB/s` : ''}` : ''}`;
      if (!job) return 'Starting…';
      switch (job.status) {
          case 'queued': return 'Queued';
          case 'downloading': return job.message || 'Downloading…';
          case 'starting_server': return `${job.serverState === 'installing' ? 'Setting up the speech engine' : job.serverState === 'loading' ? 'Loading the model' : 'Starting the speech server'} · ${job.message || ''}`;
          case 'decoding': return `Decoding audio${job.progress ? ` · ${Math.round(job.progress * 100)}%` : ''}`;
          case 'transcribing': return `Transcribing · ${fmtTime((job.progress || 0) * (job.durationSec || 0))} of ${fmtTime(job.durationSec)}${job.speed ? ` · ${job.speed}× real time` : ''}`;
          default: return job.message || job.status;
      }
  })();
  const eta = job?.status === 'transcribing' && job.speed && job.durationSec ? Math.max(1, Math.round(((1 - (job.progress || 0)) * job.durationSec) / job.speed)) : null;
  const overallPct = status === 'uploading' ? Math.round((upload?.percent || 0) * 0.3) : job ? (job.status === 'downloading' ? Math.round((job.progress || 0) * 20) : job.status === 'starting_server' ? (job.serverState === 'installing' ? 22 : job.serverState === 'starting' ? 26 : job.serverState === 'loading' ? 30 : 32) : job.status === 'decoding' ? 34 + Math.round((job.progress || 0) * 6) : job.status === 'transcribing' ? 40 + Math.round((job.progress || 0) * 60) : job.status === 'done' ? 100 : 30) : 0;
  const serverFirstRun = job?.status === 'starting_server' && (job.serverState === 'installing' || (job.serverState === 'loading' && /download/i.test(job.message || '')));

  return (
    <div className="h-full bg-cream p-8 font-sans overflow-y-auto">
        <div className="max-w-5xl mx-auto">
            <div className="flex justify-between items-center mb-6">
                <button onClick={() => { if (!busy) setStep('mode'); }} disabled={busy} className="flex items-center gap-2 text-stone-500 hover:text-forest-dark font-bold text-sm disabled:opacity-40">
                    <ArrowLeft size={18} /> Change engine ({mode === 'cloud' ? 'Gemini cloud' : 'this computer'})
                </button>
                {mode === 'local' && (
                    <div className={`rounded-lg border px-3 py-1.5 text-xs font-medium flex items-center gap-2 ${toneCls(engineLine.tone)}`}>
                        <Server size={12} /> {engineLine.text}
                        {whisper && !whisper.running && !whisper.configured && onOpenLocalSetup && <button onClick={onOpenLocalSetup} className="underline font-bold">Set up Local AI</button>}
                    </div>
                )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                <div className="md:col-span-2 space-y-6">
                    <div className="flex bg-white rounded-lg p-1 border border-stone-200 shadow-sm w-fit">
                        <button onClick={() => { if (busy) return; setUploadTab('file'); setStatus('idle'); setErrorMsg(''); setFile(null); setJob(null); setSegments([]); }}
                            className={`px-4 py-2 rounded-md text-sm font-bold flex items-center gap-2 transition-colors ${uploadTab === 'file' ? 'bg-forest-dark text-white' : 'text-stone-500 hover:text-stone-800'}`}>
                            <Upload size={16} /> Upload file
                        </button>
                        <button onClick={() => { if (busy) return; setUploadTab('youtube'); setStatus('idle'); setErrorMsg(''); setFile(null); setJob(null); setSegments([]); }}
                            className={`px-4 py-2 rounded-md text-sm font-bold flex items-center gap-2 transition-colors ${uploadTab === 'youtube' ? 'bg-forest-dark text-white' : 'text-stone-500 hover:text-stone-800'}`}>
                            <Youtube size={16} /> YouTube link
                        </button>
                    </div>

                    {file ? (
                        <div className="bg-white border border-stone-200 rounded-2xl shadow-sm overflow-hidden">
                            <div className="p-6 flex items-center gap-4">
                                <div className={`w-12 h-12 rounded-full flex items-center justify-center shrink-0 ${status === 'complete' ? 'bg-green-100 text-green-600' : 'bg-sage-100 text-forest-dark'}`}>
                                    {status === 'complete' ? <CheckCircle size={24} /> : <FileAudio size={24} />}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <h3 className="font-bold text-lg text-stone-800 truncate">{job?.kind === 'youtube' && job.filename !== job.id ? job.filename : file.name}</h3>
                                    <p className="text-stone-500 text-xs">
                                        {file.size ? fmtBytes(file.size) : job?.bytes ? fmtBytes(job.bytes) : 'YouTube'}
                                        {job?.durationSec ? ` · ${fmtTime(job.durationSec)} long` : ''}
                                        {job?.engine?.model ? ` · ${String(job.engine.model).replace(/^mlx-community\//, '')}${job.engine.device ? ` on ${job.engine.device}` : ''}` : ''}
                                    </p>
                                </div>
                                {status === 'idle' && (
                                    <div className="flex gap-2 shrink-0">
                                        <button onClick={() => setFile(null)} className="px-3 py-2 text-stone-500 hover:text-red-500 font-bold text-sm">Change</button>
                                        <button onClick={processFile} className="bg-forest-dark text-white px-5 py-2 rounded-lg font-bold hover:bg-forest-light flex items-center gap-2"><Play size={16} /> Transcribe</button>
                                    </div>
                                )}
                                {busy && mode === 'local' && (
                                    <button onClick={cancelLocal} className="px-3 py-2 text-stone-500 hover:text-red-500 font-bold text-sm flex items-center gap-1 shrink-0"><X size={14} /> Cancel</button>
                                )}
                            </div>

                            {busy && (
                                <div className="px-6 pb-5">
                                    <div className="h-2 bg-stone-100 rounded-full overflow-hidden">
                                        <div className={`h-full rounded-full transition-all duration-500 ${mode === 'local' ? 'bg-sage-500' : 'bg-forest-dark animate-pulse'}`} style={{ width: `${mode === 'local' ? Math.max(2, overallPct) : 66}%` }} />
                                    </div>
                                    <div className="flex items-center justify-between mt-2 text-xs">
                                        <span className="text-forest-dark font-bold flex items-center gap-2"><Loader2 size={13} className="animate-spin" /> {mode === 'local' ? stageLabel : (status === 'uploading' ? 'Reading file…' : 'Gemini is transcribing…')}</span>
                                        <span className="text-stone-400 font-mono">{mode === 'local' ? `${overallPct}%${eta ? ` · about ${eta >= 60 ? `${Math.round(eta / 60)} min` : `${eta} s`} left` : ''}` : ''}</span>
                                    </div>
                                    {job?.status === 'starting_server' && (
                                        <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-[11px] text-amber-900">
                                            <p className="font-bold">{serverFirstRun ? 'First start on this computer: installing the speech engine' : 'The speech server is starting'}</p>
                                            <p className="mt-0.5">{serverFirstRun ? 'The Python packages (about 500 MB) and the Whisper model (up to 1.6 GB) are being downloaded once. On a normal connection this takes 5–10 minutes; the file will be transcribed as soon as it is ready. You can watch the full log in Local AI setup.' : 'Loading the model takes 10–40 seconds after a restart.'}</p>
                                            {job.serverLog && job.serverLog.length > 0 && (
                                                <pre className="mt-2 bg-white/70 border border-amber-100 rounded p-2 font-mono text-[10px] text-stone-600 whitespace-pre-wrap max-h-20 overflow-hidden">{job.serverLog.join('\n')}</pre>
                                            )}
                                            {onOpenLocalSetup && <button onClick={onOpenLocalSetup} className="mt-2 underline font-bold">Open Local AI setup</button>}
                                        </div>
                                    )}
                                </div>
                            )}

                            {status === 'error' && (
                                <div className="px-6 pb-6">
                                    <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3">
                                        <AlertCircle size={20} className="text-red-500 shrink-0 mt-0.5" />
                                        <div className="text-sm">
                                            <p className="font-bold text-red-700">{errorMsg || job?.error || 'Something went wrong'}</p>
                                            {job?.needsSetup && onOpenLocalSetup && <button onClick={onOpenLocalSetup} className="mt-2 bg-forest-dark text-white px-4 py-2 rounded-lg text-xs font-bold hover:bg-forest-light">Open Local AI setup</button>}
                                            {!job?.needsSetup && <button onClick={() => { setStatus('idle'); setJob(null); }} className="mt-2 text-xs underline text-red-700">Try again</button>}
                                        </div>
                                    </div>
                                </div>
                            )}

                            {(segments.length > 0 || status === 'complete') && mode === 'local' && (
                                <div className="border-t border-stone-100">
                                    <div className="px-6 py-3 flex items-start justify-between gap-4 text-xs">
                                        <span className="font-bold text-stone-500 uppercase tracking-wider shrink-0">{status === 'complete' ? 'Transcript' : 'Transcript so far'}</span>
                                        <span className="text-stone-400 font-mono text-right">{segments.length} segments{job?.elapsedMs ? ` · ${(job.elapsedMs / 1000).toFixed(0)} s${job.speed ? ` · ${job.speed}× real time` : ''}` : ''}{correctionsApplied != null ? ` · ${correctionsApplied} line${correctionsApplied === 1 ? '' : 's'} corrected by the Context Engine` : ''}</span>
                                    </div>
                                    <div className="max-h-72 overflow-y-auto px-6 pb-4 space-y-1.5 custom-scrollbar">
                                        {(status === 'complete' ? captions.map((c, i) => ({ start: segments[i]?.start ?? 0, text: c.text, corrected: c.corrected })) : segments.map(s => ({ start: s.start, text: s.text, corrected: false }))).map((row, i) => (
                                            <div key={i} className="flex gap-3 text-sm">
                                                <span className="font-mono text-[11px] text-stone-400 shrink-0 w-12 pt-0.5">{fmtTime(row.start)}</span>
                                                <span className={`text-stone-800 ${row.corrected ? 'bg-sage-50 rounded px-1' : ''}`}>{row.text}</span>
                                            </div>
                                        ))}
                                        <div ref={transcriptEndRef} />
                                    </div>
                                </div>
                            )}

                            {status === 'complete' && (
                                <div className="px-6 py-4 border-t border-stone-100 flex items-center justify-between gap-3">
                                    <p className="text-xs text-stone-500">{captions.length} caption lines{mode === 'local' && job?.durationSec ? ` from ${fmtTime(job.durationSec)} of audio` : ''}. Review, edit and export next.</p>
                                    <button onClick={handleFinish} className="bg-green-600 text-white px-6 py-2.5 rounded-xl font-bold hover:bg-green-700 shadow flex items-center gap-2 shrink-0">
                                        Review transcript <ArrowLeft className="rotate-180" size={18} />
                                    </button>
                                </div>
                            )}
                        </div>
                    ) : (
                        uploadTab === 'file' ? (
                            <div {...getRootProps()} className={`h-72 border-2 border-dashed rounded-2xl flex flex-col items-center justify-center cursor-pointer transition-all ${isDragActive ? 'border-forest-dark bg-sage-50' : 'border-stone-300 bg-white hover:border-sage-400'}`}>
                                <input {...getInputProps()} />
                                <div className="bg-sage-50 p-4 rounded-full mb-4"><Upload size={32} className="text-forest-dark" /></div>
                                <h3 className="font-bold text-lg text-stone-700">Drop a recording here</h3>
                                <p className="text-stone-400 text-sm mt-2">MP4, MOV, MKV, WEBM, MP3, WAV, M4A, AIFF · {mode === 'local' ? 'any size' : 'up to 500 MB'} · or click to choose</p>
                            </div>
                        ) : (
                            <div className="h-72 border border-stone-200 rounded-2xl flex flex-col items-center justify-center bg-white p-8">
                                <div className="bg-red-50 p-4 rounded-full mb-4"><Youtube size={32} className="text-red-600" /></div>
                                <h3 className="font-bold text-lg text-stone-700 mb-4">Transcribe a YouTube video</h3>
                                <div className="flex gap-2 w-full max-w-md">
                                    <input value={youtubeUrl} onChange={e => setYoutubeUrl(e.target.value)} placeholder="https://www.youtube.com/watch?v=..." className="flex-1 border border-stone-300 rounded-lg px-4 py-2 outline-none focus:border-sage-500" />
                                    <button onClick={startLocalYoutube} disabled={!youtubeUrl || mode !== 'local'} className="bg-forest-dark text-white px-4 py-2 rounded-lg font-bold hover:bg-forest-light disabled:opacity-50">Transcribe</button>
                                </div>
                                <p className="text-stone-400 text-xs mt-4 max-w-sm text-center">
                                    {mode === 'local' ? 'The audio is fetched on this computer with yt-dlp (installed automatically the first time) and transcribed locally.' : 'YouTube links are only supported on the local engine. Switch engines to use this.'}
                                </p>
                            </div>
                        )
                    )}
                </div>

                <div className="bg-white p-6 rounded-2xl border border-stone-100 h-fit">
                    <h3 className="text-xs font-bold text-stone-400 uppercase tracking-wider mb-6 flex items-center gap-2"><Settings size={14} /> Configuration</h3>
                    <div className="space-y-6">
                        <div>
                            <label className={`flex items-center gap-3 p-3 border border-stone-200 rounded-lg ${mode === 'local' ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer hover:bg-stone-50'}`}>
                                <input type="checkbox" checked={mode === 'local' ? false : detectSpeakers} onChange={(e) => setDetectSpeakers(e.target.checked)} disabled={status !== 'idle' || mode === 'local'} className="w-4 h-4 text-forest-dark rounded focus:ring-forest-light" />
                                <div>
                                    <span className="block text-sm font-bold text-stone-700">Speaker labels</span>
                                    <span className="block text-xs text-stone-400">{mode === 'local' ? 'Gemini cloud only; the local engine gives timestamps, not speakers' : 'Attempt to identify speakers'}</span>
                                </div>
                            </label>
                        </div>
                        <div className="bg-sage-50 p-4 rounded-lg border border-sage-100">
                            <h4 className="font-bold text-sm text-forest-dark mb-1 flex items-center gap-2"><Languages size={14} /> Context Engine</h4>
                            <p className="text-xs text-stone-600 mb-2">{dictionary.length ? 'Name and acronym corrections are applied to every line after transcription.' : 'No rules yet. Build a dictionary in the Context Engine first and names will be corrected automatically.'}</p>
                            <div className="text-xs font-mono bg-white p-2 rounded border border-sage-200 text-stone-500">{dictionary.length} rules loaded</div>
                        </div>
                        {mode === 'local' && (
                            <div className="text-[11px] text-stone-400 leading-relaxed">
                                <p className="font-bold text-stone-500 mb-1 flex items-center gap-1"><Sparkles size={11} /> How it works</p>
                                The file is uploaded to the relay on this computer, decoded there, cut into utterances at pauses, and each one is transcribed by your Whisper model. Lines appear as they are done; nothing is sent anywhere.
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    </div>
  );
};
