import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Upload, Download, Search, CheckCircle, X, Loader2, Database, Plus, Trash2, ArrowRight, MapPin, Globe, FileText, Link, ShieldAlert, Sparkles, Sliders, Code, Zap, Key, Layout, Type } from 'lucide-react';
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
  const fileUploadRef = useRef<HTMLInputElement>(null);
  
  const [manualOriginal, setManualOriginal] = useState('');
  const [manualReplacement, setManualReplacement] = useState('');
  
  // API Key Prompt State
  const [showKeyPrompt, setShowKeyPrompt] = useState(false);
  const [tempKey, setTempKey] = useState(apiKey || '');

  const [scrapeUrl, setScrapeUrl] = useState('');
  const [uploading, setUploading] = useState(false);
  const [scraping, setScraping] = useState(false);
  const [scrapeResult, setScrapeResult] = useState('');
  const [pasteText, setPasteText] = useState('');
  const [extracting, setExtracting] = useState(false);
  const [pasteResult, setPasteResult] = useState('');
  const [pastePreview, setPastePreview] = useState<{original: string, replacement: string, type: string}[] | null>(null);

  // Quick Names state
  const [quickNames, setQuickNames] = useState('');
  const [quickNamesProcessing, setQuickNamesProcessing] = useState(false);
  const [quickNamesResult, setQuickNamesResult] = useState('');
  const [quickNamesPreview, setQuickNamesPreview] = useState<{original: string, replacement: string, type: string}[] | null>(null);

  // Meeting Body state
  const [bodyName, setBodyName] = useState('');
  const [bodyMembers, setBodyMembers] = useState('');
  const [bodyAcronyms, setBodyAcronyms] = useState('');
  const [bodyProcessing, setBodyProcessing] = useState(false);
  const [bodyResult, setBodyResult] = useState('');
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [learnerEnabled, setLearnerEnabled] = useState(false);
  const [dictSearch, setDictSearch] = useState('');
  const [dictTypeFilter, setDictTypeFilter] = useState<string | null>(null);
  const [learnerStatus, setLearnerStatus] = useState<{bufferLength: number, lastExtraction: number | null, extractionCount: number} | null>(null);

  const getRelayUrl = () => {
      const port = window.location.port || '80';
      const relayPort = (parseInt(port) >= 5170 && parseInt(port) <= 5199) ? '8080' : port;
      return `${window.location.protocol}//${window.location.hostname}:${relayPort}`;
  };

  const getApiKey = () => localStorage.getItem('cc_api_key') || apiKey || '';

  const handleScrapeUrl = async () => {
      setScraping(true);
      setScrapeResult('');
      try {
          const res = await fetch(`${getRelayUrl()}/api/context/scrape`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Api-Key': getApiKey() },
              body: JSON.stringify({ url: scrapeUrl, apiKey: getApiKey() }),
          });
          const data = await res.json();
          if (data.ok && data.entries?.length > 0) {
              const newEntries = data.entries.map((e: any) => ({
                  original: e.original,
                  replacement: e.replacement,
                  type: e.type || 'proper_noun',
              }));
              setDictionary([...dictionary, ...newEntries]);
              setScrapeResult(`Extracted ${data.entries.length} entries from ${data.textLength} chars`);
          } else {
              setScrapeResult(data.warning || data.error || 'No entries found');
          }
      } catch (e) {
          setScrapeResult('Scrape failed: ' + (e as Error).message);
      }
      setScraping(false);
  };

  const handleExtractFromPaste = async () => {
      setExtracting(true);
      setPasteResult('');
      setPastePreview(null);
      try {
          const res = await fetch(`${getRelayUrl()}/api/context/extract`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Api-Key': getApiKey() },
              body: JSON.stringify({ text: pasteText, apiKey: getApiKey() }),
          });
          const data = await res.json();
          if (data.ok && data.entries?.length > 0) {
              const newEntries = data.entries.map((e: any) => ({
                  original: e.original,
                  replacement: e.replacement,
                  type: e.type || 'proper_noun',
              }));
              setPastePreview(newEntries);
              setPasteResult(`Found ${newEntries.length} entries — review below`);
          } else {
              setPasteResult('No entries found in text');
          }
      } catch (e) {
          setPasteResult('Extraction failed: ' + (e as Error).message);
      }
      setExtracting(false);
  };

  const handleAcceptPastePreview = () => {
      if (pastePreview) {
          setDictionary(prev => [...prev, ...pastePreview]);
          setPastePreview(null);
          setPasteResult(`Added ${pastePreview.length} entries to dictionary`);
          setPasteText('');
      }
  };

  const handleQuickNames = async () => {
      setQuickNamesProcessing(true);
      setQuickNamesResult('');
      setQuickNamesPreview(null);
      const names = quickNames.split(/[\n,]+/).map(n => n.trim()).filter(n => n.length > 0);
      if (names.length === 0) { setQuickNamesProcessing(false); return; }
      try {
          const res = await fetch(`${getRelayUrl()}/api/context/names`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Api-Key': getApiKey() },
              body: JSON.stringify({ names, apiKey: getApiKey() }),
          });
          const data = await res.json();
          if (data.ok && data.entries?.length > 0) {
              setQuickNamesPreview(data.entries);
              setQuickNamesResult(`Generated ${data.entries.length} correction rules — review below`);
          } else {
              setQuickNamesResult('Could not generate corrections for these names');
          }
      } catch (e) {
          setQuickNamesResult('Failed: ' + (e as Error).message);
      }
      setQuickNamesProcessing(false);
  };

  const handleAcceptQuickNames = () => {
      if (quickNamesPreview) {
          setDictionary(prev => [...prev, ...quickNamesPreview]);
          setQuickNamesPreview(null);
          setQuickNamesResult(`Added ${quickNamesPreview.length} entries to dictionary`);
          setQuickNames('');
      }
  };

  const handleMeetingBody = async () => {
      setBodyProcessing(true);
      setBodyResult('');
      const allNames: string[] = [];
      if (bodyName.trim()) allNames.push(bodyName.trim());
      bodyMembers.split(/[\n,]+/).map(n => n.trim()).filter(n => n).forEach(n => allNames.push(n));
      // Parse acronyms: "CIP = Capital Improvement Plan" → two entries
      const acronymEntries: {original: string, replacement: string, type: string}[] = [];
      bodyAcronyms.split(/[\n]+/).forEach(line => {
          const match = line.match(/^\s*([A-Z]{2,})\s*[=\-–:]\s*(.+)/);
          if (match) {
              acronymEntries.push({ original: match[1].toLowerCase(), replacement: match[1], type: 'acronym' });
              acronymEntries.push({ original: match[2].trim().toLowerCase(), replacement: match[2].trim(), type: 'acronym' });
              allNames.push(match[2].trim()); // also generate mishearings for the full form
          } else if (line.trim()) {
              allNames.push(line.trim());
          }
      });
      if (allNames.length === 0 && acronymEntries.length === 0) { setBodyProcessing(false); return; }
      try {
          let entries = [...acronymEntries];
          if (allNames.length > 0) {
              const res = await fetch(`${getRelayUrl()}/api/context/names`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'X-Api-Key': getApiKey() },
                  body: JSON.stringify({ names: allNames, apiKey: getApiKey() }),
              });
              const data = await res.json();
              if (data.ok && data.entries?.length > 0) entries.push(...data.entries);
          }
          if (entries.length > 0) {
              setDictionary(prev => [...prev, ...entries]);
              setBodyResult(`Added ${entries.length} entries (${allNames.length} names + ${acronymEntries.length / 2} acronyms)`);
              setBodyName(''); setBodyMembers(''); setBodyAcronyms('');
          } else {
              setBodyResult('No entries generated');
          }
      } catch (e) {
          setBodyResult('Failed: ' + (e as Error).message);
      }
      setBodyProcessing(false);
  };

  useEffect(() => {
      fetch(`${getRelayUrl()}/api/context/status`).then(r => r.json()).then(data => {
          setLearnerEnabled(data.enabled);
      }).catch(() => {});

      // Sync API key from localStorage to relay server (needed for scraping/extraction)
      const savedKey = localStorage.getItem('cc_api_key');
      if (savedKey && savedKey !== 'PLACEHOLDER_API_KEY') {
          fetch(`${getRelayUrl()}/api/polisher/apikey`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ key: savedKey }),
          }).catch(() => {});
      }

      // Poll suggestions + learner status every 5 seconds
      const interval = setInterval(() => {
          fetch(`${getRelayUrl()}/api/context/suggestions`).then(r => r.json()).then(setSuggestions).catch(() => {});
          fetch(`${getRelayUrl()}/api/context/status`).then(r => r.json()).then(data => {
              if (data.bufferLength !== undefined) setLearnerStatus(data);
          }).catch(() => {});
      }, 5000);
      return () => clearInterval(interval);
  }, []);

  const handleActivate = () => {
      if (!engineName.trim()) {
          setShowNameError(true);
          return;
      }
      setActiveContextName(engineName);
      onClose();
  };

  // Wizard Logic
  // Wizard scraping state
  const [wizardProgress, setWizardProgress] = useState<{url: string, status: 'pending' | 'scraping' | 'done' | 'failed', entries: number, error?: string}[]>([]);
  const [wizardExtracted, setWizardExtracted] = useState<DictionaryEntry[]>([]);

  const [wizardPhase, setWizardPhase] = useState<string>('');
  const [wizardInline, setWizardInline] = useState(false); // true = wizard runs inline on main view

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
    const allResults: any[] = [];
    const seenUrls = new Set<string>();

    // Phase 1: Use Gemini + Google Search grounding to find real URLs
    setWizardPhase('Searching the web for official sites...');
    try {
        const geminiResults = await searchMunicipalitySources(searchQuery, keyToUse);
        for (const r of geminiResults) {
            if (r.url && !seenUrls.has(r.url)) {
                seenUrls.add(r.url);
                allResults.push(r);
            }
        }
    } catch (e) {
        console.warn('[Wizard] Gemini search failed:', e);
    }

    // Phase 2: If we found any .gov or .org sites, crawl them for internal links
    const officialSites = allResults.filter(r =>
        /\.(gov|org)/.test(r.url) && !r.url.includes('wikipedia')
    );

    if (officialSites.length > 0) {
        setWizardPhase(`Crawling ${officialSites[0].url} for sub-pages...`);
        try {
            const crawlRes = await fetch(`${getRelayUrl()}/api/context/discover-links`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: officialSites[0].url }),
            });
            const crawlData = await crawlRes.json();
            if (crawlData.ok && crawlData.links?.length > 0) {
                for (const link of crawlData.links) {
                    if (!seenUrls.has(link.url)) {
                        seenUrls.add(link.url);
                        allResults.push(link);
                    }
                }
            }
        } catch (e) {
            console.warn('[Wizard] Link discovery failed:', e);
        }
    }

    setWizardPhase('');
    setIsProcessing(false);

    if (allResults.length === 0) {
        alert(`No sources found for "${searchQuery}". Try:\n• Include the state (e.g., "Brookline, MA")\n• Use the URL Scraper tool with a direct URL instead`);
        return;
    }

    setSearchResults(allResults);
    setSelectedSources(allResults.map((_: any, i: number) => i));
    if (wizardInline) {
        // Stay on main view — results shown inline
    } else {
        setView('wizard_select');
    }
  };

  const handleBuildEngine = async () => {
    const selectedData = searchResults.filter((_: any, i: number) => selectedSources.includes(i));

    // Initialize progress tracker
    const progress = selectedData.map((d: any) => ({
        url: d.url,
        status: 'pending' as const,
        entries: 0,
    }));
    setWizardProgress(progress);
    setWizardExtracted([]);
    if (!wizardInline) setView('wizard_analyze');

    // Scrape each URL sequentially via the relay server
    const allEntries: DictionaryEntry[] = [];
    const existingKeys = new Set(dictionary.map(e => `${e.original.toLowerCase()}→${e.replacement.toLowerCase()}`));

    for (let i = 0; i < selectedData.length; i++) {
        // Update progress: mark current as scraping
        setWizardProgress(prev => prev.map((p, j) => j === i ? { ...p, status: 'scraping' } : p));

        try {
            const res = await fetch(`${getRelayUrl()}/api/context/scrape`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Api-Key': getApiKey() },
                body: JSON.stringify({ url: selectedData[i].url, apiKey: getApiKey() }),
            });
            const data = await res.json();

            if (data.ok && data.entries?.length > 0) {
                // Deduplicate against existing dictionary and already-extracted entries
                const novel = data.entries.filter((e: any) => {
                    if (!e.original || !e.replacement) return false;
                    const key = `${e.original.toLowerCase()}→${e.replacement.toLowerCase()}`;
                    if (existingKeys.has(key)) return false;
                    existingKeys.add(key);
                    return true;
                }).map((e: any) => ({
                    original: e.original,
                    replacement: e.replacement,
                    type: e.type || 'proper_noun',
                }));

                allEntries.push(...novel);
                setWizardExtracted(prev => [...prev, ...novel]);
                setWizardProgress(prev => prev.map((p, j) => j === i ? { ...p, status: 'done', entries: novel.length } : p));
            } else {
                setWizardProgress(prev => prev.map((p, j) => j === i ? { ...p, status: 'done', entries: 0, error: data.warning || 'No entries found' } : p));
            }
        } catch (e) {
            setWizardProgress(prev => prev.map((p, j) => j === i ? { ...p, status: 'failed', error: (e as Error).message } : p));
        }
    }
  };

  const handleWizardAccept = () => {
      setDictionary(prev => [...prev, ...wizardExtracted]);
      setWizardExtracted([]);
      setWizardProgress([]);
      setSearchResults([]);
      setWizardInline(false);
      setView('main');
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
       setUploading(true);
       try {
           const formData = new FormData();
           formData.append('file', file);
           const res = await fetch(`${getRelayUrl()}/api/context/upload-pdf`, {
               method: 'POST',
               headers: { 'X-Api-Key': getApiKey() },
               body: formData,
           });
           const data = await res.json();
           if (data.ok && data.entries?.length > 0) {
               const newEntries = data.entries.map((entry: any) => ({
                   original: entry.original,
                   replacement: entry.replacement,
                   type: entry.type || 'proper_noun',
               }));
               setDictionary(prev => [...prev, ...newEntries]);
               alert(`Extracted ${data.entries.length} entries from ${file.name}`);
           } else {
               alert(data.warning || data.error || `No entries found in ${file.name}`);
           }
       } catch (err) {
           const entries = await generateContextDictionary(`Context derived from file: ${file.name}`, apiKey || tempKey);
           setDictionary(prev => [...prev, ...entries]);
       }
       setUploading(false);
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
                     <div className="p-6 space-y-5 animate-fade-in overflow-y-auto custom-scrollbar">
                        {/* Header */}
                        <div className="text-center mb-2">
                            <Sliders size={36} className="mx-auto text-sage-400 mb-3" />
                            <h3 className="text-lg font-bold mb-1">Engine Settings</h3>
                            <p className="text-xs text-stone-500">Configure how the Context Engine corrects captions.</p>
                        </div>

                        {/* Gemini API Key */}
                        <div className="bg-gradient-to-r from-amber-50 to-orange-50 p-4 rounded-xl border border-amber-200">
                            <div className="flex items-center gap-2 mb-2">
                                <Key size={14} className="text-amber-600" />
                                <h4 className="font-bold text-sm text-amber-800">Gemini API Key</h4>
                                {getApiKey() && getApiKey() !== 'PLACEHOLDER_API_KEY' && getApiKey().length > 10 ? (
                                    <span className="ml-auto text-[9px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full font-bold">Connected</span>
                                ) : (
                                    <span className="ml-auto text-[9px] bg-red-100 text-red-600 px-1.5 py-0.5 rounded-full font-bold">Not Set</span>
                                )}
                            </div>
                            <p className="text-[10px] text-stone-500 mb-2">Required for Auto-Learn, AI extraction from PDFs/URLs, and Summarize caption mode.</p>
                            <div className="flex gap-2">
                                <input
                                    type="password"
                                    value={tempKey}
                                    onChange={e => setTempKey(e.target.value)}
                                    placeholder="AIzaSy..."
                                    className="flex-1 px-2 py-1.5 rounded-lg border border-stone-200 text-xs focus:outline-none focus:border-amber-400 bg-white"
                                />
                                <button onClick={() => {
                                    if (tempKey && tempKey.length > 10) {
                                        localStorage.setItem('cc_api_key', tempKey);
                                        fetch(`${getRelayUrl()}/api/polisher/apikey`, {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ key: tempKey }),
                                        });
                                    }
                                }} className="px-3 py-1.5 bg-amber-600 text-white text-xs font-bold rounded-lg hover:bg-amber-700">Save</button>
                            </div>
                            <p className="text-[9px] text-stone-400 mt-1.5">Get a free key at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener" className="underline text-amber-600">aistudio.google.com/apikey</a></p>
                        </div>

                        {/* Auto-Learn Section */}
                        <div className="bg-white rounded-xl border border-stone-200 overflow-hidden">
                            <div className="flex items-center justify-between p-3 border-b border-stone-100">
                                <div className="flex items-center gap-2">
                                    <Zap size={14} className={learnerEnabled ? 'text-green-500' : 'text-stone-400'} />
                                    <div>
                                        <p className="text-xs font-bold text-stone-700">Auto-Learn from Live Speech</p>
                                        <p className="text-[9px] text-stone-400">AI listens to captions and extracts names, places, acronyms</p>
                                    </div>
                                </div>
                                <button onClick={() => {
                                    const newVal = !learnerEnabled;
                                    setLearnerEnabled(newVal);
                                    fetch(`${getRelayUrl()}/api/context/enable`, {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({ enabled: newVal }),
                                    });
                                }}
                                    className={`w-10 h-5 rounded-full transition-colors relative ${learnerEnabled ? 'bg-green-500' : 'bg-stone-300'}`}>
                                    <div className={`w-4 h-4 bg-white rounded-full absolute top-0.5 transition-all shadow ${learnerEnabled ? 'left-5' : 'left-0.5'}`} />
                                </button>
                            </div>
                            {learnerEnabled && (
                                <div className="p-3 bg-green-50 text-[10px] text-green-700 space-y-2">
                                    {learnerStatus && learnerStatus.enabled ? (
                                        <>
                                            {/* Live buffer progress */}
                                            <div>
                                                <div className="flex justify-between items-center mb-1">
                                                    <span className="font-bold">Speech Buffer</span>
                                                    <span className="font-mono">{learnerStatus.bufferLength} / {learnerStatus.minBufferLength || 100} chars</span>
                                                </div>
                                                <div className="w-full bg-green-200 rounded-full h-1.5">
                                                    <div
                                                        className="bg-green-600 h-1.5 rounded-full transition-all duration-1000"
                                                        style={{ width: `${Math.min(100, (learnerStatus.bufferLength / (learnerStatus.minBufferLength || 100)) * 100)}%` }}
                                                    />
                                                </div>
                                                <p className="text-[9px] text-green-600 mt-0.5">
                                                    {learnerStatus.bufferLength < (learnerStatus.minBufferLength || 100)
                                                        ? 'Accumulating speech... extraction triggers at minimum buffer size'
                                                        : learnerStatus.isExtracting
                                                            ? 'Extracting proper nouns via Gemini...'
                                                            : 'Buffer ready — extraction on next 30s cycle'}
                                                </p>
                                            </div>
                                            {/* Stats */}
                                            <div className="flex gap-3 pt-1 border-t border-green-200">
                                                <div className="text-center flex-1">
                                                    <p className="font-bold text-green-800 text-sm">{learnerStatus.extractionCount || 0}</p>
                                                    <p className="text-[8px] text-green-600">Extractions</p>
                                                </div>
                                                <div className="text-center flex-1">
                                                    <p className="font-bold text-green-800 text-sm">{learnerStatus.pendingSuggestions || 0}</p>
                                                    <p className="text-[8px] text-green-600">Pending</p>
                                                </div>
                                                <div className="text-center flex-1">
                                                    <p className="font-bold text-green-800 text-sm">{learnerStatus.dictionarySize || 0}</p>
                                                    <p className="text-[8px] text-green-600">In Dictionary</p>
                                                </div>
                                            </div>
                                            {learnerStatus.lastExtractionTime && (
                                                <p className="text-[9px] text-green-600">Last extraction: {new Date(learnerStatus.lastExtractionTime).toLocaleTimeString()}</p>
                                            )}
                                        </>
                                    ) : (
                                        <>
                                            <p>Learned words appear as toasts in the bottom-right corner.</p>
                                            <p>They auto-approve after 10 seconds. Click <strong>Reject</strong> to block a word.</p>
                                            <p>Requires Gemini API key to be set above.</p>
                                        </>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* Profanity Filter */}
                        <div className="flex items-center justify-between p-3 bg-white rounded-xl border border-stone-200">
                            <div className="flex items-center gap-2">
                                <ShieldAlert size={14} className={profanityFilter ? 'text-red-500' : 'text-stone-400'} />
                                <div>
                                    <p className="text-xs font-bold text-stone-700">Profanity Filter</p>
                                    <p className="text-[9px] text-stone-400">Replace profanity with asterisks in live captions</p>
                                </div>
                            </div>
                            <button onClick={() => setProfanityFilter(!profanityFilter)}
                                className={`w-10 h-5 rounded-full transition-colors relative ${profanityFilter ? 'bg-red-500' : 'bg-stone-300'}`}>
                                <div className={`w-4 h-4 bg-white rounded-full absolute top-0.5 transition-all shadow ${profanityFilter ? 'left-5' : 'left-0.5'}`} />
                            </button>
                        </div>

                        {/* Correction Sensitivity */}
                        <div className="bg-white p-4 rounded-xl border border-stone-200">
                            <h4 className="font-bold text-xs text-stone-700 mb-1">Correction Sensitivity</h4>
                            <p className="text-[9px] text-stone-400 mb-2">How aggressively the engine applies dictionary substitutions.</p>
                            <div className="flex items-center gap-3">
                                <span className="text-[10px] font-bold text-stone-400 w-8">Loose</span>
                                <input
                                    type="range" min="0" max="100"
                                    value={settings.sensitivity}
                                    onChange={(e) => setSettings({...settings, sensitivity: Number(e.target.value)})}
                                    className="flex-1 accent-forest-dark"
                                />
                                <span className="text-[10px] font-bold text-stone-400 w-8">Strict</span>
                                <span className="text-[10px] font-mono bg-stone-100 px-1.5 py-0.5 rounded">{settings.sensitivity}%</span>
                            </div>
                        </div>

                        {/* Acronym Expansion */}
                        <div className="flex items-center justify-between p-3 bg-white rounded-xl border border-stone-200">
                            <div>
                                <p className="text-xs font-bold text-stone-700">Acronym Expansion</p>
                                <p className="text-[9px] text-stone-400">Expand acronyms like "ADA" to full form in captions</p>
                            </div>
                            <button onClick={() => setSettings({...settings, acronymExpansion: !settings.acronymExpansion})}
                                className={`w-10 h-5 rounded-full transition-colors relative ${settings.acronymExpansion ? 'bg-forest-dark' : 'bg-stone-300'}`}>
                                <div className={`w-4 h-4 bg-white rounded-full absolute top-0.5 transition-all shadow ${settings.acronymExpansion ? 'left-5' : 'left-0.5'}`} />
                            </button>
                        </div>

                        {/* Dialect / Domain */}
                        <div className="bg-white p-4 rounded-xl border border-stone-200">
                            <h4 className="font-bold text-xs text-stone-700 mb-1">Domain Context</h4>
                            <p className="text-[9px] text-stone-400 mb-2">Helps the AI prioritize corrections for your broadcast type.</p>
                            <select
                                value={settings.dialect}
                                onChange={e => setSettings({...settings, dialect: e.target.value})}
                                className="w-full px-3 py-2 rounded-lg border border-stone-200 text-xs bg-white focus:outline-none focus:border-forest-dark"
                            >
                                <option value="general">General</option>
                                <option value="municipal">Municipal Government</option>
                                <option value="education">Education / School Board</option>
                                <option value="legal">Legal / Court</option>
                                <option value="medical">Medical / Health</option>
                                <option value="religious">Religious / Faith</option>
                                <option value="sports">Sports</option>
                            </select>
                        </div>

                        {/* How-To Guide */}
                        <div className="bg-stone-50 rounded-xl border border-stone-200 p-4 space-y-3">
                            <h4 className="font-bold text-sm text-forest-dark flex items-center gap-2">
                                <Sparkles size={14} className="text-sage-500" /> How to Use the Context Engine
                            </h4>
                            <div className="space-y-2 text-[10px] text-stone-600 leading-relaxed">
                                <div className="flex gap-2">
                                    <span className="bg-forest-dark text-white w-4 h-4 rounded-full flex items-center justify-center text-[8px] font-bold shrink-0 mt-0.5">1</span>
                                    <p><strong>Before the broadcast:</strong> Upload the meeting agenda PDF or paste its text. The AI extracts all proper nouns, names, places, and acronyms into the dictionary.</p>
                                </div>
                                <div className="flex gap-2">
                                    <span className="bg-forest-dark text-white w-4 h-4 rounded-full flex items-center justify-center text-[8px] font-bold shrink-0 mt-0.5">2</span>
                                    <p><strong>Scrape the town website:</strong> Use the URL scraper to pull names from official pages (elected officials, committee rosters, etc.)</p>
                                </div>
                                <div className="flex gap-2">
                                    <span className="bg-forest-dark text-white w-4 h-4 rounded-full flex items-center justify-center text-[8px] font-bold shrink-0 mt-0.5">3</span>
                                    <p><strong>Review the Active Rules:</strong> Check the dictionary on the right. Remove any entries that look wrong. Add manual corrections for words you know the STT engine gets wrong.</p>
                                </div>
                                <div className="flex gap-2">
                                    <span className="bg-forest-dark text-white w-4 h-4 rounded-full flex items-center justify-center text-[8px] font-bold shrink-0 mt-0.5">4</span>
                                    <p><strong>Turn on Auto-Learn:</strong> During the broadcast, the AI listens to live captions and extracts new proper nouns it hasn't seen before. These appear as toast notifications that auto-approve after 10 seconds.</p>
                                </div>
                                <div className="flex gap-2">
                                    <span className="bg-forest-dark text-white w-4 h-4 rounded-full flex items-center justify-center text-[8px] font-bold shrink-0 mt-0.5">5</span>
                                    <p><strong>Name & Export:</strong> Give your engine a name (e.g. "Brookline Select Board") and click Activate. Export to JSON to reuse next time.</p>
                                </div>
                            </div>
                        </div>

                        {/* Tips */}
                        <div className="bg-sage-50 rounded-xl border border-sage-200 p-3 space-y-1.5">
                            <h4 className="font-bold text-xs text-sage-700">Tips for Best Results</h4>
                            <ul className="text-[10px] text-stone-600 space-y-1 list-disc list-inside">
                                <li>Upload the agenda <strong>before</strong> the meeting starts for immediate corrections</li>
                                <li>The "Municipal Scraper" wizard can auto-find town websites for your area</li>
                                <li>Manual entries work best for recurring mistakes (e.g. "brookline" always heard as "Brooklyn")</li>
                                <li>Export your engine after each meeting to build a reusable dictionary over time</li>
                                <li>The profanity filter works independently of the dictionary</li>
                            </ul>
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
                    <div className="p-6 space-y-6 animate-fade-in overflow-y-auto custom-scrollbar">

                        {/* === MUNICIPALITY WIZARD — inline at top === */}
                        <div className="bg-gradient-to-br from-forest-dark to-forest-light rounded-2xl shadow-xl relative overflow-hidden">
                            <div className="absolute top-0 right-0 w-32 h-32 bg-white/10 rounded-full -translate-y-1/2 translate-x-1/2 blur-2xl"></div>
                            <div className="p-5 relative z-10">
                                <div className="flex items-center gap-3 mb-3">
                                    <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center text-white">
                                        <Globe size={22} />
                                    </div>
                                    <div>
                                        <h4 className="font-bold text-base text-white">Municipality Wizard</h4>
                                        <p className="text-sage-100 text-[10px] opacity-80">AI finds and scrapes your town's official web pages</p>
                                    </div>
                                </div>

                                {/* Inline search */}
                                <div className="flex gap-2">
                                    <input
                                        value={searchQuery}
                                        onChange={e => setSearchQuery(e.target.value)}
                                        onKeyDown={e => e.key === 'Enter' && !isProcessing && searchQuery.trim() && (() => { setWizardInline(true); handleMunicipalitySearch(); })()}
                                        placeholder="e.g. Brookline, MA"
                                        className="flex-1 px-4 py-2.5 rounded-xl text-sm bg-white/95 text-forest-dark placeholder:text-stone-400 outline-none focus:ring-2 focus:ring-white/50"
                                        disabled={isProcessing}
                                    />
                                    <button
                                        onClick={() => { setWizardInline(true); handleMunicipalitySearch(); }}
                                        disabled={isProcessing || !searchQuery.trim()}
                                        className="px-4 py-2.5 bg-white text-forest-dark rounded-xl font-bold text-sm hover:bg-sage-50 transition-colors disabled:opacity-50 flex items-center gap-1.5"
                                    >
                                        {isProcessing ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
                                        {isProcessing ? '' : 'Search'}
                                    </button>
                                </div>
                                {isProcessing && wizardPhase && (
                                    <p className="text-[10px] text-sage-100 mt-2 animate-pulse">{wizardPhase}</p>
                                )}
                            </div>

                            {/* Inline results — shown below search without leaving main view */}
                            {wizardInline && searchResults.length > 0 && wizardProgress.length === 0 && (
                                <div className="bg-white rounded-b-2xl p-4 space-y-2 border-t border-stone-200">
                                    <div className="flex justify-between items-center">
                                        <p className="text-xs font-bold text-forest-dark">Found {searchResults.length} sources</p>
                                        <button onClick={() => { setSearchResults([]); setWizardInline(false); }} className="text-[10px] text-stone-400 hover:text-stone-600">Dismiss</button>
                                    </div>
                                    <div className="max-h-40 overflow-y-auto space-y-1.5">
                                        {searchResults.map((result: any, i: number) => (
                                            <div
                                                key={i}
                                                onClick={() => setSelectedSources(prev => prev.includes(i) ? prev.filter(x => x !== i) : [...prev, i])}
                                                className={`p-2 rounded-lg border cursor-pointer transition-all flex items-center gap-2 ${selectedSources.includes(i) ? 'border-sage-400 bg-sage-50' : 'border-stone-100 hover:border-sage-300'}`}
                                            >
                                                <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${selectedSources.includes(i) ? 'border-sage-500 bg-sage-500 text-white' : 'border-stone-300'}`}>
                                                    {selectedSources.includes(i) && <CheckCircle size={10} />}
                                                </div>
                                                <div className="min-w-0 flex-1">
                                                    <p className="text-[10px] font-bold text-forest-dark truncate">{result.title}</p>
                                                    <a href={result.url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} className="text-[8px] text-sage-600 hover:text-sage-800 underline font-mono truncate block">{result.url}</a>
                                                </div>
                                                <span className={`text-[8px] font-bold px-1.5 py-0.5 rounded shrink-0 ${
                                                    result.type === 'Officials' ? 'bg-blue-100 text-blue-700' :
                                                    result.type === 'Meetings' ? 'bg-purple-100 text-purple-700' :
                                                    result.type === 'Departments' ? 'bg-green-100 text-green-700' :
                                                    'bg-stone-100 text-stone-600'
                                                }`}>{result.type}</span>
                                            </div>
                                        ))}
                                    </div>
                                    <button
                                        onClick={handleBuildEngine}
                                        disabled={selectedSources.length === 0}
                                        className="w-full py-2 bg-forest-dark text-white rounded-xl text-xs font-bold hover:bg-forest-light disabled:opacity-50 transition-colors"
                                    >
                                        Scrape {selectedSources.length} Source{selectedSources.length !== 1 ? 's' : ''}
                                    </button>
                                </div>
                            )}

                            {/* Inline scraping progress */}
                            {wizardInline && wizardProgress.length > 0 && (
                                <div className="bg-white rounded-b-2xl p-4 space-y-2 border-t border-stone-200">
                                    <div className="flex justify-between items-center">
                                        <p className="text-xs font-bold text-forest-dark">
                                            {wizardProgress.every(p => p.status === 'done' || p.status === 'failed')
                                                ? `Done! Found ${wizardExtracted.length} entries`
                                                : `Scraping ${wizardProgress.filter(p => p.status === 'done').length + 1} of ${wizardProgress.length}...`}
                                        </p>
                                    </div>
                                    {/* Progress bar */}
                                    <div className="w-full bg-stone-100 rounded-full h-1.5">
                                        <div className="bg-sage-500 h-1.5 rounded-full transition-all duration-500" style={{ width: `${Math.round((wizardProgress.filter(p => p.status === 'done' || p.status === 'failed').length / Math.max(wizardProgress.length, 1)) * 100)}%` }} />
                                    </div>
                                    <div className="max-h-28 overflow-y-auto space-y-1">
                                        {wizardProgress.map((p, i) => (
                                            <div key={i} className={`p-1.5 rounded-lg flex items-center gap-2 text-[10px] ${p.status === 'scraping' ? 'bg-sage-50' : p.status === 'done' ? 'bg-green-50' : p.status === 'failed' ? 'bg-red-50' : ''}`}>
                                                {p.status === 'pending' && <div className="w-3 h-3 rounded-full border border-stone-200 shrink-0" />}
                                                {p.status === 'scraping' && <Loader2 size={12} className="animate-spin text-sage-600 shrink-0" />}
                                                {p.status === 'done' && <CheckCircle size={12} className="text-green-600 shrink-0" />}
                                                {p.status === 'failed' && <X size={12} className="text-red-500 shrink-0" />}
                                                <a href={p.url} target="_blank" rel="noopener noreferrer" className="font-mono text-sage-600 hover:text-sage-800 underline truncate">{p.url}</a>
                                                {p.status === 'done' && p.entries > 0 && <span className="text-green-600 font-bold shrink-0">+{p.entries}</span>}
                                            </div>
                                        ))}
                                    </div>
                                    {/* Accept button when done */}
                                    {wizardProgress.every(p => p.status === 'done' || p.status === 'failed') && wizardExtracted.length > 0 && (
                                        <div className="flex gap-2 pt-1">
                                            <button onClick={handleWizardAccept} className="flex-1 py-2 bg-forest-dark text-white rounded-xl text-xs font-bold hover:bg-forest-light transition-colors">
                                                Add {wizardExtracted.length} Entries
                                            </button>
                                            <button onClick={() => { setWizardExtracted([]); setWizardProgress([]); setSearchResults([]); setWizardInline(false); }} className="px-3 py-2 bg-white border border-stone-200 rounded-xl text-xs font-bold text-stone-500 hover:bg-stone-50">
                                                Discard
                                            </button>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* === MEETING PREP SECTION === */}
                        <div className="text-center mb-1">
                            <h3 className="text-sm font-bold text-forest-dark">Meeting Prep</h3>
                            <p className="text-[10px] text-stone-400">Add the people and terms for today's meeting</p>
                        </div>

                        {/* 1. Quick Names — the #1 most useful tool */}
                        <div className="bg-white rounded-xl border-2 border-sage-200 p-4 space-y-3 shadow-sm">
                            <div className="flex items-center gap-2">
                                <div className="w-6 h-6 bg-sage-500 rounded-lg flex items-center justify-center text-white"><Type size={12} /></div>
                                <div>
                                    <label className="text-xs font-bold text-forest-dark">Quick Names</label>
                                    <p className="text-[9px] text-stone-400">Paste names of board members, speakers, or staff</p>
                                </div>
                            </div>
                            <textarea
                                value={quickNames}
                                onChange={e => setQuickNames(e.target.value)}
                                placeholder={"Bernard W. Greene\nCouncilor Pham\nMarcia Johnston\nChief Rivera"}
                                className="w-full h-20 px-3 py-2 rounded-lg border border-stone-200 text-xs resize-none focus:outline-none focus:border-sage-500 font-mono"
                                disabled={quickNamesProcessing}
                            />
                            <button
                                onClick={handleQuickNames}
                                disabled={quickNamesProcessing || !quickNames.trim()}
                                className="w-full px-4 py-2 rounded-lg bg-sage-500 text-white text-xs font-bold hover:bg-sage-600 disabled:opacity-40 flex items-center justify-center gap-1.5 transition-colors"
                            >
                                {quickNamesProcessing ? <><Loader2 size={12} className="animate-spin" /> Generating STT corrections...</> : <><Sparkles size={12} /> Generate Corrections</>}
                            </button>
                            {quickNamesResult && <p className="text-[10px] text-sage-600 font-medium">{quickNamesResult}</p>}
                            {/* Preview */}
                            {quickNamesPreview && (
                                <div className="bg-sage-50 rounded-lg border border-sage-200 p-3 space-y-2">
                                    <p className="text-[9px] font-bold text-sage-700 uppercase">Preview — {quickNamesPreview.length} corrections</p>
                                    <div className="max-h-32 overflow-y-auto space-y-1">
                                        {quickNamesPreview.map((e, i) => (
                                            <div key={i} className="flex items-center gap-2 text-[10px]">
                                                <span className="text-red-400 line-through">{e.original}</span>
                                                <ArrowRight size={8} className="text-stone-300" />
                                                <span className="font-bold text-forest-dark">{e.replacement}</span>
                                            </div>
                                        ))}
                                    </div>
                                    <div className="flex gap-2 pt-1">
                                        <button onClick={handleAcceptQuickNames} className="flex-1 px-3 py-1.5 bg-sage-500 text-white text-[10px] font-bold rounded-lg hover:bg-sage-600">Add All to Dictionary</button>
                                        <button onClick={() => setQuickNamesPreview(null)} className="px-3 py-1.5 bg-white border border-stone-200 text-[10px] font-bold rounded-lg text-stone-500 hover:bg-stone-50">Discard</button>
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* 2. Meeting Body Setup */}
                        <div className="bg-white rounded-xl border border-stone-200 p-4 space-y-3">
                            <div className="flex items-center gap-2">
                                <div className="w-6 h-6 bg-blue-500 rounded-lg flex items-center justify-center text-white"><Layout size={12} /></div>
                                <div>
                                    <label className="text-xs font-bold text-forest-dark">Meeting Body Setup</label>
                                    <p className="text-[9px] text-stone-400">Structured input for the governing body being captioned</p>
                                </div>
                            </div>
                            <div>
                                <label className="text-[9px] font-bold text-stone-400 uppercase mb-1 block">Body Name</label>
                                <input
                                    value={bodyName}
                                    onChange={e => setBodyName(e.target.value)}
                                    placeholder="e.g. Select Board, Planning Commission, School Committee"
                                    className="w-full px-3 py-2 rounded-lg border border-stone-200 text-xs focus:outline-none focus:border-blue-400"
                                />
                            </div>
                            <div>
                                <label className="text-[9px] font-bold text-stone-400 uppercase mb-1 block">Members (one per line)</label>
                                <textarea
                                    value={bodyMembers}
                                    onChange={e => setBodyMembers(e.target.value)}
                                    placeholder={"Chair John Doe\nVice-Chair Jane Smith\nMember Carlos Rodriguez"}
                                    className="w-full h-16 px-3 py-2 rounded-lg border border-stone-200 text-xs resize-none focus:outline-none focus:border-blue-400 font-mono"
                                />
                            </div>
                            <div>
                                <label className="text-[9px] font-bold text-stone-400 uppercase mb-1 block">Acronyms (format: CIP = Capital Improvement Plan)</label>
                                <textarea
                                    value={bodyAcronyms}
                                    onChange={e => setBodyAcronyms(e.target.value)}
                                    placeholder={"CIP = Capital Improvement Plan\nADA = Americans with Disabilities Act\nDPW = Department of Public Works"}
                                    className="w-full h-16 px-3 py-2 rounded-lg border border-stone-200 text-xs resize-none focus:outline-none focus:border-blue-400 font-mono"
                                />
                            </div>
                            <button
                                onClick={handleMeetingBody}
                                disabled={bodyProcessing || (!bodyName.trim() && !bodyMembers.trim() && !bodyAcronyms.trim())}
                                className="w-full px-4 py-2 rounded-lg bg-blue-500 text-white text-xs font-bold hover:bg-blue-600 disabled:opacity-40 flex items-center justify-center gap-1.5 transition-colors"
                            >
                                {bodyProcessing ? <><Loader2 size={12} className="animate-spin" /> Processing...</> : <><Plus size={12} /> Build Dictionary</>}
                            </button>
                            {bodyResult && <p className="text-[10px] text-blue-600 font-medium">{bodyResult}</p>}
                        </div>

                        {/* === DOCUMENT INGESTION === */}
                        <div className="text-center mt-2 mb-1">
                            <h3 className="text-sm font-bold text-stone-400">Document Ingestion</h3>
                            <p className="text-[10px] text-stone-400">Extract names from agendas and documents</p>
                        </div>

                        {/* 3. Paste Agenda Text — with preview */}
                        <div className="bg-white rounded-xl border border-stone-200 p-4 space-y-3">
                            <div className="flex items-center gap-2">
                                <div className="w-6 h-6 bg-purple-500 rounded-lg flex items-center justify-center text-white"><FileText size={12} /></div>
                                <label className="text-xs font-bold text-forest-dark">Paste Agenda Text</label>
                            </div>
                            <textarea
                                value={pasteText}
                                onChange={e => { setPasteText(e.target.value); setPastePreview(null); }}
                                placeholder="Paste meeting agenda, minutes, or any document text here..."
                                className="w-full h-20 px-3 py-2 rounded-lg border border-stone-200 text-xs resize-none focus:outline-none focus:border-purple-400"
                            />
                            <button
                                onClick={handleExtractFromPaste}
                                disabled={extracting || !pasteText.trim()}
                                className="w-full px-4 py-2 rounded-lg bg-purple-500 text-white text-xs font-bold hover:bg-purple-600 disabled:opacity-40 flex items-center justify-center gap-1.5 transition-colors"
                            >
                                {extracting ? <><Loader2 size={12} className="animate-spin" /> Analyzing text...</> : 'Extract Names & Terms'}
                            </button>
                            {pasteResult && !pastePreview && <p className="text-[10px] text-purple-600 font-medium">{pasteResult}</p>}
                            {/* Preview before adding */}
                            {pastePreview && (
                                <div className="bg-purple-50 rounded-lg border border-purple-200 p-3 space-y-2">
                                    <p className="text-[9px] font-bold text-purple-700 uppercase">Found {pastePreview.length} entries — review before adding</p>
                                    <div className="max-h-32 overflow-y-auto space-y-1">
                                        {pastePreview.map((e, i) => (
                                            <div key={i} className="flex items-center gap-2 text-[10px]">
                                                <span className="text-red-400 line-through">{e.original}</span>
                                                <ArrowRight size={8} className="text-stone-300" />
                                                <span className="font-bold text-forest-dark">{e.replacement}</span>
                                                <span className={`text-[8px] px-1 py-0.5 rounded ${e.type === 'acronym' ? 'bg-purple-100 text-purple-600' : 'bg-blue-100 text-blue-600'}`}>{e.type}</span>
                                            </div>
                                        ))}
                                    </div>
                                    <div className="flex gap-2 pt-1">
                                        <button onClick={handleAcceptPastePreview} className="flex-1 px-3 py-1.5 bg-purple-500 text-white text-[10px] font-bold rounded-lg hover:bg-purple-600">Add All to Dictionary</button>
                                        <button onClick={() => setPastePreview(null)} className="px-3 py-1.5 bg-white border border-stone-200 text-[10px] font-bold rounded-lg text-stone-500 hover:bg-stone-50">Discard</button>
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* 4. Drag & Drop Upload */}
                        <div
                            onDragEnter={handleDrag}
                            onDragLeave={handleDrag}
                            onDragOver={handleDrag}
                            onDrop={handleDrop}
                            onClick={() => fileUploadRef.current?.click()}
                            className={`border-2 border-dashed rounded-2xl h-28 flex flex-col items-center justify-center text-center p-4 transition-all cursor-pointer ${dragActive ? 'border-sage-500 bg-sage-50' : 'border-stone-200 hover:border-sage-400 hover:bg-stone-50'}`}
                        >
                            {uploading ? (
                                <>
                                    <Loader2 size={24} className="animate-spin text-sage-500 mb-2" />
                                    <p className="text-xs font-bold text-sage-600">Extracting names & terms...</p>
                                </>
                            ) : (
                                <>
                                    <Upload size={24} className={`mb-2 ${dragActive ? 'text-sage-600' : 'text-stone-300'}`} />
                                    <p className="text-xs font-bold text-stone-600">Drop Agenda PDFs Here</p>
                                    <p className="text-[10px] text-stone-400">or click to upload</p>
                                </>
                            )}
                            <input
                                ref={fileUploadRef}
                                type="file"
                                className="hidden"
                                accept=".pdf,.txt,.doc,.docx,.json"
                                onChange={async (e) => {
                                    const file = e.target.files?.[0];
                                    if (!file) return;
                                    setUploading(true);
                                    const formData = new FormData();
                                    formData.append('file', file);
                                    try {
                                        const res = await fetch(`${getRelayUrl()}/api/context/upload-pdf`, {
                                            method: 'POST',
                                            headers: { 'X-Api-Key': getApiKey() },
                                            body: formData,
                                        });
                                        const data = await res.json();
                                        if (data.ok && data.entries?.length > 0) {
                                            const newEntries = data.entries.map((entry: any) => ({
                                                original: entry.original,
                                                replacement: entry.replacement,
                                                type: entry.type || 'proper_noun',
                                            }));
                                            setDictionary(prev => [...prev, ...newEntries]);
                                            alert(`Extracted ${data.entries.length} entries from ${file.name}`);
                                        } else {
                                            alert(data.warning || data.error || `No entries found in ${file.name}`);
                                        }
                                    } catch (err) {
                                        alert('Upload failed: ' + (err as Error).message);
                                    }
                                    setUploading(false);
                                    e.target.value = '';
                                }}
                            />
                        </div>

                        {/* === ADVANCED TOOLS === */}
                        <div className="text-center mt-2 mb-1">
                            <h3 className="text-sm font-bold text-stone-400">Advanced Tools</h3>
                        </div>

                        {/* 5. URL Scraper */}
                        <div className="bg-white rounded-xl border border-stone-200 p-4 space-y-3">
                            <div className="flex items-center gap-2">
                                <div className="w-6 h-6 bg-stone-400 rounded-lg flex items-center justify-center text-white"><Link size={12} /></div>
                                <label className="text-xs font-bold text-forest-dark">Scrape URL</label>
                            </div>
                            <div className="flex gap-2">
                                <input
                                    type="url"
                                    value={scrapeUrl}
                                    onChange={e => setScrapeUrl(e.target.value)}
                                    placeholder="https://townsite.gov/elected-officials"
                                    className="flex-1 px-3 py-2 rounded-lg border border-stone-200 text-xs focus:outline-none focus:border-forest-dark"
                                />
                                <button
                                    onClick={handleScrapeUrl}
                                    disabled={scraping || !scrapeUrl}
                                    className="px-4 py-2 rounded-lg bg-forest-dark text-white text-xs font-bold hover:opacity-90 disabled:opacity-40 flex items-center gap-1.5"
                                >
                                    {scraping ? <Loader2 size={12} className="animate-spin" /> : 'Scrape'}
                                </button>
                            </div>
                            {scrapeResult && <p className="text-[10px] text-green-600">{scrapeResult}</p>}
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
                                <div className="w-20 h-20 bg-sage-100 rounded-full flex items-center justify-center mb-6 text-forest-dark">
                                    <MapPin size={40} />
                                </div>
                                <h3 className="text-2xl font-display font-bold text-forest-dark mb-3">Municipality Scraper</h3>

                                {showKeyPrompt ? (
                                    <div className="w-full max-w-sm bg-orange-50 p-4 rounded-xl border border-orange-200 animate-slide-up">
                                        <div className="flex items-center gap-2 text-orange-700 font-bold text-sm mb-2">
                                            <Key size={16} /> API Key Required
                                        </div>
                                        <p className="text-xs text-stone-600 mb-3 text-left">Gemini AI is needed to find and analyze municipal web pages.</p>
                                        <input
                                            type="password"
                                            value={tempKey}
                                            onChange={e => setTempKey(e.target.value)}
                                            placeholder="Paste Gemini API Key..."
                                            className="w-full border border-stone-200 rounded p-2 text-sm mb-2"
                                        />
                                        <button
                                            onClick={() => { setShowKeyPrompt(false); handleMunicipalitySearch(); }}
                                            disabled={!tempKey}
                                            className="w-full bg-forest-dark text-white py-2 rounded font-bold text-sm disabled:opacity-50"
                                        >
                                            Save & Continue
                                        </button>
                                    </div>
                                ) : (
                                    <>
                                        <p className="text-stone-500 mb-4 max-w-sm text-sm">Enter a municipality name. We'll find their official web pages and scrape them for council members, department heads, street names, and local terminology.</p>
                                        <div className="relative w-full max-w-sm">
                                            <input
                                                value={searchQuery}
                                                onChange={(e) => setSearchQuery(e.target.value)}
                                                onKeyDown={(e) => e.key === 'Enter' && !isProcessing && handleMunicipalitySearch()}
                                                placeholder="e.g. Brookline, MA"
                                                className="w-full text-lg px-6 py-4 bg-white border-2 border-stone-200 rounded-xl shadow-sm focus:border-sage-500 outline-none pr-14"
                                                autoFocus
                                                disabled={isProcessing}
                                            />
                                            <button
                                                onClick={handleMunicipalitySearch}
                                                disabled={isProcessing || !searchQuery.trim()}
                                                className="absolute right-2 top-2 bottom-2 w-12 bg-forest-dark text-white rounded-lg hover:bg-forest-light transition-colors flex items-center justify-center disabled:opacity-50"
                                            >
                                                {isProcessing ? <Loader2 className="animate-spin" size={20} /> : <ArrowRight size={20} />}
                                            </button>
                                        </div>
                                        {isProcessing && (
                                            <p className="text-xs text-sage-600 mt-3 animate-pulse">{wizardPhase || `Finding official web pages for ${searchQuery}...`}</p>
                                        )}
                                    </>
                                )}
                            </div>
                        )}

                        {view === 'wizard_select' && (
                             <div className="flex-1 flex flex-col">
                                <div className="mb-4">
                                    <h3 className="text-xl font-display font-bold text-forest-dark mb-1">Found {searchResults.length} Sources</h3>
                                    <p className="text-stone-500 text-sm">Select pages to scrape. Each URL will be fetched and analyzed for proper nouns.</p>
                                </div>
                                <div className="flex-1 overflow-y-auto space-y-2 pr-2 custom-scrollbar">
                                    {searchResults.map((result: any, i: number) => (
                                        <div
                                            key={i}
                                            onClick={() => setSelectedSources(prev => prev.includes(i) ? prev.filter(x => x !== i) : [...prev, i])}
                                            className={`p-3 rounded-xl border-2 cursor-pointer transition-all ${selectedSources.includes(i) ? 'border-sage-500 bg-sage-50' : 'border-stone-100 bg-white hover:border-sage-300'}`}
                                        >
                                            <div className="flex justify-between items-start gap-2">
                                                <div className="flex-1 min-w-0">
                                                    <div className="flex items-center gap-2 mb-1">
                                                        <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${
                                                            result.type === 'Officials' ? 'bg-blue-100 text-blue-700' :
                                                            result.type === 'Meetings' ? 'bg-purple-100 text-purple-700' :
                                                            result.type === 'Departments' ? 'bg-green-100 text-green-700' :
                                                            result.type === 'Committees' ? 'bg-amber-100 text-amber-700' :
                                                            'bg-stone-100 text-stone-600'
                                                        }`}>{result.type}</span>
                                                        <h4 className="font-bold text-forest-dark text-sm truncate">{result.title}</h4>
                                                    </div>
                                                    <a href={result.url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} className="text-[10px] text-sage-600 hover:text-sage-800 underline font-mono truncate block">{result.url}</a>
                                                    {result.why && <p className="text-xs text-stone-500 mt-1">{result.why}</p>}
                                                </div>
                                                <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 mt-1 ${selectedSources.includes(i) ? 'border-sage-500 bg-sage-500 text-white' : 'border-stone-300'}`}>
                                                    {selectedSources.includes(i) && <CheckCircle size={12} />}
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                                <div className="pt-4 mt-auto flex gap-2">
                                    <button onClick={() => setView('wizard_search')} className="px-4 py-3 rounded-xl font-bold text-sm text-stone-500 hover:bg-stone-100 transition-colors">
                                        Back
                                    </button>
                                    <button
                                        onClick={handleBuildEngine}
                                        disabled={selectedSources.length === 0}
                                        className="flex-1 bg-forest-dark text-white py-3 rounded-xl font-bold hover:bg-forest-light disabled:opacity-50 shadow-lg transition-colors"
                                    >
                                        Scrape {selectedSources.length} Source{selectedSources.length !== 1 ? 's' : ''}
                                    </button>
                                </div>
                            </div>
                        )}

                        {view === 'wizard_analyze' && (
                            <div className="flex-1 flex flex-col">
                                <div className="mb-4">
                                    <h3 className="text-xl font-display font-bold text-forest-dark mb-1">Scraping & Extracting</h3>
                                    <p className="text-stone-500 text-sm">
                                        {wizardProgress.every(p => p.status === 'done' || p.status === 'failed')
                                            ? `Done! Found ${wizardExtracted.length} dictionary entries.`
                                            : `Scraping ${wizardProgress.filter(p => p.status === 'done').length + 1} of ${wizardProgress.length}...`
                                        }
                                    </p>
                                </div>

                                {/* Progress bar */}
                                <div className="w-full bg-stone-100 rounded-full h-2 mb-4">
                                    <div
                                        className="bg-sage-500 h-2 rounded-full transition-all duration-500"
                                        style={{ width: `${Math.round((wizardProgress.filter(p => p.status === 'done' || p.status === 'failed').length / Math.max(wizardProgress.length, 1)) * 100)}%` }}
                                    />
                                </div>

                                {/* Per-URL progress */}
                                <div className="flex-1 overflow-y-auto space-y-2 pr-2 custom-scrollbar">
                                    {wizardProgress.map((p, i) => (
                                        <div key={i} className={`p-3 rounded-lg border flex items-center gap-3 ${
                                            p.status === 'scraping' ? 'border-sage-300 bg-sage-50' :
                                            p.status === 'done' ? 'border-green-200 bg-green-50' :
                                            p.status === 'failed' ? 'border-red-200 bg-red-50' :
                                            'border-stone-100 bg-white'
                                        }`}>
                                            <div className="shrink-0">
                                                {p.status === 'pending' && <div className="w-5 h-5 rounded-full border-2 border-stone-200" />}
                                                {p.status === 'scraping' && <Loader2 size={20} className="animate-spin text-sage-600" />}
                                                {p.status === 'done' && <CheckCircle size={20} className="text-green-600" />}
                                                {p.status === 'failed' && <X size={20} className="text-red-500" />}
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <a href={p.url} target="_blank" rel="noopener noreferrer" className="text-xs font-mono text-sage-600 hover:text-sage-800 underline truncate block">{p.url}</a>
                                                {p.status === 'done' && p.entries > 0 && (
                                                    <p className="text-[10px] text-green-600 font-bold mt-0.5">+{p.entries} entries extracted</p>
                                                )}
                                                {p.status === 'done' && p.entries === 0 && (
                                                    <p className="text-[10px] text-stone-400 mt-0.5">{p.error || 'No extractable content'}</p>
                                                )}
                                                {p.status === 'failed' && (
                                                    <p className="text-[10px] text-red-500 mt-0.5">{p.error || 'Failed to fetch'}</p>
                                                )}
                                                {p.status === 'scraping' && (
                                                    <p className="text-[10px] text-sage-600 mt-0.5 animate-pulse">Fetching and analyzing...</p>
                                                )}
                                            </div>
                                        </div>
                                    ))}
                                </div>

                                {/* Extracted entries preview */}
                                {wizardExtracted.length > 0 && (
                                    <div className="mt-3 p-3 bg-stone-50 rounded-lg border border-stone-200 max-h-32 overflow-y-auto">
                                        <p className="text-[10px] font-bold text-stone-400 uppercase tracking-wider mb-2">Preview ({wizardExtracted.length} entries)</p>
                                        <div className="flex flex-wrap gap-1">
                                            {wizardExtracted.slice(0, 20).map((e, i) => (
                                                <span key={i} className="text-[10px] bg-white border border-stone-200 rounded px-1.5 py-0.5 text-stone-600">{e.replacement}</span>
                                            ))}
                                            {wizardExtracted.length > 20 && (
                                                <span className="text-[10px] text-stone-400">+{wizardExtracted.length - 20} more</span>
                                            )}
                                        </div>
                                    </div>
                                )}

                                {/* Action buttons */}
                                {wizardProgress.every(p => p.status === 'done' || p.status === 'failed') && (
                                    <div className="pt-4 mt-auto flex gap-2">
                                        <button onClick={() => { setWizardExtracted([]); setWizardProgress([]); setView('wizard_select'); }} className="px-4 py-3 rounded-xl font-bold text-sm text-stone-500 hover:bg-stone-100 transition-colors">
                                            Back
                                        </button>
                                        <button
                                            onClick={handleWizardAccept}
                                            disabled={wizardExtracted.length === 0}
                                            className="flex-1 bg-forest-dark text-white py-3 rounded-xl font-bold hover:bg-forest-light disabled:opacity-50 shadow-lg transition-colors"
                                        >
                                            Add {wizardExtracted.length} Entries to Dictionary
                                        </button>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* Right Panel: Active Rules & Management */}
            <div className="flex-1 bg-stone-50 flex flex-col h-full overflow-hidden relative">
                <div className="p-8 flex-1 overflow-y-auto custom-scrollbar">
                    <div className="flex justify-between items-end mb-4">
                        <div className="flex items-center gap-3">
                            <h3 className="text-2xl font-display font-bold text-forest-dark">Active Rules</h3>
                            {dictionary.length > 0 && (
                                <span className="bg-sage-100 text-sage-700 text-xs font-bold px-2 py-0.5 rounded-full">{dictionary.length}</span>
                            )}
                        </div>
                        <div className="flex items-center gap-2">
                             <input type="file" ref={importInputRef} className="hidden" accept=".json" onChange={handleImport} />
                             <button onClick={() => importInputRef.current?.click()} className="flex items-center gap-2 px-3 py-1.5 bg-white border border-stone-200 rounded-lg text-xs font-bold text-stone-600 hover:bg-stone-50 hover:border-forest-dark transition-colors" title="Load a JSON engine file">
                                <Upload size={14} /> Import
                             </button>
                             <button onClick={handleExport} className="flex items-center gap-2 px-3 py-1.5 bg-forest-dark text-white rounded-lg text-xs font-bold hover:bg-forest-light shadow-md transition-colors" title="Save current engine as JSON">
                                <Download size={14} /> Export
                             </button>
                             {dictionary.length > 5 && (
                                <button onClick={() => { if (confirm(`Remove all ${dictionary.length} dictionary entries?`)) setDictionary([]); }} className="flex items-center gap-1 px-3 py-1.5 bg-white border border-red-200 rounded-lg text-xs font-bold text-red-500 hover:bg-red-50 transition-colors" title="Clear all entries">
                                    <Trash2 size={14} /> Clear
                                </button>
                             )}
                        </div>
                    </div>

                    {/* Search + Type Filter */}
                    {dictionary.length > 3 && (
                        <div className="mb-4 space-y-2">
                            <div className="relative">
                                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
                                <input
                                    value={dictSearch}
                                    onChange={e => setDictSearch(e.target.value)}
                                    placeholder="Search dictionary..."
                                    className="w-full pl-9 pr-3 py-2 rounded-lg border border-stone-200 text-sm focus:outline-none focus:border-sage-500 bg-white"
                                />
                            </div>
                            <div className="flex gap-1.5 flex-wrap">
                                {['proper_noun', 'place', 'acronym', 'correction'].map(type => {
                                    const count = dictionary.filter(e => (e.type || 'proper_noun') === type).length;
                                    if (count === 0) return null;
                                    const isActive = dictTypeFilter === type;
                                    return (
                                        <button
                                            key={type}
                                            onClick={() => setDictTypeFilter(isActive ? null : type)}
                                            className={`text-[10px] font-bold px-2 py-1 rounded-full transition-colors ${isActive
                                                ? type === 'proper_noun' ? 'bg-blue-500 text-white' :
                                                  type === 'place' ? 'bg-green-500 text-white' :
                                                  type === 'acronym' ? 'bg-purple-500 text-white' :
                                                  'bg-orange-500 text-white'
                                                : type === 'proper_noun' ? 'bg-blue-50 text-blue-600 hover:bg-blue-100' :
                                                  type === 'place' ? 'bg-green-50 text-green-600 hover:bg-green-100' :
                                                  type === 'acronym' ? 'bg-purple-50 text-purple-600 hover:bg-purple-100' :
                                                  'bg-orange-50 text-orange-600 hover:bg-orange-100'
                                            }`}
                                        >
                                            {type.replace('_', ' ')} ({count})
                                        </button>
                                    );
                                })}
                                {(dictTypeFilter || dictSearch) && (
                                    <button onClick={() => { setDictTypeFilter(null); setDictSearch(''); }} className="text-[10px] font-bold px-2 py-1 rounded-full bg-stone-100 text-stone-500 hover:bg-stone-200">
                                        Clear filters
                                    </button>
                                )}
                            </div>
                        </div>
                    )}

                    {/* AI Suggestions */}
                    {suggestions.length > 0 && (
                        <div className="mb-4 space-y-2">
                            <p className="text-xs font-bold text-amber-600 uppercase tracking-wider">AI Suggestions ({suggestions.length})</p>
                            {suggestions.map(s => (
                                <div key={s.id} className="flex items-center gap-2 p-2 rounded-lg border border-amber-200 bg-amber-50">
                                    <div className="flex-1">
                                        <span className="text-xs text-red-500 line-through">{s.original}</span>
                                        <span className="text-xs text-stone-400 mx-1">&rarr;</span>
                                        <span className="text-xs font-bold text-forest-dark">{s.replacement}</span>
                                    </div>
                                    <button onClick={() => {
                                        fetch(`${getRelayUrl()}/api/context/accept`, {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ id: s.id }),
                                        }).then(r => r.json()).then(data => {
                                            if (data.ok && data.entry) {
                                                setDictionary([...dictionary, data.entry]);
                                                setSuggestions(prev => prev.filter(x => x.id !== s.id));
                                            }
                                        });
                                    }} className="px-2 py-1 rounded bg-green-500 text-white text-[10px] font-bold">Accept</button>
                                    <button onClick={() => {
                                        fetch(`${getRelayUrl()}/api/context/dismiss`, {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ id: s.id }),
                                        });
                                        setSuggestions(prev => prev.filter(x => x.id !== s.id));
                                    }} className="px-2 py-1 rounded bg-stone-200 text-stone-500 text-[10px] font-bold">Dismiss</button>
                                </div>
                            ))}
                        </div>
                    )}

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
                    <div className="space-y-2 pb-20">
                         {dictionary.length === 0 ? (
                            <div className="text-center py-20 opacity-40">
                                <Sparkles size={48} className="mx-auto mb-4 text-stone-400" />
                                <h4 className="text-xl font-bold text-stone-400">Context Empty</h4>
                                <p className="text-stone-400">Add rules manually or use the Ingestion Tools.</p>
                            </div>
                         ) : (
                             dictionary
                                .map((entry, idx) => ({ entry, idx }))
                                .filter(({ entry }) => {
                                    if (dictTypeFilter && (entry.type || 'proper_noun') !== dictTypeFilter) return false;
                                    if (dictSearch) {
                                        const q = dictSearch.toLowerCase();
                                        return entry.original.toLowerCase().includes(q) || entry.replacement.toLowerCase().includes(q);
                                    }
                                    return true;
                                })
                                .map(({ entry, idx }) => (
                                <div key={idx} className="bg-white border border-stone-200 p-3 rounded-xl flex items-center justify-between group hover:border-sage-300 hover:shadow-md transition-all">
                                    <div className="flex items-center gap-3 flex-1 min-w-0">
                                        <div className={`w-7 h-7 rounded-full flex items-center justify-center font-bold text-[9px] shrink-0 ${
                                            (entry.type || 'proper_noun') === 'proper_noun' ? 'bg-blue-100 text-blue-700' :
                                            entry.type === 'place' ? 'bg-green-100 text-green-700' :
                                            entry.type === 'acronym' ? 'bg-purple-100 text-purple-700' :
                                            'bg-orange-100 text-orange-700'
                                        }`}>
                                            {(entry.type || 'proper_noun') === 'proper_noun' ? 'PN' :
                                             entry.type === 'place' ? 'PL' :
                                             entry.type === 'acronym' ? 'AC' : 'FX'}
                                        </div>
                                        <div className="flex items-center gap-2 min-w-0">
                                            <span className="text-red-400 line-through text-sm truncate">{entry.original}</span>
                                            <ArrowRight size={12} className="text-stone-300 shrink-0" />
                                            <span className="text-forest-dark font-bold text-sm truncate">{entry.replacement}</span>
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => setDictionary(p => p.filter((_,i) => i !== idx))}
                                        className="text-stone-300 hover:text-red-500 p-1.5 opacity-0 group-hover:opacity-100 transition-all shrink-0"
                                    >
                                        <Trash2 size={16} />
                                    </button>
                                </div>
                             ))
                         )}
                         {dictionary.length > 0 && dictSearch && dictionary.filter(e => {
                             const q = dictSearch.toLowerCase();
                             return e.original.toLowerCase().includes(q) || e.replacement.toLowerCase().includes(q);
                         }).length === 0 && (
                            <p className="text-center text-sm text-stone-400 py-8">No entries match "{dictSearch}"</p>
                         )}
                    </div>
                </div>
            </div>
        </div>
    </div>
  );
};

export default ContextEngine;