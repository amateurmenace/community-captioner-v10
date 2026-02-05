import React, { useState, useRef, useCallback } from 'react';
import { Upload, Download, Search, CheckCircle, X, Loader2, Database, Plus, Trash2, ArrowRight, MapPin, Globe, FileText, Link, ShieldAlert, Sparkles, Sliders, Code, Zap, Key } from 'lucide-react';
import { generateContextDictionary, searchMunicipalitySources } from '../services/geminiService';
import { DictionaryEntry, ContextSettings } from '../types';

interface ContextEngineProps {
  dictionary: DictionaryEntry[];
  setDictionary: React.Dispatch<React.SetStateAction<DictionaryEntry[]>>;
  onClose: () => void;
  learningEnabled: boolean;
  setLearningEnabled: (val: boolean) => void;
  activeContextName: string | null;
  setActiveContextName: (name: string) => void;
  profanityFilter: boolean;
  setProfanityFilter: (val: boolean) => void;
  partialResults?: boolean;
  setPartialResults?: (val: boolean) => void;
  speakerLabels?: boolean;
  setSpeakerLabels?: (val: boolean) => void;
  apiKey?: string;
}

const ContextEngine: React.FC<ContextEngineProps> = ({ 
    dictionary, setDictionary, onClose, 
    learningEnabled, setLearningEnabled, 
    activeContextName, setActiveContextName,
    profanityFilter, setProfanityFilter,
    partialResults, setPartialResults,
    speakerLabels, setSpeakerLabels,
    apiKey
}) => {
  const [view, setView] = useState<'main' | 'wizard_search' | 'wizard_select' | 'wizard_analyze' | 'settings' | 'raw'>('main');
  const [engineName, setEngineName] = useState(activeContextName || '');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [selectedSources, setSelectedSources] = useState<number[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [showNameError, setShowNameError] = useState(false);
  const [rawJson, setRawJson] = useState('');
  const [settingsVisited, setSettingsVisited] = useState(false);
  
  // New Settings State
  const [settings, setSettings] = useState<ContextSettings>({
      sensitivity: 80,
      acronymExpansion: true,
      dialect: 'general'
  });
  
  const importInputRef = useRef<HTMLInputElement>(null);
  
  const [manualOriginal, setManualOriginal] = useState('');
  const [manualReplacement, setManualReplacement] = useState('');
  
  // API Key Prompt State
  const [showKeyPrompt, setShowKeyPrompt] = useState(false);
  const [tempKey, setTempKey] = useState(apiKey || '');

  const handleActivate = () => {
      if (!engineName.trim()) {
          setShowNameError(true);
          return;
      }
      setActiveContextName(engineName);
      onClose();
  };

  // Wizard Logic
  const handleMunicipalitySearch = async () => {
    const keyToUse = apiKey || tempKey;
    if (!keyToUse) {
        setShowKeyPrompt(true);
        return;
    }
    
    // Save key if it was entered in temp prompt
    if (tempKey && !apiKey) {
        localStorage.setItem('cc_api_key', tempKey);
    }

    setIsProcessing(true);
    try {
        const results = await searchMunicipalitySources(searchQuery, keyToUse);
        setSearchResults(results);
        setIsProcessing(false);
        setView('wizard_select');
    } catch (e) {
        setIsProcessing(false);
        alert("Search failed. Check API Key or connection.");
    }
  };

  const handleBuildEngine = async () => {
    const keyToUse = apiKey || tempKey;
    setView('wizard_analyze');
    const selectedData = searchResults.filter((_, i) => selectedSources.includes(i));
    const combinedContext = selectedData.map(d => d.snippet).join(" ");
    
    try {
        const entries = await generateContextDictionary(combinedContext, keyToUse);
        setDictionary(prev => {
            const existing = new Set(prev.map(e => e.original.toLowerCase()));
            const novel = entries.filter(e => !existing.has(e.original.toLowerCase()));
            return [...prev, ...novel];
        });
        setView('main');
    } catch (e) {
        alert("Failed to build dictionary.");
        setView('main');
    }
  };

  // Manual & Drag Drop Logic
  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") setDragActive(true);
    else if (e.type === "dragleave") setDragActive(false);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
       const file = e.dataTransfer.files[0];
       const entries = await generateContextDictionary(`Context derived from file: ${file.name}`, apiKey || tempKey);
       setDictionary(prev => [...prev, ...entries]);
    }
  }, [setDictionary, apiKey, tempKey]);

  const addManualEntry = () => {
    if (manualOriginal && manualReplacement) {
        setDictionary(prev => [...prev, { original: manualOriginal, replacement: manualReplacement, type: 'correction' }]);
        setManualOriginal('');
        setManualReplacement('');
    }
  };

  const handleExport = () => {
      const blob = new Blob([JSON.stringify(dictionary, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${engineName || 'context-engine'}-${new Date().toISOString().split('T')[0]}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
  };

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (evt) => {
          try {
              const imported = JSON.parse(evt.target?.result as string);
              if (Array.isArray(imported)) {
                  setDictionary(prev => [...prev, ...imported]);
              }
          } catch(err) { console.error("Invalid JSON"); }
      };
      reader.readAsText(file);
  };

  const handleEnterRaw = () => {
      setRawJson(JSON.stringify(dictionary, null, 2));
      setView('raw');
  };

  const handleSaveRaw = () => {
      try {
          const parsed = JSON.parse(rawJson);
          if (Array.isArray(parsed)) {
              setDictionary(parsed);
              setView('main');
          } else {
              alert("JSON must be an array of objects.");
          }
      } catch (e) {
          alert("Invalid JSON format.");
      }
  };

  const openSettings = () => {
      setSettingsVisited(true);
      setView('settings');
  };

  return (
    <div className="absolute inset-0 z-50 bg-stone-50 flex flex-col animate-fade-in text-forest-dark font-sans">
        {/* Header */}
        <div className="h-20 border-b border-stone-200 px-8 flex items-center justify-between bg-white sticky top-0 z-20 shadow-sm">
            <div className="flex items-center gap-4">
                <div className="w-12 h-12 bg-sage-500 rounded-xl flex items-center justify-center text-white shadow-lg shadow-sage-200">
                    <Database size={24} />
                </div>
                <div>
                    <h2 className="text-xl font-bold font-display leading-tight">Context Engine</h2>
                    <div className="flex items-center gap-2 text-xs text-stone-500 font-medium">
                        <span className="bg-sage-100 text-forest-dark px-1.5 py-0.5 rounded">v5.2</span>
                        <span>Knowledge Graph Builder</span>
                    </div>
                </div>
            </div>
            
            <div className="flex-1 max-w-md mx-8 relative">
                <input 
                    value={engineName}
                    onChange={(e) => { setEngineName(e.target.value); setShowNameError(false); }}
                    placeholder="Name this Engine (e.g. City Council)"
                    className={`w-full text-center bg-stone-50 border-b-2 focus:border-sage-500 outline-none px-4 py-2 font-display font-bold text-lg placeholder:font-normal placeholder:text-stone-300 transition-colors ${showNameError ? 'border-red-500 bg-red-50 placeholder:text-red-300' : 'border-stone-200'}`}
                />
                {showNameError && (
                    <span className="absolute top-full left-0 right-0 text-center text-xs text-red-500 font-bold mt-1 animate-pulse">
                        Name required to activate
                    </span>
                )}
            </div>

            <div className="flex items-center gap-2">
                 <button onClick={handleActivate} className="flex items-center gap-2 px-6 py-2 bg-forest-dark text-white rounded-lg font-bold hover:bg-forest-light transition-all shadow-md">
                    <CheckCircle size={18} /> Activate & Close
                 </button>
                 <button onClick={onClose} className="p-2 hover:bg-stone-100 rounded-full transition-colors">
                    <X size={24} className="text-stone-400 hover:text-forest-dark" />
                 </button>
            </div>
        </div>

        {/* Main Content Area */}
        <div className="flex-1 flex overflow-hidden">
            
            {/* Left Panel: Tabs */}
            <div className="w-1/3 bg-white border-r border-stone-200 flex flex-col overflow-y-auto">
                <div className="p-2 border-b border-stone-100 flex gap-1 bg-stone-50">
                    <button onClick={() => setView('main')} className={`flex-1 py-2 text-xs font-bold rounded-lg transition-colors flex items-center justify-center gap-2 ${view === 'main' ? 'bg-white shadow-sm text-forest-dark ring-1 ring-stone-200' : 'text-stone-400 hover:bg-stone-100'}`}>
                        <Database size={14} /> Tools
                    </button>
                    <button 
                        onClick={openSettings} 
                        className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all flex items-center justify-center gap-2 ${view === 'settings' ? 'bg-white shadow-sm text-forest-dark ring-1 ring-stone-200' : 'text-stone-400 hover:bg-stone-100'} ${!settingsVisited && view !== 'settings' ? 'animate-pulse ring-2 ring-sage-300 bg-sage-50 text-sage-600' : ''}`}
                    >
                        <Sliders size={14} /> Settings
                    </button>
                    <button onClick={handleEnterRaw} className={`flex-1 py-2 text-xs font-bold rounded-lg transition-colors flex items-center justify-center gap-2 ${view === 'raw' ? 'bg-white shadow-sm text-forest-dark ring-1 ring-stone-200' : 'text-stone-400 hover:bg-stone-100'}`}>
                        <Code size={14} /> Raw
                    </button>
                </div>

                {view === 'settings' ? (
                     <div className="p-8 space-y-8 animate-fade-in">
                        {/* ... Settings Content (unchanged) ... */}
                        <div className="text-center mb-6">
                            <Sliders size={48} className="mx-auto text-sage-400 mb-4" />
                            <h3 className="text-xl font-bold mb-2">Engine Settings</h3>
                            <p className="text-sm text-stone-500">Configure core behavior.</p>
                        </div>
                        <div className="space-y-4">
                            <div className="bg-stone-50 p-4 rounded-xl border border-stone-200">
                                <h4 className="font-bold text-sm text-forest-dark mb-1">Correction Sensitivity</h4>
                                <div className="flex items-center gap-3">
                                    <span className="text-xs font-bold text-stone-400">Loose</span>
                                    <input 
                                        type="range" min="0" max="100" 
                                        value={settings.sensitivity} 
                                        onChange={(e) => setSettings({...settings, sensitivity: Number(e.target.value)})}
                                        className="flex-1 accent-forest-dark"
                                    />
                                    <span className="text-xs font-bold text-stone-400">Strict</span>
                                </div>
                            </div>
                        </div>
                     </div>
                ) : view === 'raw' ? (
                    <div className="p-4 h-full flex flex-col animate-fade-in">
                        <div className="flex justify-between items-center mb-4">
                            <h3 className="text-sm font-bold text-stone-500 uppercase">Raw JSON Editor</h3>
                            <button onClick={handleSaveRaw} className="text-xs bg-forest-dark text-white px-3 py-1 rounded font-bold hover:bg-forest-light">Save Changes</button>
                        </div>
                        <textarea 
                            value={rawJson}
                            onChange={(e) => setRawJson(e.target.value)}
                            className="flex-1 w-full bg-stone-900 text-green-400 font-mono text-xs p-4 rounded-xl outline-none resize-none"
                            spellCheck="false"
                        />
                    </div>
                ) : view === 'main' ? (
                    <div className="p-8 space-y-10 animate-fade-in">
                        {/* 1. Wizard Section */}
                        <div className="space-y-4">
                            <h3 className="text-sm font-bold text-stone-400 uppercase tracking-wider flex items-center gap-2">
                                <Globe size={16} /> Municipality Scraper
                            </h3>
                            <div className="bg-gradient-to-br from-forest-dark to-forest-light p-6 rounded-2xl text-white shadow-xl relative overflow-hidden group">
                                <div className="absolute top-0 right-0 w-32 h-32 bg-white/10 rounded-full -translate-y-1/2 translate-x-1/2 blur-2xl group-hover:bg-white/20 transition-all"></div>
                                <h4 className="font-bold text-lg mb-2 relative z-10">Auto-Ingest Town Data</h4>
                                <p className="text-sage-100 text-sm mb-6 relative z-10 opacity-90">
                                    Use AI to scrape agendas, minutes, and rosters to teach the system local names.
                                </p>
                                <button 
                                    onClick={() => setView('wizard_search')}
                                    className="w-full bg-white text-forest-dark py-3 rounded-xl font-bold hover:bg-sage-50 transition-colors flex items-center justify-center gap-2 relative z-10"
                                >
                                    <Search size={16} /> Start Wizard
                                </button>
                            </div>
                        </div>

                        {/* 2. Drag & Drop Zone */}
                        <div className="space-y-4">
                            <h3 className="text-sm font-bold text-stone-400 uppercase tracking-wider flex items-center gap-2">
                                <FileText size={16} /> Quick Add Documents
                            </h3>
                            <div 
                                onDragEnter={handleDrag} 
                                onDragLeave={handleDrag} 
                                onDragOver={handleDrag} 
                                onDrop={handleDrop}
                                className={`border-2 border-dashed rounded-2xl h-40 flex flex-col items-center justify-center text-center p-4 transition-all cursor-pointer ${dragActive ? 'border-sage-500 bg-sage-50' : 'border-stone-200 hover:border-sage-400 hover:bg-stone-50'}`}
                            >
                                <Upload size={32} className={`mb-3 ${dragActive ? 'text-sage-600' : 'text-stone-300'}`} />
                                <p className="text-sm font-bold text-stone-600">Drag & Drop Agendas/PDFs</p>
                                <p className="text-xs text-stone-400 mt-1">or click to upload</p>
                                <input type="file" className="hidden" />
                            </div>
                        </div>
                    </div>
                ) : (
                    // Wizard Views
                    <div className="p-8 h-full flex flex-col animate-fade-in">
                        <button onClick={() => setView('main')} className="mb-6 text-stone-500 hover:text-forest-dark flex items-center gap-2 text-sm font-bold">
                            <ArrowRight className="rotate-180" size={16} /> Back to Tools
                        </button>
                        
                        {view === 'wizard_search' && (
                            <div className="flex-1 flex flex-col justify-center items-center text-center">
                                <div className="w-20 h-20 bg-sage-100 rounded-full flex items-center justify-center mb-6 text-forest-dark animate-blob">
                                    <MapPin size={40} />
                                </div>
                                <h3 className="text-2xl font-display font-bold text-forest-dark mb-3">Which Municipality?</h3>
                                
                                {showKeyPrompt ? (
                                    <div className="w-full max-w-sm bg-orange-50 p-4 rounded-xl border border-orange-200 animate-slide-up">
                                        <div className="flex items-center gap-2 text-orange-700 font-bold text-sm mb-2">
                                            <Key size={16} /> API Key Required
                                        </div>
                                        <p className="text-xs text-stone-600 mb-3 text-left">The scraper requires Google Gemini to find sources.</p>
                                        <input 
                                            type="password"
                                            value={tempKey}
                                            onChange={e => setTempKey(e.target.value)}
                                            placeholder="Paste Gemini API Key..."
                                            className="w-full border border-stone-200 rounded p-2 text-sm mb-2"
                                        />
                                        <button 
                                            onClick={() => { setShowKeyPrompt(false); handleMunicipalitySearch(); }}
                                            className="w-full bg-forest-dark text-white py-2 rounded font-bold text-sm"
                                        >
                                            Save & Continue
                                        </button>
                                    </div>
                                ) : (
                                    <>
                                        <p className="text-stone-500 mb-8 max-w-xs">We will search for official government domains (.gov, .org) and public record repositories.</p>
                                        <div className="relative w-full max-w-sm">
                                            <input 
                                                value={searchQuery}
                                                onChange={(e) => setSearchQuery(e.target.value)}
                                                onKeyDown={(e) => e.key === 'Enter' && handleMunicipalitySearch()}
                                                placeholder="e.g. Cambridge, MA"
                                                className="w-full text-lg px-6 py-4 bg-white border-2 border-stone-200 rounded-xl shadow-sm focus:border-sage-500 outline-none pr-14"
                                                autoFocus
                                            />
                                            <button 
                                                onClick={handleMunicipalitySearch}
                                                className="absolute right-2 top-2 bottom-2 w-12 bg-forest-dark text-white rounded-lg hover:bg-forest-light transition-colors flex items-center justify-center"
                                            >
                                                {isProcessing ? <Loader2 className="animate-spin" size={20} /> : <ArrowRight size={20} />}
                                            </button>
                                        </div>
                                    </>
                                )}
                            </div>
                        )}

                        {view === 'wizard_select' && (
                             <div className="flex-1 flex flex-col">
                                <h3 className="text-2xl font-display font-bold mb-2">Review Sources</h3>
                                <div className="flex-1 overflow-y-auto space-y-3 pr-2 custom-scrollbar">
                                    {searchResults.map((result, i) => (
                                        <div 
                                            key={i} 
                                            onClick={() => setSelectedSources(prev => prev.includes(i) ? prev.filter(x => x !== i) : [...prev, i])}
                                            className={`p-4 rounded-xl border-2 cursor-pointer transition-all ${selectedSources.includes(i) ? 'border-sage-500 bg-sage-50' : 'border-stone-100 bg-white hover:border-sage-300'}`}
                                        >
                                            <div className="flex justify-between items-start mb-2">
                                                <h4 className="font-bold text-forest-dark text-sm">{result.title}</h4>
                                                <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 ${selectedSources.includes(i) ? 'border-sage-500 bg-sage-500 text-white' : 'border-stone-300'}`}>
                                                    {selectedSources.includes(i) && <CheckCircle size={12} />}
                                                </div>
                                            </div>
                                            <div className="text-xs text-stone-500 bg-white/50 p-2 rounded border border-stone-100 font-mono mb-2">
                                                {result.snippet}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                                <div className="pt-6 mt-auto">
                                    <button 
                                        onClick={handleBuildEngine}
                                        disabled={selectedSources.length === 0}
                                        className="w-full bg-forest-dark text-white py-3 rounded-xl font-bold hover:bg-forest-light disabled:opacity-50 shadow-lg"
                                    >
                                        Extract & Build Engine
                                    </button>
                                </div>
                            </div>
                        )}

                        {view === 'wizard_analyze' && (
                            <div className="flex-1 flex flex-col justify-center items-center text-center">
                                <Loader2 size={48} className="animate-spin text-sage-500 mx-auto mb-6" />
                                <h3 className="text-2xl font-bold text-forest-dark mb-2">AI Building Context Graph...</h3>
                                <p className="text-stone-500">Analzying documents. Identifying proper nouns. Creating dictionary.</p>
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* Right Panel: Active Rules & Management */}
            <div className="flex-1 bg-stone-50 flex flex-col h-full overflow-hidden relative">
                <div className="p-8 flex-1 overflow-y-auto custom-scrollbar">
                    <div className="flex justify-between items-end mb-6">
                        <div>
                            <h3 className="text-2xl font-display font-bold text-forest-dark">Active Rules</h3>
                            <p className="text-stone-500 text-sm">Fine-tune the dictionary below.</p>
                        </div>
                        <div className="flex items-center gap-2">
                             <input type="file" ref={importInputRef} className="hidden" accept=".json" onChange={handleImport} />
                             <button onClick={() => importInputRef.current?.click()} className="flex items-center gap-2 px-4 py-2 bg-white border border-stone-200 rounded-lg text-sm font-bold text-stone-600 hover:bg-stone-50 hover:border-forest-dark transition-colors" title="Load a JSON engine file">
                                <Upload size={16} /> Import Engine
                             </button>
                             <button onClick={handleExport} className="flex items-center gap-2 px-4 py-2 bg-forest-dark text-white rounded-lg text-sm font-bold hover:bg-forest-light shadow-md transition-colors" title="Save current engine as JSON">
                                <Download size={16} /> Export Engine
                             </button>
                        </div>
                    </div>

                    {/* Manual Entry Row */}
                    <div className="bg-white border border-stone-200 p-4 rounded-xl shadow-sm mb-6 flex gap-4 items-end">
                        <div className="flex-1">
                            <label className="text-[10px] font-bold text-stone-400 uppercase tracking-wider mb-1 block">Incorrect (Input)</label>
                            <input 
                                value={manualOriginal}
                                onChange={(e) => setManualOriginal(e.target.value)}
                                placeholder="e.g. Steven Woo"
                                className="w-full bg-stone-50 border border-stone-200 rounded-lg p-2 text-sm outline-none focus:border-sage-500"
                            />
                        </div>
                        <div className="flex items-center pb-3 text-stone-300"><ArrowRight size={20} /></div>
                        <div className="flex-1">
                             <label className="text-[10px] font-bold text-stone-400 uppercase tracking-wider mb-1 block">Correct (Output)</label>
                            <input 
                                value={manualReplacement}
                                onChange={(e) => setManualReplacement(e.target.value)}
                                placeholder="e.g. Stephen Wu"
                                className="w-full bg-stone-50 border border-stone-200 rounded-lg p-2 text-sm outline-none focus:border-sage-500"
                            />
                        </div>
                        <button 
                            onClick={addManualEntry}
                            disabled={!manualOriginal || !manualReplacement}
                            className="bg-sage-100 hover:bg-sage-200 text-forest-dark p-2.5 rounded-lg disabled:opacity-50 transition-colors"
                        >
                            <Plus size={20} />
                        </button>
                    </div>

                    {/* Dictionary List */}
                    <div className="space-y-3 pb-20">
                         {dictionary.length === 0 ? (
                            <div className="text-center py-20 opacity-40">
                                <Sparkles size={48} className="mx-auto mb-4 text-stone-400" />
                                <h4 className="text-xl font-bold text-stone-400">Context Empty</h4>
                                <p className="text-stone-400">Add rules manually or use the Ingestion Tools.</p>
                            </div>
                         ) : (
                             dictionary.map((entry, idx) => (
                                <div key={idx} className="bg-white border border-stone-200 p-4 rounded-xl flex items-center justify-between group hover:border-sage-300 hover:shadow-md transition-all">
                                    <div className="flex items-center gap-4">
                                        <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-xs ${entry.type === 'correction' ? 'bg-orange-100 text-orange-700' : 'bg-sage-100 text-sage-700'}`}>
                                            {entry.type === 'correction' ? 'MAN' : 'AI'}
                                        </div>
                                        <div>
                                            <div className="flex items-center gap-3">
                                                <span className="text-red-400 line-through text-sm font-medium">{entry.original}</span>
                                                <ArrowRight size={14} className="text-stone-300" />
                                                <span className="text-forest-dark font-bold text-lg">{entry.replacement}</span>
                                            </div>
                                        </div>
                                    </div>
                                    <button 
                                        onClick={() => setDictionary(p => p.filter((_,i) => i !== idx))}
                                        className="text-stone-300 hover:text-red-500 p-2 opacity-0 group-hover:opacity-100 transition-all"
                                    >
                                        <Trash2 size={18} />
                                    </button>
                                </div>
                             ))
                         )}
                    </div>
                </div>
            </div>
        </div>
    </div>
  );
};

export default ContextEngine;