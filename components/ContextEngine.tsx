import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { Upload, Download, Search, CheckCircle, X, Loader2, Database, Plus, Trash2, ArrowRight, Globe, FileText, Link, ShieldAlert, Sparkles, Sliders, Code, Zap, Key, Layout, Type, ChevronDown, ChevronRight, ExternalLink, AlertTriangle, Users, Building2, MapPin, Hash, RotateCcw, FolderOpen, Save, Wand2 } from 'lucide-react';
import { DictionaryEntry, ContextSettings } from '../types';
import { buildCorrectionIndex, applyCorrections } from '../shared/corrections.js';

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
  /** Correction settings used by the live caption pipeline (sensitivity gates phonetic matching) */
  contextSettings?: ContextSettings;
  setContextSettings?: (s: ContextSettings) => void;
}

type ProfileSummary = { id: string; name: string; municipality?: string; notes?: string; entryCount: number; updatedAt: number; createdAt: number };

// --- Wizard types (mirror server/context-sources.js) ---
type WizardItem = {
  id: string;
  name: string;
  category: string;
  detail: string;
  misheard: string[];
  entries: DictionaryEntry[];
  group: string;
};
type WizardGroup = {
  key: string;
  label: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  items: WizardItem[];
  error?: string;
  elapsedMs?: number;
};
type WizardSource = {
  title: string;
  url: string;
  type: string;
  why?: string;
  reachable?: boolean;
  blocked?: boolean;
  isPdf?: boolean;
};
type PreviewEntry = DictionaryEntry & { note?: string };

const GROUP_ICONS: Record<string, React.FC<any>> = { people: Users, bodies: Building2, places: MapPin, acronyms: Hash };

const entryKey = (e: { original: string; replacement: string }) => `${e.original.toLowerCase()}→${e.replacement.toLowerCase()}`;

/** Parse a fetch() SSE body, calling onEvent for each JSON data line. */
async function readSse(res: Response, onEvent: (ev: any) => void) {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLine = raw.split('\n').find(l => l.startsWith('data:'));
      if (!dataLine) continue;
      try { onEvent(JSON.parse(dataLine.slice(5).trim())); } catch {}
    }
  }
}

const ContextEngine: React.FC<ContextEngineProps> = ({
    dictionary, setDictionary, onClose,
    learningEnabled, setLearningEnabled,
    activeContextName, setActiveContextName,
    profanityFilter, setProfanityFilter,
    partialResults, setPartialResults,
    speakerLabels, setSpeakerLabels,
    apiKey,
    contextSettings, setContextSettings
}) => {
  const [view, setView] = useState<'main' | 'settings' | 'raw'>('main');
  const [engineName, setEngineName] = useState(activeContextName || '');
  const [searchQuery, setSearchQuery] = useState('');
  const [dragActive, setDragActive] = useState(false);
  const [showNameError, setShowNameError] = useState(false);
  const [rawJson, setRawJson] = useState('');
  const [settingsVisited, setSettingsVisited] = useState(false);

  // Server-side API key status — drives the banner and the wizard gating
  const [serverKey, setServerKey] = useState<{loaded: boolean, source: string, masked: string} | null>(null);
  const [showInlineKeyForm, setShowInlineKeyForm] = useState(false);
  const [capabilities, setCapabilities] = useState<{pdf: boolean, docx: boolean, upload: boolean, geminiKey?: boolean, model?: string, brain?: { enabled: boolean; model: string; url: string }, extractionEngine?: string} | null>(null);
  const brainOn = !!capabilities?.brain?.enabled && !!capabilities?.brain?.model;

  // --- Municipality Wizard state ---
  const [wizardState, setWizardState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [wizardStatusLine, setWizardStatusLine] = useState('');
  const [wizardGroups, setWizardGroups] = useState<WizardGroup[]>([]);
  const [wizardSelected, setWizardSelected] = useState<Set<string>>(new Set());
  const [wizardCollapsed, setWizardCollapsed] = useState<Set<string>>(new Set());
  const [wizardSources, setWizardSources] = useState<WizardSource[]>([]);
  const [wizardHost, setWizardHost] = useState<string | null>(null);
  const [wizardNote, setWizardNote] = useState<string | null>(null);
  const [wizardError, setWizardError] = useState<string | null>(null);
  const [wizardStartedAt, setWizardStartedAt] = useState(0);
  const [wizardElapsed, setWizardElapsed] = useState(0);
  const [wizardAdded, setWizardAdded] = useState<number | null>(null);
  const [showSources, setShowSources] = useState(false);
  const [locateStatus, setLocateStatus] = useState<'pending' | 'running' | 'done' | 'failed'>('pending');
  const wizardAbortRef = useRef<AbortController | null>(null);

  // --- Deep scan (per-URL streaming scrape) state ---
  type ScanPhase = 'queued' | 'fetching' | 'fetched' | 'parsing' | 'parsed' | 'ai_fetch' | 'extracting' | 'done' | 'failed';
  const [selectedSources, setSelectedSources] = useState<number[]>([]);
  const [scanLive, setScanLive] = useState<{ url: string; phase: ScanPhase; detail: string; entries: number; startedAt: number; elapsedMs: number; error?: string }[]>([]);
  const [scanExtracted, setScanExtracted] = useState<DictionaryEntry[]>([]);
  const [scanRecent, setScanRecent] = useState<DictionaryEntry[]>([]);
  const [scanRunning, setScanRunning] = useState(false);

  // Correction settings live in App state (the live caption pipeline reads them);
  // fall back to local state when a parent doesn't provide them.
  const [localSettings, setLocalSettings] = useState<ContextSettings>({ sensitivity: 80, acronymExpansion: true, dialect: 'general' });
  const settings = contextSettings || localSettings;
  const setSettings = (s: ContextSettings) => { setLocalSettings(s); setContextSettings?.(s); };

  // "Try a sentence" — live preview of what the dictionary does at the current sensitivity
  const [testSentence, setTestSentence] = useState('');
  const correctionIndex = useMemo(() => buildCorrectionIndex(dictionary), [dictionary]);
  const testResult = useMemo(() => testSentence.trim() ? applyCorrections(testSentence, correctionIndex, { sensitivity: settings.sensitivity }) : null, [testSentence, correctionIndex, settings.sensitivity]);

  // Named profiles (stored on the relay so every operator machine sees them)
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [showProfiles, setShowProfiles] = useState(false);
  const [profilesBusy, setProfilesBusy] = useState(false);
  const [profilesMsg, setProfilesMsg] = useState<{ text: string; kind: 'ok' | 'error' } | null>(null);

  const importInputRef = useRef<HTMLInputElement>(null);
  const fileUploadRef = useRef<HTMLInputElement>(null);

  const [manualOriginal, setManualOriginal] = useState('');
  const [manualReplacement, setManualReplacement] = useState('');

  const [tempKey, setTempKey] = useState(apiKey || '');

  // Scrape URL tool
  const [scrapeUrl, setScrapeUrl] = useState('');
  const [scraping, setScraping] = useState(false);
  const [scrapeResult, setScrapeResult] = useState<{ text: string; kind: 'ok' | 'warn' | 'error' } | null>(null);
  const [scrapePreview, setScrapePreview] = useState<PreviewEntry[] | null>(null);

  // Upload tool
  // Document ingestion: one job per uploaded file, streamed from /api/context/upload-stream
  type IngestJob = {
      id: string; filename: string; bytes: number; startedAt: number;
      status: 'queued' | 'reading' | 'extracting' | 'done' | 'error' | 'added';
      message?: string; chunk?: number; chunks?: number; engine?: string;
      kind?: string; pages?: number | null; chars?: number; words?: number; preview?: string;
      entries: PreviewEntry[]; existing: number; warning?: string; error?: string; ms?: number;
      selected: Set<string>; added?: number; showText?: boolean;
  };
  const [ingestJobs, setIngestJobs] = useState<IngestJob[]>([]);
  const ingestBusyRef = useRef(false);
  const ingestQueueRef = useRef<{ id: string; file: File }[]>([]);

  // Paste tool
  const [pasteText, setPasteText] = useState('');
  const [extracting, setExtracting] = useState(false);
  const [pasteResult, setPasteResult] = useState('');
  const [pastePreview, setPastePreview] = useState<PreviewEntry[] | null>(null);

  // Quick Names state
  const [quickNames, setQuickNames] = useState('');
  const [quickNamesProcessing, setQuickNamesProcessing] = useState(false);
  const [quickNamesResult, setQuickNamesResult] = useState('');
  const [quickNamesPreview, setQuickNamesPreview] = useState<PreviewEntry[] | null>(null);

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
  const [learnerStatus, setLearnerStatus] = useState<any | null>(null);

  const getRelayUrl = () => {
      const port = window.location.port || (window.location.protocol === 'https:' ? '443' : '80');
      const p = parseInt(port);
      const relayPort = (p >= 5170 && p <= 5199) ? '8080' : port;
      const isDefault = (window.location.protocol === 'https:' && relayPort === '443') || (window.location.protocol === 'http:' && relayPort === '80');
      return `${window.location.protocol}//${window.location.hostname}${isDefault ? '' : `:${relayPort}`}`;
  };

  const getApiKey = () => localStorage.getItem('cc_api_key') || apiKey || '';

  // True when either localStorage has a usable key OR the server has one loaded
  // (from .env.local or set previously via /api/polisher/apikey).
  const hasUsableKey = () => {
      const local = getApiKey();
      if (local && local.length > 10 && local !== 'PLACEHOLDER_API_KEY') return true;
      return !!serverKey?.loaded;
  };

  const apiHeaders = (json = true): Record<string, string> => {
      const h: Record<string, string> = { 'X-Api-Key': getApiKey() };
      if (json) h['Content-Type'] = 'application/json';
      return h;
  };

  /** Add entries to the dictionary, skipping duplicates. Returns the number added. */
  const addEntries = (entries: PreviewEntry[], source: string): number => {
      let added = 0;
      setDictionary(prev => {
          const existing = new Set(prev.map(entryKey));
          const novel: DictionaryEntry[] = [];
          for (const e of entries) {
              if (!e.original || !e.replacement) continue;
              const k = entryKey(e);
              if (existing.has(k)) continue;
              existing.add(k);
              novel.push({ original: e.original, replacement: e.replacement, type: (e.type as any) || 'proper_noun', ...(e.note ? { note: e.note } : {}), source });
          }
          added = novel.length;
          return novel.length ? [...prev, ...novel] : prev;
      });
      return added;
  };

  const normalizeEntries = (list: any[]): PreviewEntry[] => (Array.isArray(list) ? list : [])
      .filter(e => e && e.original && e.replacement)
      .map(e => ({ original: String(e.original), replacement: String(e.replacement), type: e.type || 'proper_noun', note: e.note || undefined }));

  // ---------------------------------------------------------------------
  // Tool handlers
  // ---------------------------------------------------------------------

  const handleScrapeUrl = async () => {
      setScraping(true);
      setScrapeResult(null);
      setScrapePreview(null);
      try {
          const res = await fetch(`${getRelayUrl()}/api/context/scrape`, {
              method: 'POST',
              headers: apiHeaders(),
              body: JSON.stringify({ url: scrapeUrl.trim(), apiKey: getApiKey() }),
          });
          const data = await res.json();
          const entries = normalizeEntries(data.entries);
          if (data.ok && entries.length > 0) {
              setScrapePreview(entries);
              setScrapeResult({ text: `Found ${entries.length} entries${data.source === 'gemini_url' ? ' (page read by Gemini)' : data.textLength ? ` from ${data.textLength.toLocaleString()} characters` : ''} — review below`, kind: 'ok' });
          } else {
              setScrapeResult({ text: data.warning || data.error || 'No entries found on that page', kind: data.ok ? 'warn' : 'error' });
          }
      } catch (e) {
          setScrapeResult({ text: 'Scrape failed: ' + (e as Error).message, kind: 'error' });
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
              headers: apiHeaders(),
              body: JSON.stringify({ text: pasteText, apiKey: getApiKey() }),
          });
          const data = await res.json();
          const entries = normalizeEntries(data.entries);
          if (data.ok && entries.length > 0) {
              setPastePreview(entries);
              setPasteResult(`Found ${entries.length} entries — review below${data.warning ? ` (${data.warning})` : ''}`);
          } else {
              setPasteResult(data.warning || data.error || 'No entries found in text');
          }
      } catch (e) {
          setPasteResult('Extraction failed: ' + (e as Error).message);
      }
      setExtracting(false);
  };

  const handleAcceptPastePreview = () => {
      if (pastePreview) {
          const n = addEntries(pastePreview, 'paste');
          setPastePreview(null);
          setPasteResult(`Added ${n} entries to dictionary`);
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
              headers: apiHeaders(),
              body: JSON.stringify({ names, apiKey: getApiKey() }),
          });
          const data = await res.json();
          const entries = normalizeEntries(data.entries);
          if (data.ok && entries.length > 0) {
              setQuickNamesPreview(entries);
              setQuickNamesResult(`Generated ${entries.length} correction rules — review below`);
          } else {
              setQuickNamesResult(data.error || 'Could not generate corrections for these names');
          }
      } catch (e) {
          setQuickNamesResult('Failed: ' + (e as Error).message);
      }
      setQuickNamesProcessing(false);
  };

  const handleAcceptQuickNames = () => {
      if (quickNamesPreview) {
          const n = addEntries(quickNamesPreview, 'names');
          setQuickNamesPreview(null);
          setQuickNamesResult(`Added ${n} entries to dictionary`);
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
      const acronymEntries: PreviewEntry[] = [];
      bodyAcronyms.split(/[\n]+/).forEach(line => {
          const match = line.match(/^\s*([A-Z][A-Z0-9&]{1,})\s*[=\-–:]\s*(.+)/);
          if (match) {
              acronymEntries.push({ original: match[1].toLowerCase(), replacement: match[1], type: 'acronym', note: match[2].trim() });
              acronymEntries.push({ original: match[2].trim().toLowerCase(), replacement: match[2].trim(), type: 'proper_noun', note: `${match[1]} expansion` });
          } else if (line.trim()) {
              allNames.push(line.trim());
          }
      });
      if (allNames.length === 0 && acronymEntries.length === 0) { setBodyProcessing(false); return; }
      try {
          const entries: PreviewEntry[] = [...acronymEntries];
          if (allNames.length > 0) {
              const res = await fetch(`${getRelayUrl()}/api/context/names`, {
                  method: 'POST',
                  headers: apiHeaders(),
                  body: JSON.stringify({ names: allNames, apiKey: getApiKey() }),
              });
              const data = await res.json();
              if (data.ok) entries.push(...normalizeEntries(data.entries));
          }
          if (entries.length > 0) {
              const n = addEntries(entries, 'meeting_body');
              setBodyResult(`Added ${n} entries (${allNames.length} names + ${acronymEntries.length / 2} acronyms)`);
              setBodyName(''); setBodyMembers(''); setBodyAcronyms('');
          } else {
              setBodyResult('No entries generated');
          }
      } catch (e) {
          setBodyResult('Failed: ' + (e as Error).message);
      }
      setBodyProcessing(false);
  };

  const patchJob = (id: string, patch: Partial<IngestJob> | ((j: IngestJob) => Partial<IngestJob>)) =>
      setIngestJobs(prev => prev.map(j => j.id === id ? { ...j, ...(typeof patch === 'function' ? patch(j) : patch) } : j));

  const ingestOne = async (id: string, file: File) => {
      patchJob(id, { status: 'reading', message: `Uploading ${file.name}…` });
      try {
          const formData = new FormData();
          formData.append('file', file);
          const res = await fetch(`${getRelayUrl()}/api/context/upload-stream`, { method: 'POST', headers: apiHeaders(false), body: formData });
          if (!res.ok || !res.body) {
              let msg = `HTTP ${res.status}`;
              try { const j = await res.json(); msg = j.error || msg; } catch {}
              throw new Error(msg);
          }
          let finished = false;
          await readSse(res, (ev) => {
              switch (ev.phase) {
                  case 'parsing': patchJob(id, { status: 'reading', message: ev.message || 'Reading the document…' }); break;
                  case 'parsed': patchJob(id, { kind: ev.kind, pages: ev.pages, chars: ev.chars, words: ev.words, preview: ev.preview, message: `Read ${ev.pages ? `${ev.pages} page${ev.pages === 1 ? '' : 's'}, ` : ''}${(ev.words || 0).toLocaleString()} words` }); break;
                  case 'extracting': patchJob(id, { status: 'extracting', engine: ev.engine, chunk: ev.chunk, chunks: ev.chunks, message: ev.message || 'Extracting names…' }); break;
                  case 'engine_done': patchJob(id, { message: ev.error ? `${ev.engine} failed: ${ev.error}` : `${ev.engine}: ${ev.entries} rules${ev.ms ? ` in ${(ev.ms / 1000).toFixed(1)} s` : ''}` }); break;
                  case 'done': {
                      finished = true;
                      const entries = normalizeEntries(ev.entries);
                      const existingKeys = new Set(dictionary.map(entryKey));
                      const novel = entries.filter(e => !existingKeys.has(entryKey(e)));
                      patchJob(id, {
                          status: 'done', entries: novel, existing: entries.length - novel.length, engine: ev.engine, warning: ev.warning, ms: ev.ms,
                          kind: ev.kind, pages: ev.pages, chars: ev.chars, words: ev.words,
                          selected: new Set(novel.map(entryKey)),
                          message: novel.length ? `${novel.length} new rule${novel.length === 1 ? '' : 's'} found` : entries.length ? 'Everything found is already in the dictionary' : 'No names or terms found',
                      });
                      break;
                  }
                  case 'error': finished = true; patchJob(id, { status: 'error', error: ev.error, message: ev.error }); break;
              }
          });
          if (!finished) patchJob(id, j => j.status === 'done' || j.status === 'error' ? {} : { status: 'error', error: 'The connection closed before the document was processed.', message: 'Connection closed early' });
      } catch (err) {
          patchJob(id, { status: 'error', error: (err as Error).message, message: (err as Error).message });
      }
  };

  const pumpIngestQueue = async () => {
      if (ingestBusyRef.current) return;
      ingestBusyRef.current = true;
      try {
          while (ingestQueueRef.current.length) {
              const next = ingestQueueRef.current.shift()!;
              await ingestOne(next.id, next.file);   // one at a time: the local brain has one GPU
          }
      } finally { ingestBusyRef.current = false; }
  };

  const ingestFiles = (files: File[]) => {
      const accepted = files.filter(f => /\.(pdf|txt|docx|html?|md)$/i.test(f.name));
      if (!accepted.length) return;
      const jobs: IngestJob[] = accepted.map(f => ({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, filename: f.name, bytes: f.size, startedAt: Date.now(), status: 'queued', entries: [], existing: 0, selected: new Set(), message: 'Waiting…' }));
      setIngestJobs(prev => [...jobs, ...prev]);
      ingestQueueRef.current.push(...jobs.map((j, i) => ({ id: j.id, file: accepted[i] })));
      pumpIngestQueue();
  };

  const addSelectedFromJob = (job: IngestJob) => {
      const chosen = job.entries.filter(e => job.selected.has(entryKey(e)));
      const n = addEntries(chosen, 'document');
      patchJob(job.id, { status: 'added', added: n, message: `Added ${n} rule${n === 1 ? '' : 's'} to the dictionary` });
  };

  const removeJob = (id: string) => setIngestJobs(prev => prev.filter(j => j.id !== id));

  const refreshServerKey = useCallback(async () => {
      try {
          const res = await fetch(`${getRelayUrl()}/api/gemini/status`);
          if (res.ok) {
              const data = await res.json();
              setServerKey({ loaded: !!data.loaded, source: data.source || 'none', masked: data.masked || '' });
          }
      } catch {}
  }, []);

  const saveKey = async (key: string) => {
      if (!key || key.length < 10) return;
      localStorage.setItem('cc_api_key', key);
      await fetch(`${getRelayUrl()}/api/polisher/apikey`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key }),
      }).catch(() => {});
      await refreshServerKey();
  };

  useEffect(() => {
      fetch(`${getRelayUrl()}/api/context/status`).then(r => r.json()).then(data => {
          setLearnerEnabled(data.enabled);
      }).catch(() => {});
      fetch(`${getRelayUrl()}/api/context/capabilities`).then(r => r.json()).then(setCapabilities).catch(() => {});

      // Fetch server's view of the active key — this is the source of truth
      refreshServerKey();

      // Sync API key from localStorage to relay server (needed for scraping/extraction)
      const savedKey = localStorage.getItem('cc_api_key');
      if (savedKey && savedKey !== 'PLACEHOLDER_API_KEY') {
          fetch(`${getRelayUrl()}/api/polisher/apikey`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ key: savedKey }),
          }).then(() => refreshServerKey()).catch(() => {});
      }

      // Poll suggestions + learner status every 5 seconds
      const interval = setInterval(() => {
          fetch(`${getRelayUrl()}/api/context/suggestions`).then(r => r.json()).then(d => Array.isArray(d) && setSuggestions(d)).catch(() => {});
          fetch(`${getRelayUrl()}/api/context/status`).then(r => r.json()).then(data => {
              if (data.bufferLength !== undefined) setLearnerStatus(data);
          }).catch(() => {});
      }, 5000);
      return () => clearInterval(interval);
  }, [refreshServerKey]);

  // Wizard elapsed-time ticker
  useEffect(() => {
      if (wizardState !== 'running') return;
      const t = setInterval(() => setWizardElapsed(Date.now() - wizardStartedAt), 250);
      return () => clearInterval(t);
  }, [wizardState, wizardStartedAt]);

  useEffect(() => () => { wizardAbortRef.current?.abort(); }, []);

  const handleActivate = () => {
      if (!engineName.trim()) {
          setShowNameError(true);
          return;
      }
      setActiveContextName(engineName);
      onClose();
  };

  // ---------------------------------------------------------------------
  // Profiles
  // ---------------------------------------------------------------------
  const refreshProfiles = useCallback(async () => {
      try {
          const res = await fetch(`${getRelayUrl()}/api/context/profiles`);
          const data = await res.json();
          if (data.ok && Array.isArray(data.profiles)) setProfiles(data.profiles);
      } catch {}
  }, []);

  useEffect(() => { if (showProfiles) refreshProfiles(); }, [showProfiles, refreshProfiles]);

  const handleSaveProfile = async () => {
      const name = engineName.trim();
      if (!name) { setShowNameError(true); setProfilesMsg({ text: 'Give the engine a name first (top of the window).', kind: 'error' }); return; }
      setProfilesBusy(true);
      setProfilesMsg(null);
      try {
          const res = await fetch(`${getRelayUrl()}/api/context/profiles`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name, entries: dictionary, municipality: searchQuery.trim() || undefined }),
          });
          const data = await res.json();
          if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);
          setActiveContextName(name);
          setProfilesMsg({ text: `Saved "${name}" (${data.profile?.entryCount ?? dictionary.length} rules) on the relay`, kind: 'ok' });
          refreshProfiles();
      } catch (e) {
          setProfilesMsg({ text: 'Save failed: ' + (e as Error).message, kind: 'error' });
      }
      setProfilesBusy(false);
  };

  const handleLoadProfile = async (id: string, mode: 'replace' | 'merge') => {
      setProfilesBusy(true);
      setProfilesMsg(null);
      try {
          const res = await fetch(`${getRelayUrl()}/api/context/profiles/${encodeURIComponent(id)}`);
          const data = await res.json();
          if (!data.ok || !data.profile) throw new Error(data.error || `HTTP ${res.status}`);
          const entries = normalizeEntries(data.profile.entries);
          if (mode === 'replace') {
              setDictionary(entries.map(e => ({ ...e, source: e.source || 'profile' })) as DictionaryEntry[]);
              setProfilesMsg({ text: `Loaded "${data.profile.name}" — ${entries.length} rules`, kind: 'ok' });
          } else {
              const n = addEntries(entries, 'profile');
              setProfilesMsg({ text: `Merged "${data.profile.name}" — ${n} new rules added`, kind: 'ok' });
          }
          setEngineName(data.profile.name);
          setActiveContextName(data.profile.name);
          if (data.profile.municipality && !searchQuery) setSearchQuery(data.profile.municipality);
      } catch (e) {
          setProfilesMsg({ text: 'Load failed: ' + (e as Error).message, kind: 'error' });
      }
      setProfilesBusy(false);
  };

  const handleDeleteProfile = async (p: ProfileSummary) => {
      if (!confirm(`Delete the profile "${p.name}" from the relay? The rules currently loaded stay as they are.`)) return;
      try {
          await fetch(`${getRelayUrl()}/api/context/profiles/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
          setProfilesMsg({ text: `Deleted "${p.name}"`, kind: 'ok' });
          refreshProfiles();
      } catch (e) {
          setProfilesMsg({ text: 'Delete failed: ' + (e as Error).message, kind: 'error' });
      }
  };

  // ---------------------------------------------------------------------
  // Municipality Wizard
  // ---------------------------------------------------------------------

  const resetWizard = () => {
      wizardAbortRef.current?.abort();
      setWizardState('idle');
      setWizardStatusLine('');
      setWizardGroups([]);
      setWizardSelected(new Set());
      setWizardCollapsed(new Set());
      setWizardSources([]);
      setWizardHost(null);
      setWizardNote(null);
      setWizardError(null);
      setWizardAdded(null);
      setShowSources(false);
      setLocateStatus('pending');
      setSelectedSources([]);
      setScanLive([]);
      setScanExtracted([]);
      setScanRecent([]);
      setScanRunning(false);
  };

  const handleWizardResearch = async () => {
      const q = searchQuery.trim();
      if (!q) return;
      if (!hasUsableKey() && !brainOn) { setShowInlineKeyForm(true); return; }
      if (tempKey && tempKey !== getApiKey() && tempKey.length > 10) await saveKey(tempKey);

      resetWizard();
      const controller = new AbortController();
      wizardAbortRef.current = controller;
      const startedAt = Date.now();
      setWizardStartedAt(startedAt);
      setWizardElapsed(0);
      setWizardState('running');
      setLocateStatus('running');
      setWizardStatusLine('Starting research…');

      let sawDone = false;
      try {
          const res = await fetch(`${getRelayUrl()}/api/context/wizard/research`, {
              method: 'POST',
              headers: { ...apiHeaders(), 'Accept': 'text/event-stream' },
              body: JSON.stringify({ query: q, apiKey: getApiKey(), domainHint: settings.dialect !== 'general' ? settings.dialect : '' }),
              signal: controller.signal,
          });
          if (!res.ok) {
              let msg = `HTTP ${res.status}`;
              try { const j = await res.json(); msg = j.error || msg; } catch {}
              throw new Error(msg);
          }
          await readSse(res, (ev) => {
              switch (ev.phase) {
                  case 'status':
                      if (ev.message) setWizardStatusLine(ev.message);
                      break;
                  case 'sources': {
                      const list: WizardSource[] = Array.isArray(ev.sources) ? ev.sources : [];
                      setWizardSources(list);
                      setWizardHost(ev.officialHost || null);
                      setWizardNote(ev.crawlNote || ev.error || null);
                      setLocateStatus(ev.error && list.length === 0 ? 'failed' : 'done');
                      setSelectedSources(list.map((_, i) => i).filter(i => list[i].type !== 'General').slice(0, 8));
                      break;
                  }
                  case 'research_start':
                      setWizardGroups((ev.groups || []).map((g: any) => ({ key: g.key, label: g.label, status: 'running' as const, items: [] })));
                      break;
                  case 'group': {
                      const items: WizardItem[] = (ev.items || []).map((it: any, i: number) => ({
                          id: `${ev.key}:${i}`,
                          name: it.name,
                          category: it.category,
                          detail: it.detail || '',
                          misheard: it.misheard || [],
                          entries: normalizeEntries(it.entries),
                          group: ev.key,
                      })).filter((it: WizardItem) => it.entries.length > 0);
                      setWizardGroups(prev => prev.map(g => g.key === ev.key ? { ...g, status: ev.ok ? 'done' : 'failed', items, error: ev.error, elapsedMs: ev.elapsedMs } : g));
                      setWizardSelected(prev => { const n = new Set(prev); items.forEach(it => n.add(it.id)); return n; });
                      break;
                  }
                  case 'done':
                      sawDone = true;
                      setWizardStatusLine(`Done in ${((ev.totalMs || (Date.now() - startedAt)) / 1000).toFixed(0)}s`);
                      break;
                  case 'error':
                      setWizardError(ev.error || 'Research failed');
                      break;
              }
          });
          setWizardGroups(prev => prev.map(g => g.status === 'running' ? { ...g, status: 'failed', error: g.error || 'No response' } : g));
          setLocateStatus(s => s === 'running' ? 'failed' : s);
          setWizardState(prev => prev === 'running' ? 'done' : prev);
          if (!sawDone) setWizardStatusLine(`Finished in ${((Date.now() - startedAt) / 1000).toFixed(0)}s`);
      } catch (e) {
          if ((e as Error).name === 'AbortError') return;
          setWizardError((e as Error).message);
          setWizardState('error');
          setLocateStatus('failed');
          setWizardGroups(prev => prev.map(g => g.status === 'running' ? { ...g, status: 'failed' } : g));
      }
  };

  const wizardItems = useMemo(() => wizardGroups.flatMap(g => g.items), [wizardGroups]);
  const wizardSelectedItems = useMemo(() => wizardItems.filter(it => wizardSelected.has(it.id)), [wizardItems, wizardSelected]);
  const wizardSelectedEntryCount = useMemo(() => wizardSelectedItems.reduce((n, it) => n + it.entries.length, 0), [wizardSelectedItems]);
  const wizardTotalEntries = useMemo(() => wizardItems.reduce((n, it) => n + it.entries.length, 0), [wizardItems]);

  const toggleWizardItem = (id: string) => setWizardSelected(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const setGroupSelected = (key: string, on: boolean) => setWizardSelected(prev => {
      const n = new Set(prev);
      wizardGroups.find(g => g.key === key)?.items.forEach(it => on ? n.add(it.id) : n.delete(it.id));
      return n;
  });

  const handleWizardAdd = () => {
      const entries = wizardSelectedItems.flatMap(it => it.entries);
      const n = addEntries(entries, 'wizard');
      setWizardAdded(n);
      if (!engineName.trim() && searchQuery.trim()) setEngineName(searchQuery.trim());
  };

  // --- Deep scan of discovered pages (3 at a time) ---
  const streamScrape = (
    url: string,
    onPhase: (phase: ScanPhase, detail: string, extra?: any) => void,
    onEntries: (batch: PreviewEntry[]) => void,
  ): Promise<{ entries: PreviewEntry[]; ok: boolean; error?: string }> => {
    return new Promise(async (resolve) => {
        const collected: PreviewEntry[] = [];
        try {
            const res = await fetch(`${getRelayUrl()}/api/context/scrape-stream`, {
                method: 'POST',
                headers: { ...apiHeaders(), 'Accept': 'text/event-stream' },
                body: JSON.stringify({ url, apiKey: getApiKey() }),
            });
            if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
            let finished = false;
            await readSse(res, (ev) => {
                switch (ev.phase) {
                    case 'fetching': onPhase('fetching', 'Connecting…'); break;
                    case 'fetched': onPhase('fetched', `Server responded (${ev.contentType?.split(';')[0] || 'unknown'})`); break;
                    case 'parsing': onPhase('parsing', ev.sourceType === 'pdf' ? `Parsing PDF (${Math.round((ev.bytes || 0) / 1024)} KB)` : `Reading page (${Math.round((ev.bytes || 0) / 1024)} KB)`); break;
                    case 'parsed': onPhase('parsed', `${(ev.textLength || 0).toLocaleString()} characters of text`); break;
                    case 'ai_fetch': onPhase('ai_fetch', ev.message || 'Asking Gemini to read the page…'); break;
                    case 'extracting': onPhase('extracting', 'Finding names, places and acronyms…'); break;
                    case 'entries':
                        if (Array.isArray(ev.batch)) { const b = normalizeEntries(ev.batch); collected.push(...b); onEntries(b); onPhase('extracting', `${collected.length} entries so far…`); }
                        break;
                    case 'done':
                        finished = true;
                        onPhase('done', ev.warning ? ev.warning : `Done in ${((ev.totalMs || 0) / 1000).toFixed(1)}s — ${ev.totalEntries ?? collected.length} entries`);
                        resolve({ entries: collected, ok: true });
                        break;
                    case 'error':
                        finished = true;
                        onPhase('failed', ev.error || 'Failed', { error: ev.error });
                        resolve({ entries: collected, ok: false, error: ev.error });
                        break;
                }
            });
            if (!finished) resolve({ entries: collected, ok: true });
        } catch (e) {
            onPhase('failed', (e as Error).message);
            resolve({ entries: [], ok: false, error: (e as Error).message });
        }
    });
  };

  const handleDeepScan = async () => {
    const selectedData = wizardSources.filter((_, i) => selectedSources.includes(i));
    if (selectedData.length === 0) return;
    setScanRunning(true);
    setScanExtracted([]);
    setScanRecent([]);
    setScanLive(selectedData.map(d => ({ url: d.url, phase: 'queued' as ScanPhase, detail: 'Queued', entries: 0, startedAt: 0, elapsedMs: 0 })));

    const existingKeys = new Set(dictionary.map(entryKey));
    const ticker = setInterval(() => {
        setScanLive(prev => prev.map(p => (p.startedAt && p.phase !== 'done' && p.phase !== 'failed') ? { ...p, elapsedMs: Date.now() - p.startedAt } : p));
    }, 250);

    let next = 0;
    const worker = async () => {
        while (next < selectedData.length) {
            const i = next++;
            const startedAt = Date.now();
            setScanLive(prev => prev.map((p, j) => j === i ? { ...p, phase: 'fetching', detail: 'Starting…', startedAt } : p));
            const result = await streamScrape(
                selectedData[i].url,
                (phase, detail, extra) => setScanLive(prev => prev.map((p, j) => j === i ? { ...p, phase, detail, error: extra?.error, elapsedMs: Date.now() - startedAt } : p)),
                (batch) => {
                    const novel = batch.filter(e => { const k = entryKey(e); if (existingKeys.has(k)) return false; existingKeys.add(k); return true; });
                    if (novel.length > 0) {
                        setScanExtracted(prev => [...prev, ...novel]);
                        setScanRecent(prev => [...novel.slice(-12), ...prev].slice(0, 30));
                        setScanLive(prev => prev.map((p, j) => j === i ? { ...p, entries: p.entries + novel.length } : p));
                    }
                },
            );
            setScanLive(prev => prev.map((p, j) => j === i ? { ...p, phase: result.ok ? 'done' : 'failed', elapsedMs: Date.now() - startedAt, error: result.error } : p));
        }
    };
    await Promise.all(Array.from({ length: Math.min(3, selectedData.length) }, worker));
    clearInterval(ticker);
    setScanRunning(false);
  };

  const handleScanAccept = () => {
      const n = addEntries(scanExtracted, 'url');
      setScanExtracted([]);
      setScanLive([]);
      setScanRecent([]);
      setWizardAdded(prev => (prev || 0) + n);
  };

  // ---------------------------------------------------------------------
  // Drag & drop, manual entry, import/export
  // ---------------------------------------------------------------------
  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") setDragActive(true);
    else if (e.type === "dragleave") setDragActive(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length) ingestFiles(files);
  }, [ingestFiles]);

  const addManualEntry = () => {
    if (manualOriginal && manualReplacement) {
        addEntries([{ original: manualOriginal.trim(), replacement: manualReplacement.trim(), type: 'correction' }], 'manual');
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
              const list = Array.isArray(imported) ? imported : Array.isArray(imported?.entries) ? imported.entries : null;
              if (list) addEntries(normalizeEntries(list), 'import');
          } catch(err) { console.error("Invalid JSON"); }
      };
      reader.readAsText(file);
      e.target.value = '';
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

  // Tailwind only generates classes it can see literally, so accents are looked up, not templated.
  const ACCENTS: Record<string, { box: string; title: string; button: string }> = {
      sage: { box: 'bg-sage-50 border-sage-200', title: 'text-sage-700', button: 'bg-sage-500 hover:bg-sage-600' },
      purple: { box: 'bg-purple-50 border-purple-200', title: 'text-purple-700', button: 'bg-purple-500 hover:bg-purple-600' },
  };
  const PreviewList: React.FC<{ entries: PreviewEntry[]; accent: 'sage' | 'purple'; onAccept: () => void; onDiscard: () => void; title: string }> = ({ entries, accent, onAccept, onDiscard, title }) => (
      <div className={`rounded-lg border p-3 space-y-2 ${ACCENTS[accent].box}`}>
          <p className={`text-[9px] font-bold uppercase ${ACCENTS[accent].title}`}>{title}</p>
          <div className="max-h-40 overflow-y-auto space-y-1 custom-scrollbar">
              {entries.map((e, i) => (
                  <div key={i} className="flex items-center gap-2 text-[10px] min-w-0">
                      <span className="text-red-400 line-through truncate">{e.original}</span>
                      <ArrowRight size={8} className="text-stone-300 shrink-0" />
                      <span className="font-bold text-forest-dark truncate">{e.replacement}</span>
                      {e.note && <span className="text-stone-400 truncate hidden sm:inline">· {e.note}</span>}
                      <span className={`ml-auto text-[8px] px-1 py-0.5 rounded shrink-0 ${e.type === 'acronym' ? 'bg-purple-100 text-purple-600' : e.type === 'place' ? 'bg-green-100 text-green-600' : 'bg-blue-100 text-blue-600'}`}>{(e.type || 'proper_noun').replace('_', ' ')}</span>
                  </div>
              ))}
          </div>
          <div className="flex gap-2 pt-1">
              <button onClick={onAccept} className={`flex-1 px-3 py-1.5 text-white text-[10px] font-bold rounded-lg ${ACCENTS[accent].button}`}>Add All to Dictionary</button>
              <button onClick={onDiscard} className="px-3 py-1.5 bg-white border border-stone-200 text-[10px] font-bold rounded-lg text-stone-500 hover:bg-stone-50">Discard</button>
          </div>
      </div>
  );

  const StatusIcon = ({ status }: { status: 'pending' | 'running' | 'done' | 'failed' }) => (
      status === 'pending' ? <div className="w-3.5 h-3.5 rounded-full border-2 border-stone-200 shrink-0" />
      : status === 'running' ? <Loader2 size={14} className="animate-spin text-sage-600 shrink-0" />
      : status === 'done' ? <CheckCircle size={14} className="text-green-600 shrink-0" />
      : <X size={14} className="text-red-500 shrink-0" />
  );

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
                        <span className="bg-sage-100 text-forest-dark px-1.5 py-0.5 rounded">v6</span>
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

            <div className="flex items-center gap-2 relative">
                 <button onClick={() => setShowProfiles(s => !s)} className={`flex items-center gap-2 px-4 py-2 rounded-lg font-bold text-sm border transition-all ${showProfiles ? 'bg-sage-100 border-sage-400 text-forest-dark' : 'bg-white border-stone-200 text-stone-600 hover:bg-stone-50'}`} title="Save or load a named profile stored on the relay">
                    <FolderOpen size={16} /> Profiles
                 </button>
                 <button onClick={handleActivate} className="flex items-center gap-2 px-6 py-2 bg-forest-dark text-white rounded-lg font-bold hover:bg-forest-light transition-all shadow-md">
                    <CheckCircle size={18} /> Activate & Close
                 </button>
                 <button onClick={onClose} className="p-2 hover:bg-stone-100 rounded-full transition-colors">
                    <X size={24} className="text-stone-400 hover:text-forest-dark" />
                 </button>

                 {showProfiles && (
                    <div className="absolute right-0 top-full mt-2 w-[420px] bg-white border border-stone-200 rounded-2xl shadow-2xl z-30 p-4 space-y-3 animate-fade-in">
                        <div className="flex items-center justify-between">
                            <div>
                                <p className="text-sm font-bold text-forest-dark">Named profiles</p>
                                <p className="text-[10px] text-stone-400">Stored on the relay server, shared by every operator machine</p>
                            </div>
                            <button onClick={handleSaveProfile} disabled={profilesBusy || dictionary.length === 0}
                                className="flex items-center gap-1.5 px-3 py-1.5 bg-forest-dark text-white rounded-lg text-xs font-bold hover:bg-forest-light disabled:opacity-40"
                                title={engineName.trim() ? `Save the current ${dictionary.length} rules as "${engineName.trim()}"` : 'Name the engine first'}>
                                {profilesBusy ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} Save as "{engineName.trim() || 'unnamed'}"
                            </button>
                        </div>
                        {profilesMsg && (
                            <p className={`text-[11px] font-medium ${profilesMsg.kind === 'ok' ? 'text-green-700' : 'text-red-600'}`}>{profilesMsg.text}</p>
                        )}
                        <div className="max-h-64 overflow-y-auto space-y-1.5 custom-scrollbar">
                            {profiles.length === 0 ? (
                                <p className="text-xs text-stone-400 text-center py-4">No profiles yet. Build a dictionary, name it, and press Save.</p>
                            ) : profiles.map(p => (
                                <div key={p.id} className="flex items-center gap-2 p-2 rounded-lg border border-stone-100 hover:border-sage-300 bg-stone-50/60">
                                    <div className="flex-1 min-w-0">
                                        <p className="text-xs font-bold text-forest-dark truncate">{p.name}</p>
                                        <p className="text-[10px] text-stone-400 truncate">{p.entryCount} rules · {new Date(p.updatedAt).toLocaleDateString()}{p.municipality ? ` · ${p.municipality}` : ''}</p>
                                    </div>
                                    <button onClick={() => handleLoadProfile(p.id, 'replace')} disabled={profilesBusy} className="px-2 py-1 rounded bg-forest-dark text-white text-[10px] font-bold hover:bg-forest-light disabled:opacity-40" title="Replace the current rules with this profile">Load</button>
                                    <button onClick={() => handleLoadProfile(p.id, 'merge')} disabled={profilesBusy} className="px-2 py-1 rounded bg-sage-100 text-forest-dark text-[10px] font-bold hover:bg-sage-200 disabled:opacity-40" title="Add this profile's rules to the current ones">Merge</button>
                                    <button onClick={() => handleDeleteProfile(p)} disabled={profilesBusy} className="p-1 text-stone-300 hover:text-red-500" title="Delete profile"><Trash2 size={14} /></button>
                                </div>
                            ))}
                        </div>
                    </div>
                 )}
            </div>
        </div>

        {/* Main Content Area */}
        <div className="flex-1 flex overflow-hidden">

            {/* Left Panel: Tabs */}
            <div className="w-[38%] min-w-[380px] bg-white border-r border-stone-200 flex flex-col overflow-y-auto">
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
                                {hasUsableKey() ? (
                                    <span className="ml-auto text-[9px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full font-bold">Connected{serverKey?.masked ? ` · ${serverKey.masked}` : ''}</span>
                                ) : (
                                    <span className="ml-auto text-[9px] bg-red-100 text-red-600 px-1.5 py-0.5 rounded-full font-bold">Not Set</span>
                                )}
                            </div>
                            <p className="text-[10px] text-stone-500 mb-2">Required for the Municipality Wizard, Auto-Learn, AI extraction from PDFs/URLs, and Summarize caption mode.</p>
                            <div className="flex gap-2">
                                <input
                                    type="password"
                                    value={tempKey}
                                    onChange={e => setTempKey(e.target.value)}
                                    placeholder="AIzaSy..."
                                    className="flex-1 px-2 py-1.5 rounded-lg border border-stone-200 text-xs focus:outline-none focus:border-amber-400 bg-white"
                                />
                                <button onClick={() => saveKey(tempKey)} className="px-3 py-1.5 bg-amber-600 text-white text-xs font-bold rounded-lg hover:bg-amber-700">Save</button>
                            </div>
                            <p className="text-[9px] text-stone-400 mt-1.5">Get a free key at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener" className="underline text-amber-600">aistudio.google.com/apikey</a>{capabilities?.model ? ` · model: ${capabilities.model}` : ''}</p>
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
                                    setLearningEnabled(newVal);
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
                                            <p>Learned words appear under <strong>AI Suggestions</strong> in the Active Rules panel and as toasts on the Dashboard.</p>
                                            <p>Requires a Gemini API key and an active captioning session.</p>
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

                        {/* Correction Sensitivity + live test */}
                        <div className="bg-white p-4 rounded-xl border border-stone-200 space-y-3">
                            <div>
                                <h4 className="font-bold text-xs text-stone-700 mb-1">Correction Sensitivity</h4>
                                <p className="text-[9px] text-stone-400 mb-2">Exact matches always apply. Higher settings also fix words that merely <em>sound like</em> a rule (phonetic matching), so "Perlman" becomes "Pearlman" without a rule for every misspelling.</p>
                                <div className="flex items-center gap-3">
                                    <span className="text-[10px] font-bold text-stone-400 w-8">Exact</span>
                                    <input
                                        type="range" min="0" max="100"
                                        value={settings.sensitivity}
                                        onChange={(e) => setSettings({...settings, sensitivity: Number(e.target.value)})}
                                        className="flex-1 accent-forest-dark"
                                    />
                                    <span className="text-[10px] font-bold text-stone-400 w-10">Sounds-like</span>
                                    <span className="text-[10px] font-mono bg-stone-100 px-1.5 py-0.5 rounded">{settings.sensitivity}%</span>
                                </div>
                                <p className="text-[9px] text-sage-700 mt-1 font-medium">
                                    {settings.sensitivity < 30 ? 'Exact matches only.' : settings.sensitivity < 70 ? 'Exact + sounds-like for multi-word names (e.g. "bernard grene").' : 'Exact + sounds-like for multi-word names and single names (never common words).'}
                                </p>
                            </div>
                            <div>
                                <label className="text-[9px] font-bold text-stone-400 uppercase mb-1 flex items-center gap-1"><Wand2 size={10} /> Try a sentence</label>
                                <input
                                    value={testSentence}
                                    onChange={e => setTestSentence(e.target.value)}
                                    placeholder="e.g. chair david perlman recognized bernard green"
                                    className="w-full px-3 py-2 rounded-lg border border-stone-200 text-xs focus:outline-none focus:border-sage-500"
                                />
                                {testResult && (
                                    <div className="mt-2 text-[11px]">
                                        <p className="text-forest-dark font-medium">{testResult.text}</p>
                                        {testResult.applied.length > 0 ? (
                                            <p className="text-[10px] text-stone-500 mt-1">{testResult.applied.map((a: any) => `${a.matched} → ${a.replacement}${a.mode === 'phonetic' ? ' (sounds-like)' : ''}`).join(' · ')}</p>
                                        ) : (
                                            <p className="text-[10px] text-stone-400 mt-1">No rule matched{dictionary.length === 0 ? ' — the dictionary is empty' : ''}.</p>
                                        )}
                                    </div>
                                )}
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
                                onChange={e => setSettings({...settings, dialect: e.target.value as any})}
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
                                    <p><strong>Run the Municipality Wizard:</strong> type your town (e.g. "Brookline, MA"). It researches current officials, boards, departments, places and acronyms with Google Search and builds correction rules in under a minute.</p>
                                </div>
                                <div className="flex gap-2">
                                    <span className="bg-forest-dark text-white w-4 h-4 rounded-full flex items-center justify-center text-[8px] font-bold shrink-0 mt-0.5">2</span>
                                    <p><strong>Add tonight's agenda:</strong> drop the agenda PDF (or paste its text). Names of applicants, streets and projects specific to this meeting get added.</p>
                                </div>
                                <div className="flex gap-2">
                                    <span className="bg-forest-dark text-white w-4 h-4 rounded-full flex items-center justify-center text-[8px] font-bold shrink-0 mt-0.5">3</span>
                                    <p><strong>Review the Active Rules:</strong> remove anything that looks wrong. Add manual corrections for words you know the speech engine gets wrong.</p>
                                </div>
                                <div className="flex gap-2">
                                    <span className="bg-forest-dark text-white w-4 h-4 rounded-full flex items-center justify-center text-[8px] font-bold shrink-0 mt-0.5">4</span>
                                    <p><strong>Turn on Auto-Learn:</strong> during the broadcast the AI watches live captions and suggests new names it hasn't seen before.</p>
                                </div>
                                <div className="flex gap-2">
                                    <span className="bg-forest-dark text-white w-4 h-4 rounded-full flex items-center justify-center text-[8px] font-bold shrink-0 mt-0.5">5</span>
                                    <p><strong>Name & Export:</strong> the dictionary is saved in this browser automatically. Export to JSON to move it to another machine or share it.</p>
                                </div>
                            </div>
                        </div>

                        {/* Tips */}
                        <div className="bg-sage-50 rounded-xl border border-sage-200 p-3 space-y-1.5">
                            <h4 className="font-bold text-xs text-sage-700">Tips for Best Results</h4>
                            <ul className="text-[10px] text-stone-600 space-y-1 list-disc list-inside">
                                <li>Include the state in the wizard search ("Newton, MA" not just "Newton")</li>
                                <li>Upload the agenda <strong>before</strong> the meeting starts for immediate corrections</li>
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
                ) : (
                    <div className="p-6 space-y-6 animate-fade-in overflow-y-auto custom-scrollbar">

                        {/* === API KEY STATUS BANNER === */}
                        <div className={`rounded-2xl border-2 p-4 transition-all ${
                            hasUsableKey() || brainOn
                                ? 'bg-green-50 border-green-200'
                                : 'bg-amber-50 border-amber-300 shadow-lg shadow-amber-100'
                        }`}>
                            <div className="flex items-center gap-3">
                                <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${hasUsableKey() || brainOn ? 'bg-green-500 text-white' : 'bg-amber-500 text-white animate-pulse'}`}>
                                    <Key size={20} />
                                </div>
                                <div className="flex-1 min-w-0">
                                    {brainOn ? (
                                        <>
                                            <div className="flex items-center gap-2">
                                                <p className="text-sm font-bold text-green-800">Local AI brain is active</p>
                                                <span className="text-[9px] bg-green-200 text-green-800 px-1.5 py-0.5 rounded font-bold uppercase font-mono">{capabilities?.brain?.model}</span>
                                            </div>
                                            <p className="text-[11px] text-green-700 mt-0.5">
                                                The Municipality Wizard, agenda uploads, pasted text, URL scrapes, Auto-Learn and audience translation all run through Ollama on this machine. Nothing leaves this computer.
                                            </p>
                                        </>
                                    ) : hasUsableKey() ? (
                                        <>
                                            <div className="flex items-center gap-2">
                                                <p className="text-sm font-bold text-green-800">Gemini AI is Connected</p>
                                                <span className="text-[9px] bg-green-200 text-green-800 px-1.5 py-0.5 rounded font-bold uppercase">
                                                    {serverKey?.source === 'env_local' ? '.env.local' :
                                                     serverKey?.source === 'env' ? 'env var' :
                                                     serverKey?.source === 'runtime' ? 'user set' :
                                                     serverKey?.source === 'builtin' ? 'built-in' :
                                                     'browser'}
                                                </span>
                                            </div>
                                            <p className="text-[11px] text-green-700 mt-0.5">
                                                Municipality Wizard, PDF extraction, and Auto-Learn are ready.
                                                {serverKey?.masked && ` Key: ${serverKey.masked}`}
                                            </p>
                                        </>
                                    ) : (
                                        <>
                                            <p className="text-sm font-bold text-amber-900">Pick an AI engine to continue</p>
                                            <p className="text-[11px] text-amber-800 mt-0.5">
                                                The Municipality Wizard, PDF extraction, Auto-Learn and translation need either the <strong>local AI brain</strong> (workflow picker → Connect Local AI, runs on this computer) or a free Gemini key.{' '}
                                                <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener" className="underline font-bold">Get a key →</a>
                                            </p>
                                        </>
                                    )}
                                </div>
                                {!hasUsableKey() ? (
                                    <button
                                        onClick={() => setShowInlineKeyForm(s => !s)}
                                        className="px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold rounded-lg shrink-0"
                                    >
                                        Add Key
                                    </button>
                                ) : (
                                    <button
                                        onClick={() => setShowInlineKeyForm(s => !s)}
                                        className="text-[10px] font-bold text-green-700 hover:text-green-900 underline shrink-0"
                                    >
                                        {showInlineKeyForm ? 'Hide' : 'Change'}
                                    </button>
                                )}
                            </div>
                            {showInlineKeyForm && (
                                <div className="mt-3 flex gap-2">
                                    <input
                                        type="password"
                                        value={tempKey}
                                        onChange={e => setTempKey(e.target.value)}
                                        placeholder="Paste your Gemini API key (starts with AIzaSy…)"
                                        className="flex-1 px-3 py-2 rounded-lg border border-amber-300 text-xs focus:outline-none focus:border-amber-500 bg-white font-mono"
                                    />
                                    <button
                                        onClick={async () => { await saveKey(tempKey); setShowInlineKeyForm(false); }}
                                        disabled={!tempKey || tempKey.length < 10}
                                        className="px-4 py-2 bg-forest-dark text-white text-xs font-bold rounded-lg disabled:opacity-40"
                                    >
                                        Save
                                    </button>
                                </div>
                            )}
                        </div>

                        {/* === MUNICIPALITY WIZARD === */}
                        <div className={`bg-gradient-to-br from-forest-dark to-forest-light rounded-2xl shadow-xl relative overflow-hidden ${!(hasUsableKey() || brainOn) ? 'opacity-60' : ''}`}>
                            <div className="absolute top-0 right-0 w-32 h-32 bg-white/10 rounded-full -translate-y-1/2 translate-x-1/2 blur-2xl"></div>
                            <div className="p-5 relative z-10">
                                <div className="flex items-center gap-3 mb-3">
                                    <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center text-white">
                                        <Globe size={22} />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2">
                                            <h4 className="font-bold text-base text-white">Municipality Wizard</h4>
                                            {!(hasUsableKey() || brainOn) && (
                                                <span className="text-[9px] bg-amber-400 text-amber-900 px-1.5 py-0.5 rounded font-bold uppercase">Needs an AI engine</span>
                                            )}
                                            {brainOn && (
                                                <span className="text-[9px] bg-white/20 text-white px-1.5 py-0.5 rounded font-bold uppercase font-mono">{capabilities?.brain?.model}</span>
                                            )}
                                        </div>
                                        <p className="text-sage-100 text-[10px] opacity-80">{brainOn ? 'Searches the web and reads the official pages with your local AI: officials, boards, departments, places and acronyms → correction rules' : 'Researches your town with Google Search: officials, boards, departments, places and acronyms → correction rules'}</p>
                                    </div>
                                    {wizardState !== 'idle' && (
                                        <button onClick={resetWizard} title="Start over" className="text-white/70 hover:text-white p-1.5 rounded-lg hover:bg-white/10"><RotateCcw size={14} /></button>
                                    )}
                                </div>

                                <div className="flex gap-2">
                                    <input
                                        value={searchQuery}
                                        onChange={e => setSearchQuery(e.target.value)}
                                        onKeyDown={e => e.key === 'Enter' && wizardState !== 'running' && searchQuery.trim() && (hasUsableKey() || brainOn) && handleWizardResearch()}
                                        placeholder={(hasUsableKey() || brainOn) ? "e.g. Brookline, MA" : "Add an API key above (or set up the local AI brain) to enable the wizard"}
                                        className="flex-1 px-4 py-2.5 rounded-xl text-sm bg-white/95 text-forest-dark placeholder:text-stone-400 outline-none focus:ring-2 focus:ring-white/50 disabled:bg-white/60"
                                        disabled={wizardState === 'running' || !(hasUsableKey() || brainOn)}
                                    />
                                    <button
                                        onClick={handleWizardResearch}
                                        disabled={wizardState === 'running' || !searchQuery.trim() || !(hasUsableKey() || brainOn)}
                                        className="px-4 py-2.5 bg-white text-forest-dark rounded-xl font-bold text-sm hover:bg-sage-50 transition-colors disabled:opacity-50 flex items-center gap-1.5"
                                    >
                                        {wizardState === 'running' ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
                                        {wizardState === 'running' ? `${(wizardElapsed / 1000).toFixed(0)}s` : 'Research'}
                                    </button>
                                </div>
                                {wizardState === 'running' && wizardStatusLine && (
                                    <p className="text-[11px] text-white mt-2 flex items-center gap-2 bg-white/10 px-2.5 py-1.5 rounded-lg">
                                        <Loader2 size={11} className="animate-spin shrink-0" />
                                        <span className="font-medium truncate">{wizardStatusLine}</span>
                                    </p>
                                )}
                            </div>

                            {wizardState !== 'idle' && (
                                <div className="bg-white rounded-b-2xl border-t border-stone-200">
                                    {/* Steps */}
                                    <div className="p-4 space-y-1.5">
                                        <div className="flex items-center gap-2 text-[11px]">
                                            <StatusIcon status={locateStatus} />
                                            <span className="font-bold text-forest-dark">Official website</span>
                                            <span className="text-stone-500 truncate">
                                                {locateStatus === 'running' ? 'Searching…' : wizardHost ? wizardHost : locateStatus === 'failed' ? 'Not found' : ''}
                                            </span>
                                            {wizardSources.length > 0 && (
                                                <button onClick={() => setShowSources(s => !s)} className="ml-auto text-[10px] font-bold text-sage-700 hover:text-sage-900 flex items-center gap-1 shrink-0">
                                                    {showSources ? <ChevronDown size={12} /> : <ChevronRight size={12} />} {wizardSources.length} pages
                                                </button>
                                            )}
                                        </div>
                                        {wizardGroups.map(g => {
                                            const Icon = GROUP_ICONS[g.key] || Sparkles;
                                            const sel = g.items.filter(it => wizardSelected.has(it.id)).length;
                                            return (
                                                <div key={g.key} className="flex items-center gap-2 text-[11px]">
                                                    <StatusIcon status={g.status} />
                                                    <Icon size={12} className="text-stone-400 shrink-0" />
                                                    <span className="font-bold text-forest-dark">{g.label}</span>
                                                    <span className="text-stone-500 truncate">
                                                        {g.status === 'running' ? 'Researching…' : g.status === 'failed' ? (g.error || 'Failed') : `${g.items.length} found`}
                                                    </span>
                                                    {g.status === 'done' && g.items.length > 0 && (
                                                        <span className="ml-auto text-[10px] font-mono text-stone-400 shrink-0">{sel}/{g.items.length} selected · {((g.elapsedMs || 0) / 1000).toFixed(0)}s</span>
                                                    )}
                                                </div>
                                            );
                                        })}
                                        {wizardError && (
                                            <div className="flex items-start gap-2 text-[11px] text-red-700 bg-red-50 border border-red-200 rounded-lg p-2 mt-1">
                                                <AlertTriangle size={13} className="shrink-0 mt-0.5" />
                                                <span>{wizardError}</span>
                                            </div>
                                        )}
                                        {wizardNote && !wizardError && (
                                            <p className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1 mt-1">{wizardNote}</p>
                                        )}
                                    </div>

                                    {/* Sources (collapsible) + deep scan */}
                                    {showSources && wizardSources.length > 0 && (
                                        <div className="px-4 pb-4 space-y-2 border-t border-stone-100 pt-3">
                                            <div className="flex items-center justify-between">
                                                <p className="text-[10px] font-bold text-stone-500 uppercase tracking-wider">Official pages found</p>
                                                <div className="flex gap-2 text-[10px] font-bold">
                                                    <button onClick={() => setSelectedSources(wizardSources.map((_, i) => i))} className="text-sage-700 hover:underline">All</button>
                                                    <button onClick={() => setSelectedSources([])} className="text-stone-400 hover:underline">None</button>
                                                </div>
                                            </div>
                                            <div className="max-h-44 overflow-y-auto space-y-1 custom-scrollbar">
                                                {wizardSources.map((s, i) => {
                                                    const host = (() => { try { return new URL(s.url).hostname.replace(/^www\./, ''); } catch { return s.url; } })();
                                                    const on = selectedSources.includes(i);
                                                    return (
                                                        <div key={i} onClick={() => setSelectedSources(prev => on ? prev.filter(x => x !== i) : [...prev, i])}
                                                            className={`p-2 rounded-lg border cursor-pointer transition-all flex items-center gap-2 ${on ? 'border-sage-400 bg-sage-50' : 'border-stone-100 hover:border-sage-300'}`}>
                                                            <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${on ? 'border-sage-500 bg-sage-500 text-white' : 'border-stone-300'}`}>
                                                                {on && <CheckCircle size={10} />}
                                                            </div>
                                                            <div className="min-w-0 flex-1">
                                                                <p className="text-[10px] font-bold text-forest-dark truncate">{s.title}</p>
                                                                <p className="text-[8px] text-stone-400 font-mono truncate">{host}{(() => { try { return new URL(s.url).pathname; } catch { return ''; } })()}</p>
                                                            </div>
                                                            {s.blocked && <span title="Site blocks bots — Gemini will read it" className="text-[8px] text-amber-700 bg-amber-50 border border-amber-200 px-1 rounded shrink-0">AI read</span>}
                                                            {s.isPdf && <span className="text-[8px] text-stone-500 bg-stone-100 px-1 rounded shrink-0">PDF</span>}
                                                            <span className={`text-[8px] font-bold px-1.5 py-0.5 rounded shrink-0 ${
                                                                s.type === 'Officials' ? 'bg-blue-100 text-blue-700' :
                                                                s.type === 'Meetings' ? 'bg-purple-100 text-purple-700' :
                                                                s.type === 'Departments' ? 'bg-green-100 text-green-700' :
                                                                s.type === 'Committees' ? 'bg-amber-100 text-amber-700' :
                                                                'bg-stone-100 text-stone-600'
                                                            }`}>{s.type}</span>
                                                            <a href={s.url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} className="text-stone-300 hover:text-sage-700 shrink-0"><ExternalLink size={11} /></a>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                            {scanLive.length === 0 ? (
                                                <button onClick={handleDeepScan} disabled={selectedSources.length === 0 || scanRunning || wizardState === 'running'}
                                                    className="w-full py-2 bg-stone-800 text-white rounded-xl text-xs font-bold hover:bg-stone-700 disabled:opacity-40 transition-colors">
                                                    Deep scan {selectedSources.length} page{selectedSources.length !== 1 ? 's' : ''} for more names
                                                </button>
                                            ) : (
                                                <div className="space-y-2">
                                                    <div className="max-h-40 overflow-y-auto space-y-1 custom-scrollbar">
                                                        {scanLive.map((p, i) => {
                                                            const host = (() => { try { const u = new URL(p.url); return u.hostname.replace(/^www\./, '') + u.pathname; } catch { return p.url; } })();
                                                            return (
                                                                <div key={i} className={`p-2 rounded-lg border text-[10px] ${p.phase === 'queued' ? 'bg-white border-stone-100' : p.phase === 'done' ? 'bg-green-50 border-green-200' : p.phase === 'failed' ? 'bg-red-50 border-red-200' : 'bg-sage-50 border-sage-200'}`}>
                                                                    <div className="flex items-center gap-2">
                                                                        <StatusIcon status={p.phase === 'queued' ? 'pending' : p.phase === 'done' ? 'done' : p.phase === 'failed' ? 'failed' : 'running'} />
                                                                        <span className="font-mono text-sage-700 truncate flex-1">{host}</span>
                                                                        {p.entries > 0 && <span className="text-green-700 font-bold shrink-0">+{p.entries}</span>}
                                                                        {p.phase !== 'queued' && p.elapsedMs > 0 && <span className="font-mono text-stone-400 shrink-0 text-[9px]">{(p.elapsedMs / 1000).toFixed(1)}s</span>}
                                                                    </div>
                                                                    {p.detail && p.phase !== 'queued' && <p className={`ml-5 mt-0.5 ${p.phase === 'failed' ? 'text-red-600' : 'text-stone-500'}`}>{p.detail}</p>}
                                                                </div>
                                                            );
                                                        })}
                                                    </div>
                                                    {scanRecent.length > 0 && (
                                                        <div className="flex flex-wrap gap-1">
                                                            {scanRecent.slice(0, 16).map((e, i) => (
                                                                <span key={i} className={`text-[10px] px-1.5 py-0.5 rounded border ${e.type === 'acronym' ? 'bg-purple-50 border-purple-200 text-purple-700' : e.type === 'place' ? 'bg-green-50 border-green-200 text-green-700' : 'bg-white border-stone-200 text-stone-700'}`}>{e.replacement}</span>
                                                            ))}
                                                        </div>
                                                    )}
                                                    {!scanRunning && (
                                                        <div className="flex gap-2">
                                                            <button onClick={handleScanAccept} disabled={scanExtracted.length === 0} className="flex-1 py-2 bg-forest-dark text-white rounded-xl text-xs font-bold hover:bg-forest-light disabled:opacity-40">
                                                                {scanExtracted.length > 0 ? `Add ${scanExtracted.length} new entries from pages` : 'No new entries found on these pages'}
                                                            </button>
                                                            <button onClick={() => { setScanLive([]); setScanExtracted([]); setScanRecent([]); }} className="px-3 py-2 bg-white border border-stone-200 rounded-xl text-xs font-bold text-stone-500 hover:bg-stone-50">Clear</button>
                                                        </div>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    )}

                                    {/* Research results */}
                                    {wizardItems.length > 0 && (
                                        <div className="px-4 pb-4 space-y-2 border-t border-stone-100 pt-3">
                                            <div className="flex items-center justify-between">
                                                <p className="text-xs font-bold text-forest-dark">{wizardItems.length} names · {wizardTotalEntries} correction rules</p>
                                                <div className="flex gap-2 text-[10px] font-bold">
                                                    <button onClick={() => setWizardSelected(new Set(wizardItems.map(it => it.id)))} className="text-sage-700 hover:underline">Select all</button>
                                                    <button onClick={() => setWizardSelected(new Set())} className="text-stone-400 hover:underline">None</button>
                                                </div>
                                            </div>
                                            <div className="max-h-72 overflow-y-auto space-y-2 custom-scrollbar pr-1">
                                                {wizardGroups.filter(g => g.items.length > 0).map(g => {
                                                    const Icon = GROUP_ICONS[g.key] || Sparkles;
                                                    const collapsed = wizardCollapsed.has(g.key);
                                                    const sel = g.items.filter(it => wizardSelected.has(it.id)).length;
                                                    return (
                                                        <div key={g.key} className="rounded-lg border border-stone-200 overflow-hidden">
                                                            <div className="flex items-center gap-2 px-2 py-1.5 bg-stone-50 text-[10px]">
                                                                <button onClick={() => setWizardCollapsed(prev => { const n = new Set(prev); if (n.has(g.key)) n.delete(g.key); else n.add(g.key); return n; })} className="flex items-center gap-1 font-bold text-forest-dark">
                                                                    {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                                                                    <Icon size={11} className="text-stone-400" /> {g.label}
                                                                </button>
                                                                <span className="text-stone-400">{sel}/{g.items.length}</span>
                                                                <div className="ml-auto flex gap-2 font-bold">
                                                                    <button onClick={() => setGroupSelected(g.key, true)} className="text-sage-700 hover:underline">all</button>
                                                                    <button onClick={() => setGroupSelected(g.key, false)} className="text-stone-400 hover:underline">none</button>
                                                                </div>
                                                            </div>
                                                            {!collapsed && (
                                                                <div className="divide-y divide-stone-100">
                                                                    {g.items.map(it => {
                                                                        const on = wizardSelected.has(it.id);
                                                                        return (
                                                                            <label key={it.id} className={`flex items-center gap-2 px-2 py-1 cursor-pointer text-[10px] ${on ? 'bg-white' : 'bg-stone-50/60 opacity-60'}`}>
                                                                                <input type="checkbox" checked={on} onChange={() => toggleWizardItem(it.id)} className="accent-forest-dark shrink-0" />
                                                                                <span className="font-bold text-forest-dark truncate">{it.name}</span>
                                                                                {it.detail && <span className="text-stone-500 truncate">· {it.detail}</span>}
                                                                                <span className="ml-auto text-[9px] font-mono text-stone-400 shrink-0" title={it.entries.map(e => e.original).join(', ')}>{it.entries.length} rule{it.entries.length === 1 ? '' : 's'}</span>
                                                                            </label>
                                                                        );
                                                                    })}
                                                                </div>
                                                            )}
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                            <div className="flex gap-2 pt-1 items-center">
                                                <button onClick={handleWizardAdd} disabled={wizardSelectedItems.length === 0 || wizardState === 'running'}
                                                    className="flex-1 py-2 bg-forest-dark text-white rounded-xl text-xs font-bold hover:bg-forest-light disabled:opacity-50 transition-colors">
                                                    Add {wizardSelectedItems.length} name{wizardSelectedItems.length === 1 ? '' : 's'} ({wizardSelectedEntryCount} rules) to dictionary
                                                </button>
                                                {wizardAdded !== null && (
                                                    <span className="text-[10px] font-bold text-green-700 bg-green-50 border border-green-200 px-2 py-1 rounded-lg shrink-0">{wizardAdded} added</span>
                                                )}
                                            </div>
                                        </div>
                                    )}
                                    {wizardState === 'done' && wizardItems.length === 0 && !wizardError && (
                                        <p className="px-4 pb-4 text-[10px] text-stone-500">Nothing found. Try adding the state ("Brookline, MA") or a more specific name.</p>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* === MEETING PREP SECTION === */}
                        <div className="text-center mb-1">
                            <h3 className="text-sm font-bold text-forest-dark">Meeting Prep</h3>
                            <p className="text-[10px] text-stone-400">Add the people and terms for today's meeting</p>
                        </div>

                        {/* 1. Quick Names */}
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
                            {quickNamesPreview && (
                                <PreviewList entries={quickNamesPreview} accent="sage" title={`Preview — ${quickNamesPreview.length} corrections`} onAccept={handleAcceptQuickNames} onDiscard={() => setQuickNamesPreview(null)} />
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

                        {/* 3. Drag & Drop Upload — streamed, multi-file, with per-document progress and review */}
                        <div className="space-y-2">
                            <div
                                onDragEnter={handleDrag}
                                onDragLeave={handleDrag}
                                onDragOver={handleDrag}
                                onDrop={handleDrop}
                                onClick={() => fileUploadRef.current?.click()}
                                className={`relative border-2 border-dashed rounded-2xl min-h-[7.5rem] flex flex-col items-center justify-center text-center p-4 transition-all cursor-pointer overflow-hidden ${dragActive ? 'border-sage-500 bg-sage-50 scale-[1.01]' : 'border-stone-200 bg-white hover:border-sage-400 hover:bg-sage-50/40'}`}
                            >
                                <div className={`w-10 h-10 rounded-xl flex items-center justify-center mb-2 ${dragActive ? 'bg-sage-200 text-forest-dark' : 'bg-sage-100 text-sage-600'}`}><Upload size={20} /></div>
                                <p className="text-sm font-bold text-forest-dark">{dragActive ? 'Drop to read it' : 'Drop agendas, minutes or packets here'}</p>
                                <p className="text-[10px] text-stone-400 mt-0.5">PDF, Word (.docx), text, HTML or Markdown · several files at once · or click to choose</p>
                                <p className="text-[10px] text-stone-400 mt-1.5 flex items-center gap-1"><Sparkles size={10} className="text-sage-500" /> Names, boards, places and acronyms are extracted with {capabilities?.extractionEngine?.startsWith('ollama') ? `your local brain (${capabilities.extractionEngine.replace('ollama:', '')})` : capabilities?.geminiKey ? 'Gemini' : 'basic pattern matching (add an AI engine for better results)'}; you review before anything is added.</p>
                                {capabilities && !capabilities.pdf && <p className="text-[9px] text-red-500 mt-1">PDF parsing unavailable on this server</p>}
                                <input
                                    ref={fileUploadRef}
                                    type="file"
                                    multiple
                                    className="hidden"
                                    accept=".pdf,.txt,.docx,.html,.htm,.md"
                                    onChange={(e) => {
                                        const files = Array.from(e.target.files || []);
                                        if (files.length) ingestFiles(files);
                                        e.target.value = '';
                                    }}
                                />
                            </div>

                            {ingestJobs.map(job => {
                                const pct = job.status === 'queued' ? 0 : job.status === 'reading' ? 12 : job.status === 'extracting' ? (job.chunks ? 15 + Math.round(((job.chunk || 0) / job.chunks) * 80) : 30) : 100;
                                const elapsed = Math.max(0, Math.round(((job.ms ?? (Date.now() - job.startedAt)) / 1000)));
                                const groups = ['proper_noun', 'place', 'acronym', 'correction'] as const;
                                const GROUP: Record<string, { label: string; cls: string; icon: any }> = {
                                    proper_noun: { label: 'People & organizations', cls: 'bg-blue-100 text-blue-700', icon: Users },
                                    place: { label: 'Places', cls: 'bg-green-100 text-green-700', icon: MapPin },
                                    acronym: { label: 'Acronyms', cls: 'bg-purple-100 text-purple-700', icon: Hash },
                                    correction: { label: 'Corrections', cls: 'bg-amber-100 text-amber-700', icon: Wand2 },
                                };
                                const byType = (t: string) => job.entries.filter(e => (e.type || 'proper_noun') === t);
                                const selectedCount = job.selected.size;
                                const toggle = (k: string) => patchJob(job.id, j => { const n = new Set(j.selected); n.has(k) ? n.delete(k) : n.add(k); return { selected: n }; });
                                const toggleGroup = (t: string, on: boolean) => patchJob(job.id, j => { const n = new Set(j.selected); for (const e of byType(t)) { on ? n.add(entryKey(e)) : n.delete(entryKey(e)); } return { selected: n }; });
                                const kindIcon = job.kind === 'pdf' ? 'PDF' : job.kind === 'docx' ? 'DOC' : job.kind === 'html' ? 'HTML' : 'TXT';
                                return (
                                    <div key={job.id} className={`rounded-xl border p-3 space-y-2 transition-colors ${job.status === 'error' ? 'border-red-200 bg-red-50/60' : job.status === 'added' ? 'border-green-200 bg-green-50/60' : job.status === 'done' ? 'border-sage-300 bg-sage-50/60' : 'border-stone-200 bg-white'}`}>
                                        {/* header */}
                                        <div className="flex items-center gap-2 min-w-0">
                                            <span className={`text-[9px] font-mono font-bold px-1.5 py-0.5 rounded shrink-0 ${job.kind === 'pdf' ? 'bg-red-100 text-red-700' : job.kind === 'docx' ? 'bg-blue-100 text-blue-700' : 'bg-stone-100 text-stone-600'}`}>{kindIcon}</span>
                                            <p className="text-xs font-bold text-forest-dark truncate flex-1" title={job.filename}>{job.filename}</p>
                                            <span className="text-[10px] text-stone-400 shrink-0">{job.bytes >= 1e6 ? `${(job.bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(job.bytes / 1024))} KB`}{job.pages ? ` · ${job.pages} p` : ''}{job.words ? ` · ${job.words.toLocaleString()} words` : ''}</span>
                                            {(job.status === 'reading' || job.status === 'extracting' || job.status === 'queued') && <Loader2 size={13} className="animate-spin text-sage-600 shrink-0" />}
                                            {job.status === 'done' && <CheckCircle size={13} className="text-sage-600 shrink-0" />}
                                            {job.status === 'added' && <CheckCircle size={13} className="text-green-600 shrink-0" />}
                                            {job.status === 'error' && <AlertTriangle size={13} className="text-red-500 shrink-0" />}
                                            <button onClick={() => removeJob(job.id)} className="text-stone-300 hover:text-stone-600 shrink-0" title="Remove"><X size={13} /></button>
                                        </div>
                                        {/* progress + status line */}
                                        {(job.status === 'queued' || job.status === 'reading' || job.status === 'extracting') && (
                                            <div>
                                                <div className="h-1.5 bg-stone-100 rounded-full overflow-hidden"><div className="h-full bg-sage-500 rounded-full transition-all duration-500" style={{ width: `${Math.max(3, pct)}%` }} /></div>
                                                <div className="flex items-center justify-between mt-1 text-[10px]">
                                                    <span className="text-stone-600 truncate">{job.message}</span>
                                                    <span className="text-stone-400 font-mono shrink-0 ml-2">{elapsed}s{job.engine ? ` · ${job.engine.replace('ollama:', '')}` : ''}</span>
                                                </div>
                                                {job.status === 'extracting' && <p className="text-[10px] text-stone-400 mt-0.5">{job.engine?.startsWith('ollama') ? 'Running on this machine; a long packet takes a pass per 6,000 characters, about 5–15 s each.' : 'Long documents are split into chunks and extracted in parallel.'}</p>}
                                            </div>
                                        )}
                                        {job.status === 'error' && <p className="text-[11px] text-red-700">{job.error}</p>}
                                        {job.status === 'added' && <p className="text-[11px] text-green-800 font-medium">{job.message}{job.engine ? ` · ${job.engine.replace('ollama:', '')}` : ''}{job.ms ? ` · ${(job.ms / 1000).toFixed(1)} s` : ''}</p>}
                                        {job.status === 'done' && (
                                            <>
                                                <div className="flex items-center justify-between gap-2 text-[10px]">
                                                    <span className="font-bold text-forest-dark">{job.message}{job.existing ? <span className="font-normal text-stone-400"> · {job.existing} already in the dictionary</span> : null}</span>
                                                    <span className="text-stone-400 font-mono shrink-0">{job.engine?.replace('ollama:', '')}{job.ms ? ` · ${(job.ms / 1000).toFixed(1)} s` : ''}</span>
                                                </div>
                                                {job.warning && <p className="text-[10px] text-amber-700 flex items-start gap-1"><AlertTriangle size={11} className="shrink-0 mt-0.5" /> {job.warning}</p>}
                                                {job.entries.length > 0 && (
                                                    <div className="space-y-2">
                                                        {groups.filter(t => byType(t).length).map(t => {
                                                            const list = byType(t);
                                                            const allOn = list.every(e => job.selected.has(entryKey(e)));
                                                            const G = GROUP[t];
                                                            return (
                                                                <div key={t} className="rounded-lg bg-white border border-stone-100 p-2">
                                                                    <div className="flex items-center gap-2 mb-1">
                                                                        <span className={`w-5 h-5 rounded-md flex items-center justify-center ${G.cls}`}><G.icon size={11} /></span>
                                                                        <span className="text-[10px] font-bold text-forest-dark">{G.label} <span className="text-stone-400 font-normal">({list.length})</span></span>
                                                                        <button onClick={() => toggleGroup(t, !allOn)} className="ml-auto text-[10px] font-bold text-sage-700 hover:underline">{allOn ? 'Clear' : 'Select all'}</button>
                                                                    </div>
                                                                    <div className="max-h-36 overflow-y-auto custom-scrollbar space-y-0.5">
                                                                        {list.map(e => { const k = entryKey(e); const on = job.selected.has(k); return (
                                                                            <label key={k} className={`flex items-center gap-2 text-[10px] px-1.5 py-1 rounded cursor-pointer min-w-0 ${on ? 'bg-sage-50' : 'hover:bg-stone-50 opacity-70'}`}>
                                                                                <input type="checkbox" checked={on} onChange={() => toggle(k)} className="accent-forest-dark shrink-0" />
                                                                                <span className="text-stone-400 truncate max-w-[38%]">{e.original}</span>
                                                                                <ArrowRight size={8} className="text-stone-300 shrink-0" />
                                                                                <span className="font-bold text-forest-dark truncate">{e.replacement}</span>
                                                                                {e.note && <span className="text-stone-400 truncate hidden sm:inline">· {e.note}</span>}
                                                                            </label>
                                                                        ); })}
                                                                    </div>
                                                                </div>
                                                            );
                                                        })}
                                                    </div>
                                                )}
                                                <div className="flex items-center gap-2 pt-1">
                                                    {job.entries.length > 0 && <button onClick={() => addSelectedFromJob(job)} disabled={!selectedCount} className="flex-1 px-3 py-1.5 bg-forest-dark text-white text-[10px] font-bold rounded-lg hover:bg-forest-light disabled:opacity-40">Add {selectedCount} of {job.entries.length} to the dictionary</button>}
                                                    {job.preview && <button onClick={() => patchJob(job.id, { showText: !job.showText })} className="px-3 py-1.5 bg-white border border-stone-200 text-[10px] font-bold rounded-lg text-stone-500 hover:bg-stone-50">{job.showText ? 'Hide text' : 'Show text'}</button>}
                                                    <button onClick={() => removeJob(job.id)} className="px-3 py-1.5 bg-white border border-stone-200 text-[10px] font-bold rounded-lg text-stone-500 hover:bg-stone-50">Discard</button>
                                                </div>
                                                {job.showText && job.preview && <pre className="text-[10px] text-stone-600 bg-white border border-stone-100 rounded-lg p-2 max-h-40 overflow-auto whitespace-pre-wrap font-sans">{job.preview}{job.chars && job.chars > job.preview.length ? `\n… (${(job.chars - job.preview.length).toLocaleString()} more characters)` : ''}</pre>}
                                            </>
                                        )}
                                    </div>
                                );
                            })}
                        </div>

                        {/* 4. Paste Agenda Text — with preview */}
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
                            {pastePreview && (
                                <PreviewList entries={pastePreview} accent="purple" title={`Found ${pastePreview.length} entries — review before adding`} onAccept={handleAcceptPastePreview} onDiscard={() => setPastePreview(null)} />
                            )}
                        </div>

                        {/* === ADVANCED TOOLS === */}
                        <div className="text-center mt-2 mb-1">
                            <h3 className="text-sm font-bold text-stone-400">Advanced Tools</h3>
                        </div>

                        {/* 5. URL Scraper */}
                        <div className="bg-white rounded-xl border border-stone-200 p-4 space-y-3">
                            <div className="flex items-center gap-2">
                                <div className="w-6 h-6 bg-stone-400 rounded-lg flex items-center justify-center text-white"><Link size={12} /></div>
                                <div>
                                    <label className="text-xs font-bold text-forest-dark">Scrape URL</label>
                                    <p className="text-[9px] text-stone-400">Any web page or online PDF (agenda portals, rosters). Sites that block bots are read by Gemini.</p>
                                </div>
                            </div>
                            <div className="flex gap-2">
                                <input
                                    type="url"
                                    value={scrapeUrl}
                                    onChange={e => setScrapeUrl(e.target.value)}
                                    onKeyDown={e => e.key === 'Enter' && !scraping && scrapeUrl.trim() && handleScrapeUrl()}
                                    placeholder="https://townsite.gov/elected-officials"
                                    className="flex-1 px-3 py-2 rounded-lg border border-stone-200 text-xs focus:outline-none focus:border-forest-dark"
                                />
                                <button
                                    onClick={handleScrapeUrl}
                                    disabled={scraping || !scrapeUrl.trim()}
                                    className="px-4 py-2 rounded-lg bg-forest-dark text-white text-xs font-bold hover:opacity-90 disabled:opacity-40 flex items-center gap-1.5"
                                >
                                    {scraping ? <Loader2 size={12} className="animate-spin" /> : 'Scrape'}
                                </button>
                            </div>
                            {scrapeResult && !scrapePreview && (
                                <p className={`text-[10px] font-medium ${scrapeResult.kind === 'ok' ? 'text-green-700' : scrapeResult.kind === 'warn' ? 'text-amber-700' : 'text-red-600'}`}>{scrapeResult.text}</p>
                            )}
                            {scrapePreview && (
                                <PreviewList entries={scrapePreview} accent="sage" title={scrapeResult?.text || `${scrapePreview.length} entries`} onAccept={() => { const n = addEntries(scrapePreview, 'url'); setScrapePreview(null); setScrapeResult({ text: `Added ${n} entries`, kind: 'ok' }); setScrapeUrl(''); }} onDiscard={() => { setScrapePreview(null); setScrapeResult(null); }} />
                            )}
                        </div>

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
                                                addEntries([data.entry], 'auto_learned');
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
                                onKeyDown={e => e.key === 'Enter' && addManualEntry()}
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
                                onKeyDown={e => e.key === 'Enter' && addManualEntry()}
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
                                <p className="text-stone-400">Run the Municipality Wizard, drop an agenda PDF, or add rules manually.</p>
                            </div>
                         ) : (
                             dictionary
                                .map((entry, idx) => ({ entry, idx }))
                                .filter(({ entry }) => {
                                    if (dictTypeFilter && (entry.type || 'proper_noun') !== dictTypeFilter) return false;
                                    if (dictSearch) {
                                        const q = dictSearch.toLowerCase();
                                        return entry.original.toLowerCase().includes(q) || entry.replacement.toLowerCase().includes(q) || (entry.note || '').toLowerCase().includes(q);
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
                                        <div className="flex flex-col min-w-0">
                                            <div className="flex items-center gap-2 min-w-0">
                                                <span className="text-red-400 line-through text-sm truncate">{entry.original}</span>
                                                <ArrowRight size={12} className="text-stone-300 shrink-0" />
                                                <span className="text-forest-dark font-bold text-sm truncate">{entry.replacement}</span>
                                            </div>
                                            {entry.note && <span className="text-[10px] text-stone-400 truncate">{entry.note}</span>}
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
