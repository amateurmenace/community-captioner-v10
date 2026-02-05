
import React, { useState, useMemo, useRef } from 'react';
import { Caption, SessionStats, Session, HighlightClip } from '../types';
import { Download, Clock, Type, Home, History, Calendar, Search, FileText, Activity, Zap, ChevronDown, ChevronUp, Tag, BarChart, X, PieChart, Sparkles, Key, Loader2, Quote, ArrowDown, Bot, List, AlignLeft, PlusCircle, ShoppingCart, Film, Settings, Share2 } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, Tooltip as ChartTooltip, ResponsiveContainer, CartesianGrid, AreaChart, Area, BarChart as RechartsBarChart, Bar, Label, PieChart as RechartsPieChart, Pie, Cell } from 'recharts';
import { generateSessionAnalysis } from '../services/geminiService';
import { generateLocalHighlightAnalysis } from '../services/localAIService';
import { exportToGoogleDocs } from '../services/googleDriveService';

interface AnalyticsProps {
  currentCaptions: Caption[];
  currentStats: SessionStats;
  pastSessions: Session[];
  onBack: () => void;
  apiKey?: string;
  localLlmUrl?: string;
  onAddToCart: (clip: HighlightClip) => void;
  cartCount: number;
  onOpenStudio: () => void;
  isLocalMode: boolean;
}

// Simple Word Cloud Component (unchanged)
const WordCloud = ({ text, onWordClick }: { text: string, onWordClick: (word: string) => void }) => {
    const words = useMemo(() => {
        const raw: string[] = text.toLowerCase().match(/\b(\w+)\b/g) || [];
        const counts: Record<string, number> = {};
        const stopWords = new Set(['the', 'and', 'to', 'of', 'a', 'in', 'is', 'that', 'for', 'it', 'as', 'was', 'with', 'on', 'at', 'by', 'an', 'be', 'this', 'which', 'or', 'from', 'but', 'not', 'are', 'your', 'we', 'can', 'you']);
        
        raw.forEach(w => {
            if (!stopWords.has(w) && w.length > 3) {
                counts[w] = (counts[w] || 0) + 1;
            }
        });

        return Object.entries(counts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 50)
            .map(([text, value]) => ({ text, value }));
    }, [text]);

    const maxVal = words[0]?.value || 1;

    return (
        <div className="flex flex-wrap gap-2 justify-center p-4">
            {words.map((w, i) => (
                <span 
                    key={i}
                    onClick={() => onWordClick(w.text)}
                    className="cursor-pointer hover:text-forest-dark hover:underline transition-all text-stone-600 font-display font-bold"
                    style={{ fontSize: `${Math.max(0.8, (w.value / maxVal) * 2.5)}rem`, opacity: 0.6 + (w.value/maxVal)*0.4 }}
                >
                    {w.text}
                </span>
            ))}
        </div>
    );
};

const Analytics: React.FC<AnalyticsProps> = ({ currentCaptions, currentStats, pastSessions, onBack, apiKey, onAddToCart, cartCount, onOpenStudio, localLlmUrl, isLocalMode }) => {
  const [activeSessionId, setActiveSessionId] = useState<string | 'current'>('current');
  const [searchTerm, setSearchTerm] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  
  // AI Analysis State
  const [analysis, setAnalysis] = useState<{ summary: string, highlights: any[] } | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [showKeyConfig, setShowKeyConfig] = useState(false);
  const [tempKey, setTempKey] = useState(apiKey || '');
  const [isExportingDocs, setIsExportingDocs] = useState(false);
  
  // Refs for scrolling
  const aiSectionRef = useRef<HTMLDivElement>(null);

  // Determine which data to show
  let activeData = null;
  
  if (activeSessionId === 'current') {
      activeData = { captions: currentCaptions, stats: currentStats, name: 'Current Session', date: Date.now() };
  } else {
      activeData = pastSessions.find(s => s.id === activeSessionId) 
        ? { ...pastSessions.find(s => s.id === activeSessionId)! }
        : null;
  }
  
  if ((!activeData || activeData.captions.length === 0) && pastSessions.length > 0) {
      if (activeSessionId === 'current') {
         const lastSession = pastSessions[0];
         activeData = { ...lastSession };
      }
  }

  const handleDocsExport = async () => {
      if (!activeData) return;
      setIsExportingDocs(true);
      try {
          const content = activeData.captions.map(c => 
              `[${new Date(c.timestamp).toLocaleTimeString()}] ${c.text}`
          ).join('\n\n');
          
          await exportToGoogleDocs(activeData.name, content);
          alert("Export Simulated: In a real app, this would open the Google OAuth popup and create the doc.");
      } catch (e) {
          alert("Export failed.");
      } finally {
          setIsExportingDocs(false);
      }
  };

  const handleGenerateSummary = async () => {
      // 1. Check for Local Mode preference
      if (isLocalMode) {
          setIsAnalyzing(true);
          try {
              const result = await generateLocalHighlightAnalysis(activeData!.captions, localLlmUrl);
              setAnalysis(result);
          } catch(e) {
              alert("Local AI Error. Is Ollama running?");
          } finally {
              setIsAnalyzing(false);
          }
          return;
      }

      // 2. Check for Cloud Key
      const keyToUse = tempKey || apiKey;
      if (!keyToUse) {
          setShowKeyConfig(true); // Open the inline config panel
          return;
      }
      
      if (!activeData || activeData.captions.length === 0) return;

      setIsAnalyzing(true);
      try {
          if (tempKey && tempKey !== apiKey) localStorage.setItem('cc_api_key', tempKey);
          const result = await generateSessionAnalysis(activeData.captions, keyToUse);
          setAnalysis(result);
          setShowKeyConfig(false);
      } catch (e) {
          alert("Analysis failed. Check your API Key.");
          setShowKeyConfig(true);
      } finally {
          setIsAnalyzing(false);
      }
  };

  const handleDownload = (fmt: string) => {
      if (!activeData || activeData.captions.length === 0) return;
      const format = fmt.toLowerCase();
      let content = '';
      const filename = `${activeData.name.replace(/\s+/g, '-')}-${new Date().toISOString().split('T')[0]}.${format}`;
      
      // Calculate relative start time for subtitles
      const startTime = activeData.captions[0].timestamp;

      if (format === 'json') {
          content = JSON.stringify({ 
              session: activeData.name,
              date: new Date(activeData.date).toISOString(),
              stats: activeData.stats,
              captions: activeData.captions, 
              analysis 
          }, null, 2);
      } else if (format === 'txt') {
          content = activeData.captions.map(c => `[${new Date(c.timestamp).toLocaleTimeString()}] ${c.text}`).join('\n');
      } else if (format === 'srt') {
          content = activeData.captions.map((c, i) => {
              const relStart = c.timestamp - startTime;
              const relEnd = relStart + 4000; // Default 4s duration if not streaming
              const formatTime = (ms: number) => new Date(ms).toISOString().substr(11, 12).replace('.', ',');
              return `${i + 1}\n${formatTime(relStart)} --> ${formatTime(relEnd)}\n${c.text}\n\n`;
          }).join('');
      } else if (format === 'vtt') {
          content = "WEBVTT\n\n" + activeData.captions.map((c, i) => {
              const relStart = c.timestamp - startTime;
              const relEnd = relStart + 4000;
              const formatTime = (ms: number) => new Date(ms).toISOString().substr(11, 12);
              return `${formatTime(relStart)} --> ${formatTime(relEnd)}\n${c.text}\n\n`;
          }).join('');
      }

      const blob = new Blob([content], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
  };

  if (!activeData || (activeData.captions.length === 0 && activeSessionId === 'current' && pastSessions.length === 0)) {
       return (
           <div className="h-full bg-cream flex flex-col items-center justify-center text-center p-8">
               <div className="bg-stone-100 p-6 rounded-full mb-6 text-stone-400"><Activity size={48} /></div>
               <h2 className="text-2xl font-bold font-display text-forest-dark mb-2">No Session Data</h2>
               <button onClick={onBack} className="bg-forest-dark text-white px-6 py-3 rounded-xl font-bold">Return to Dashboard</button>
           </div>
       );
  }

  const filteredCaptions = activeData.captions.filter(c => c.text.toLowerCase().includes(searchTerm.toLowerCase()));
  const fullText = activeData.captions.map(c => c.text).join(' ');

  return (
    <div className="h-full bg-cream flex font-sans text-forest-dark overflow-hidden">
       {/* Sidebar: History */}
       <div className={`bg-white border-r border-stone-200 flex flex-col shrink-0 transition-all duration-300 ${historyOpen ? 'w-80' : 'w-16'}`}>
           <div className="p-4 border-b border-stone-200 bg-stone-50 flex flex-col items-center">
               <button onClick={onBack} className="p-2 text-stone-500 hover:text-forest-dark hover:bg-white rounded-lg transition-colors mb-4"><Home size={20} /></button>
               <button onClick={() => setHistoryOpen(!historyOpen)} className="p-2 text-stone-500 hover:text-forest-dark hover:bg-white rounded-lg transition-colors">{historyOpen ? <History size={20} className="text-sage-500" /> : <History size={20} />}</button>
           </div>
           {historyOpen && (
               <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-2 animate-fade-in">
                   <h3 className="text-xs font-bold text-stone-400 uppercase tracking-wider mb-2">Sessions</h3>
                   {pastSessions.map(s => (
                       <div key={s.id} onClick={() => setActiveSessionId(s.id)} className={`p-3 rounded-lg cursor-pointer ${activeSessionId === s.id ? 'bg-sage-100 border border-sage-200' : 'hover:bg-stone-50'}`}>
                           <div className="font-bold text-sm truncate">{s.name}</div>
                           <div className="text-xs text-stone-500">{new Date(s.date).toLocaleDateString()}</div>
                       </div>
                   ))}
               </div>
           )}
       </div>

       {/* Main Content */}
       <div className="flex-1 flex flex-col overflow-hidden bg-stone-50/50 relative">
           {/* Header */}
           <div className="h-20 border-b border-stone-200 flex items-center justify-between px-8 bg-white shrink-0 shadow-sm">
               <div>
                   <h1 className="text-2xl font-bold font-display text-forest-dark">{activeData.name}</h1>
                   <div className="text-xs text-stone-500 flex items-center gap-4 mt-1">
                       <span className="flex items-center gap-1"><Clock size={12} /> {Math.floor(activeData.stats.durationSeconds / 60)}m {activeData.stats.durationSeconds % 60}s</span>
                       <span className="flex items-center gap-1"><Type size={12} /> {activeData.stats.totalWords} words</span>
                       <span className="flex items-center gap-1"><Activity size={12} /> {Math.round(activeData.stats.averageConfidence * 100)}% confidence</span>
                   </div>
               </div>
               
               <div className="flex gap-2 items-center">
                   <button 
                        onClick={onOpenStudio} 
                        className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold shadow-sm mr-2 transition-all ${cartCount > 0 ? 'bg-sage-500 text-white hover:bg-sage-600' : 'bg-stone-100 text-stone-400 hover:bg-stone-200'}`}
                   >
                       <Film size={14} /> Highlight Studio ({cartCount})
                   </button>

                   <button 
                        onClick={handleDocsExport}
                        disabled={isExportingDocs}
                        className="flex items-center gap-2 px-4 py-2 bg-blue-50 text-blue-700 border border-blue-200 rounded-lg text-xs font-bold hover:bg-blue-100 transition-colors shadow-sm"
                   >
                        {isExportingDocs ? <Loader2 size={14} className="animate-spin" /> : <Share2 size={14} />} Docs
                   </button>

                   {['TXT', 'SRT', 'JSON'].map(fmt => (
                        <button key={fmt} onClick={() => handleDownload(fmt)} className="flex items-center gap-2 px-4 py-2 bg-white border border-stone-200 text-stone-600 rounded-lg text-xs font-bold hover:bg-stone-50 transition-colors shadow-sm">
                            <Download size={14} /> {fmt}
                        </button>
                   ))}
               </div>
           </div>

           {/* Dashboard Grid */}
           <div className="flex-1 overflow-y-auto p-8 custom-scrollbar scroll-smooth">
               <div className="space-y-8 pb-32">
                   
                   {/* Top Row: AI Toolbar */}
                   <div className="bg-white p-4 rounded-2xl border border-stone-200 shadow-sm">
                       <div className="flex flex-wrap items-center justify-between gap-4">
                            <div className="flex items-center gap-3">
                                <div className="bg-sage-100 p-2 rounded-lg text-forest-dark"><Bot size={20} /></div>
                                <div>
                                    <h3 className="font-bold text-sm text-forest-dark">Intelligence Engine</h3>
                                    <p className="text-xs text-stone-500">
                                        {analysis ? "Analysis Complete" : "Generate summaries and extract highlights."}
                                    </p>
                                </div>
                            </div>
                            
                            <div className="flex gap-2">
                                <button 
                                    onClick={handleGenerateSummary}
                                    disabled={isAnalyzing}
                                    className="flex items-center gap-2 px-4 py-2 bg-stone-100 hover:bg-stone-200 text-stone-700 rounded-lg text-sm font-bold transition-colors disabled:opacity-50"
                                >
                                    {isAnalyzing ? <Loader2 size={14} className="animate-spin" /> : <AlignLeft size={14} />}
                                    Summarize
                                </button>
                                <button 
                                    onClick={handleGenerateSummary}
                                    disabled={isAnalyzing}
                                    className="flex items-center gap-2 px-4 py-2 bg-stone-100 hover:bg-stone-200 text-stone-700 rounded-lg text-sm font-bold transition-colors disabled:opacity-50"
                                >
                                    {isAnalyzing ? <Loader2 size={14} className="animate-spin" /> : <Quote size={14} />}
                                    Extract Highlights
                                </button>
                                <button 
                                    onClick={() => setShowKeyConfig(!showKeyConfig)}
                                    className="p-2 text-stone-400 hover:bg-stone-100 rounded-lg"
                                >
                                    <Settings size={16} />
                                </button>
                            </div>
                       </div>

                       {/* Inline Configuration Panel */}
                       {showKeyConfig && !analysis && (
                           <div className="mt-4 pt-4 border-t border-stone-100 animate-slide-down flex items-start gap-4">
                               <div className="flex-1">
                                   <label className="text-xs font-bold text-stone-400 uppercase block mb-2">Cloud API Key (Gemini)</label>
                                   <div className="flex gap-2">
                                       <input 
                                           type="password" 
                                           value={tempKey}
                                           onChange={e => setTempKey(e.target.value)}
                                           placeholder="Enter API Key..." 
                                           className="flex-1 border border-stone-200 rounded px-3 py-1.5 text-sm outline-none focus:border-sage-500"
                                       />
                                       <button onClick={handleGenerateSummary} className="bg-forest-dark text-white px-4 rounded text-xs font-bold hover:bg-forest-light">Save & Run</button>
                                   </div>
                                   <p className="text-[10px] text-stone-400 mt-1">Or run <a href="#" className="underline">Ollama</a> locally.</p>
                               </div>
                           </div>
                       )}
                   </div>

                   {/* AI Results Section */}
                   {analysis && (
                       <div className="grid grid-cols-1 md:grid-cols-2 gap-6 animate-fade-in" ref={aiSectionRef}>
                            <div className="bg-white p-6 rounded-2xl border border-stone-200 shadow-sm">
                                <h3 className="text-xs font-bold text-stone-400 uppercase mb-4 flex items-center gap-2"><AlignLeft size={16} /> Executive Summary</h3>
                                <p className="text-stone-700 leading-relaxed text-sm whitespace-pre-wrap">{analysis.summary}</p>
                            </div>
                            <div className="bg-white p-6 rounded-2xl border border-stone-200 shadow-sm">
                                <h3 className="text-xs font-bold text-stone-400 uppercase mb-4 flex items-center gap-2"><Quote size={16} /> Key Highlights</h3>
                                <div className="space-y-3">
                                    {analysis.highlights.map((h, i) => (
                                        <div key={i} className="bg-sage-50 p-3 rounded-lg border border-sage-100 relative group">
                                            <p className="text-forest-dark font-medium italic text-sm">"{h.quote}"</p>
                                            <button 
                                                onClick={() => onAddToCart({
                                                    id: `auto-${i}`,
                                                    start: 0,
                                                    end: 5000, 
                                                    text: h.quote,
                                                    padding: 1000
                                                })}
                                                className="absolute top-2 right-2 bg-white text-forest-dark p-1 rounded border border-sage-200 shadow-sm opacity-0 group-hover:opacity-100 transition-opacity hover:scale-105"
                                            >
                                                <PlusCircle size={14} />
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            </div>
                       </div>
                   )}

                   {/* Main Data Grid */}
                   <div className="grid grid-cols-1 md:grid-cols-3 gap-6 h-64">
                       {/* Graph 1: Pace */}
                       <div className="bg-white p-6 rounded-2xl border border-stone-200 shadow-sm flex flex-col">
                           <h3 className="text-sm font-bold text-stone-400 uppercase mb-4 flex items-center gap-2"><Zap size={16} /> Pace (WPM)</h3>
                           <div className="flex-1 w-full min-h-0">
                               <ResponsiveContainer width="100%" height="100%">
                                   <AreaChart data={activeData.stats.wpmHistory} margin={{ top: 10, right: 10, left: 0, bottom: 20 }}>
                                        <defs>
                                            <linearGradient id="colorWpm" x1="0" y1="0" x2="0" y2="1">
                                                <stop offset="5%" stopColor="#4D7563" stopOpacity={0.3}/>
                                                <stop offset="95%" stopColor="#4D7563" stopOpacity={0}/>
                                            </linearGradient>
                                        </defs>
                                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E5E7EB" />
                                        <XAxis dataKey="time" hide={true} />
                                        <YAxis hide={false} width={30} tick={{fontSize: 10, fill: '#9ca3af'}} />
                                        <Area type="monotone" dataKey="wpm" stroke="#4D7563" fillOpacity={1} fill="url(#colorWpm)" />
                                   </AreaChart>
                               </ResponsiveContainer>
                           </div>
                       </div>
                       
                       <div className="bg-white p-6 rounded-2xl border border-stone-200 shadow-sm flex flex-col justify-center items-center text-center">
                           <div className="w-16 h-16 bg-stone-100 rounded-full flex items-center justify-center mb-4 text-stone-500"><BarChart size={32} /></div>
                           <h4 className="font-bold text-stone-600">Confidence Score</h4>
                           <span className="text-3xl font-display font-bold text-forest-dark">{(activeData.stats.averageConfidence * 100).toFixed(0)}%</span>
                       </div>
                       <div className="bg-white p-6 rounded-2xl border border-stone-200 shadow-sm flex flex-col justify-center items-center text-center">
                           <div className="w-16 h-16 bg-stone-100 rounded-full flex items-center justify-center mb-4 text-stone-500"><PieChart size={32} /></div>
                           <h4 className="font-bold text-stone-600">Total Duration</h4>
                           <span className="text-3xl font-display font-bold text-forest-dark">{Math.floor(activeData.stats.durationSeconds / 60)}m</span>
                       </div>
                   </div>

                   {/* Middle Row: Content Analysis */}
                   <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 h-[600px]">
                       <div className="bg-white p-6 rounded-2xl border border-stone-200 shadow-sm flex flex-col">
                           <h3 className="text-sm font-bold text-stone-400 uppercase mb-4 flex items-center gap-2"><Tag size={16} /> Key Topics</h3>
                           <div className="flex-1 overflow-y-auto custom-scrollbar">
                                <WordCloud text={fullText} onWordClick={setSearchTerm} />
                           </div>
                       </div>

                       <div className="lg:col-span-2 bg-white rounded-2xl border border-stone-200 shadow-sm flex flex-col overflow-hidden">
                            <div className="p-4 border-b border-stone-100 flex justify-between items-center bg-stone-50">
                                <h3 className="text-sm font-bold text-stone-500 uppercase flex items-center gap-2"><FileText size={16} /> Transcript Search</h3>
                                <div className="relative">
                                    <input 
                                        value={searchTerm}
                                        onChange={(e) => setSearchTerm(e.target.value)}
                                        placeholder="Filter keywords..."
                                        className="bg-white border border-stone-200 text-stone-700 text-sm rounded-lg pl-9 pr-4 py-2 focus:border-sage-400 outline-none w-64 transition-all"
                                    />
                                    <Search size={14} className="absolute left-3 top-3 text-stone-400" />
                                </div>
                            </div>
                            
                            <div className="flex-1 overflow-y-auto p-6 space-y-4 font-serif text-lg leading-relaxed text-stone-800 custom-scrollbar">
                                {filteredCaptions.map((caption) => (
                                    <div key={caption.id} className="group hover:bg-stone-50 p-3 rounded-lg -ml-3 transition-colors flex gap-4">
                                        <div className="flex flex-col items-end gap-1 shrink-0 w-20 pt-1">
                                            <span className="text-xs font-sans font-bold text-stone-400">
                                                {new Date(caption.timestamp).toLocaleTimeString([], {minute:'2-digit', second:'2-digit'})}
                                            </span>
                                            <button 
                                                onClick={() => onAddToCart({
                                                    id: caption.id,
                                                    start: caption.timestamp,
                                                    end: caption.timestamp + (caption.text.length * 50),
                                                    text: caption.text,
                                                    padding: 1000
                                                })}
                                                className="text-xs bg-stone-100 text-stone-500 px-2 py-0.5 rounded hover:bg-sage-200 hover:text-forest-dark transition-colors flex items-center gap-1 group-hover:bg-sage-100 group-hover:text-forest-dark"
                                            >
                                                <PlusCircle size={12} /> Clip
                                            </button>
                                        </div>
                                        <div className="flex-1">
                                            <p className={searchTerm && caption.text.toLowerCase().includes(searchTerm.toLowerCase()) ? "bg-yellow-100 inline" : ""}>
                                                {caption.text}
                                            </p>
                                        </div>
                                    </div>
                                ))}
                            </div>
                       </div>
                   </div>

               </div>
           </div>
       </div>
    </div>
  );
};

export default Analytics;
