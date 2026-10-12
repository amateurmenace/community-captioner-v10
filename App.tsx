import React, { useState, useEffect, useCallback, useRef } from 'react';
import LandingPage from './components/LandingPage';
import Dashboard from './components/Dashboard';
import Analytics from './components/Analytics';
import ContextEngine from './components/ContextEngine';
import Overlay from './components/Overlay';
import AudienceView from './components/AudienceView';
import OutputSettings from './components/OutputSettings';
import { PrerecordedStudio } from './components/PrerecordedStudio';
import GlobalSettings from './components/GlobalSettings';
import LocalSetup from './components/LocalSetup';
import HighlightStudio from './components/HighlightStudio';
import CaptionInjection from './components/CaptionInjection';
import { AppState, Caption, DictionaryEntry, UILanguage, SessionStats, Session, ContextSettings, HighlightClip, LocalEngineInfo } from './types';
import { Mic, FileVideo, Settings, Loader2, Server, Globe, Download, Monitor, CheckCircle, ArrowRight, ShieldCheck, Terminal, ExternalLink, Github, Zap } from 'lucide-react';
import { GITHUB_REPO_URL, GITHUB_CLONE_URL, RELEASES_URL, MAC_DOWNLOAD_URL, WINDOWS_DOWNLOAD_URL } from './utils/appLinks';
import { GoogleGenAI, LiveServerMessage, Modality } from "@google/genai";
import { translateText } from './services/geminiService';
import { buildCorrectionIndex, applyCorrections, diffForRules } from './shared/corrections.js';

// Cloud-mode recognizers. "transcribe-live" is Google's purpose-built live
// transcription model (far better on proper nouns); "native-audio" is the
// conversational model the app used before, kept as a fallback.
const CLOUD_MODELS = {
    'transcribe-live': 'gemini-3.5-transcribe-live',
    'native-audio': 'gemini-2.5-flash-native-audio-preview-12-2025',
} as const;

/** Rolling words-per-minute over the last 60 s of final captions. */
const rollingWpm = (captions: Caption[], now = Date.now()): number => {
    const windowMs = 60000;
    const recent = captions.filter(c => c.isFinal && now - c.timestamp <= windowMs);
    if (recent.length === 0) return 0;
    const words = recent.reduce((n, c) => n + c.text.split(/\s+/).filter(Boolean).length, 0);
    const spanMs = Math.max(now - recent[0].timestamp, 10000); // avoid huge WPM from a single early line
    return Math.round(words / (Math.min(spanMs, windowMs) / 60000));
};

// --- Helper Functions for Audio ---
function base64Encode(bytes: Uint8Array) {
    let binary = '';
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

function createPcmBlob(data: Float32Array): { data: string, mimeType: string } {
    const l = data.length;
    const int16 = new Int16Array(l);
    for (let i = 0; i < l; i++) {
        const s = Math.max(-1, Math.min(1, data[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return {
        data: base64Encode(new Uint8Array(int16.buffer)),
        mimeType: 'audio/pcm;rate=16000',
    };
}

// --- Helper for Dynamic WS Connection ---
const getRelayUrl = () => {
    // 1. Check for manual override
    const manual = localStorage.getItem('cc_relay_url');
    if (manual) return manual;

    // 2. Determine based on current location
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.hostname;
    const port = window.location.port;

    // CLOUD FIX: If no port (standard 80/443), don't append a colon
    const portSuffix = port ? `:${port}` : '';
    
    // DEV MODE FIX: If running in Vite Dev (5173-5199), assume relay is on 8080 locally
    const p = parseInt(port || '0');
    if (p >= 5170 && p <= 5199) {
        return `${protocol}//${host}:8080`;
    }

    return `${protocol}//${host}${portSuffix}`;
};

// HTTP base URL of the relay (REST API), derived the same way as the WebSocket URL
const getRelayHttpUrl = () => {
    const ws = getRelayUrl();
    return ws.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
};

// Dictionary persistence — survives reloads and is mirrored to the relay so the
// server-side learner can dedupe against it.
const loadSavedDictionary = (): DictionaryEntry[] => {
    try {
        const raw = localStorage.getItem('cc_dictionary');
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.filter(e => e && e.original && e.replacement) : [];
    } catch { return []; }
};

const initialStats: SessionStats = {
    durationSeconds: 0,
    totalWords: 0,
    averageConfidence: 0,
    confidenceSamples: 0,
    confidenceHistory: [],
    correctionsMade: 0,
    wpmHistory: [],
    recentCorrections: [],
    systemHealth: 'healthy',
    latencyMs: 0,
    latencySamples: 0,
    modeSwitches: []
};

function App() {
  // Detect Electron Environment
  const isElectron = /Electron/.test(navigator.userAgent);

  // Initialize state with keys from localStorage if available
  const [appState, setAppState] = useState<AppState>(() => {
    const savedOverlay = localStorage.getItem('cc_overlay_settings');
    const overlaySettings = savedOverlay ? JSON.parse(savedOverlay) : {
        fontFamily: 'sans-serif',
        fontSize: 36,
        color: '#ffffff',
        backgroundColor: 'rgba(0,0,0,0.8)',
        x: 5,
        y: 80,
        width: 90,
        maxLines: 2,
        textAlign: 'center'
    };

    return {
        view: 'landing',
        isRecording: false,
        captions: [],
        interimText: '',
        dictionary: loadSavedDictionary(),
        stats: initialStats,
        mode: 'balanced',
        audioSourceId: '',
        targetLanguage: 'en',
        outputMode: 'browser_overlay',
        overlaySettings,
        learningEnabled: true,
        notifications: [],
        activeContextName: localStorage.getItem('cc_context_name') || null,
        profanityFilter: false,
        partialResults: true,
        speakerLabels: false,
        uiLanguage: 'en',
        pastSessions: [],
        contextSettings: { sensitivity: 80, acronymExpansion: true, dialect: 'general' },
        // Load config
        apiKey: localStorage.getItem('cc_api_key') || process.env.API_KEY || '',
        localServerUrl: localStorage.getItem('cc_local_url') || 'ws://localhost:9000',
        localLlmUrl: localStorage.getItem('cc_llm_url') || 'http://localhost:11434',
        localLlmModel: localStorage.getItem('cc_llm_model') || 'qwen3:4b',
        cloudModel: (localStorage.getItem('cc_cloud_model') as any) || 'transcribe-live',
        
        // Video Studio
        uploadedVideoFile: null,
        highlightCart: [],
        
        // RTMP
        rtmpUrl: 'ws://localhost:3000',
        isStreaming: false,

        // CEA-708 SDI Bridge
        cea708Enabled: false
    };
  });

  const [showContextModal, setShowContextModal] = useState(false);
  const [showOutputModal, setShowOutputModal] = useState(false);
  const [showGlobalSettings, setShowGlobalSettings] = useState(false);
  const [globalSettingsTab, setGlobalSettingsTab] = useState<'general'|'cloud'|'local'|'guide'>('general');
  const [relayStatus, setRelayStatus] = useState<'connected'|'disconnected'>('disconnected');

  // Detect platform + DeckLink addon status so the workflow picker can
  // surface a heads-up on the Caption Injection card.
  // NOTE: must stay up here with the other hooks — declaring it after the
  // conditional view returns below changes the hook count between renders
  // and crashes React when navigating between views.
  const [addonStatus, setAddonStatus] = useState<{ loaded: boolean; platform: string } | null>(null);
  useEffect(() => {
    if (appState.view !== 'choice') return;
    const port = window.location.port;
    const p = parseInt(port || '0');
    const relayPort = (p >= 5170 && p <= 5199) ? '8080' : (port || '80');
    fetch(`${window.location.protocol}//${window.location.hostname}:${relayPort}/api/inject/status`)
      .then(r => r.json())
      .then(d => setAddonStatus({ loaded: !!d.addonLoaded, platform: /Windows/i.test(navigator.userAgent) ? 'windows' : /Mac/i.test(navigator.userAgent) ? 'mac' : 'other' }))
      .catch(() => {});
  }, [appState.view]);
  
  // Audio Refs
  const recognitionRef = useRef<any>(null);
  const geminiContextRef = useRef<AudioContext | null>(null);
  const wakeLockRef = useRef<any>(null);
  const keepAliveAudioRef = useRef<HTMLAudioElement | null>(null);
  const resilienceStrategyRef = useRef<string>('browser');

  // Real-metrics refs: a tiny voice-activity detector marks the last moment the
  // mic carried speech, so latency = (final caption arrives) − (speech stopped).
  const vadContextRef = useRef<AudioContext | null>(null);
  const vadIntervalRef = useRef<any>(null);
  const lastVoiceTsRef = useRef<number>(0);
  const latencyEmaRef = useRef<number | null>(null);

  // Proposed rules from operator edits (shown as toasts on the Dashboard)
  const [editSuggestions, setEditSuggestions] = useState<{ id: string; original: string; replacement: string }[]>([]);

  // Local speech server status (Local / Fully Local modes) — shown on the Dashboard
  const [localEngine, setLocalEngine] = useState<LocalEngineInfo>({ connected: false });

  const [currentStream, setCurrentStream] = useState<MediaStream | null>(null);
  const dictionaryRef = useRef(appState.dictionary);
  const correctionIndexRef = useRef(buildCorrectionIndex(appState.dictionary));
  const contextSettingsRef = useRef(appState.contextSettings);
  const targetLanguageRef = useRef(appState.targetLanguage);
  const profanityRef = useRef(appState.profanityFilter);
  const activeModeRef = useRef(appState.mode);
  const statsRef = useRef(appState.stats);
  const captionsRef = useRef(appState.captions); // Ref for immediate access in callbacks
  const interimRef = useRef(appState.interimText);
  const apiKeyRef = useRef(appState.apiKey);

  // Sync refs
  useEffect(() => { dictionaryRef.current = appState.dictionary; correctionIndexRef.current = buildCorrectionIndex(appState.dictionary); }, [appState.dictionary]);
  useEffect(() => { contextSettingsRef.current = appState.contextSettings; }, [appState.contextSettings]);
  useEffect(() => { if (appState.cloudModel) localStorage.setItem('cc_cloud_model', appState.cloudModel); }, [appState.cloudModel]);
  useEffect(() => {
      if (appState.localServerUrl) localStorage.setItem('cc_local_url', appState.localServerUrl);
      if (appState.localLlmUrl) localStorage.setItem('cc_llm_url', appState.localLlmUrl);
      if (appState.localLlmModel) localStorage.setItem('cc_llm_model', appState.localLlmModel);
  }, [appState.localServerUrl, appState.localLlmUrl, appState.localLlmModel]);
  useEffect(() => { targetLanguageRef.current = appState.targetLanguage; }, [appState.targetLanguage]);
  useEffect(() => { profanityRef.current = appState.profanityFilter; }, [appState.profanityFilter]);
  useEffect(() => { activeModeRef.current = appState.mode; }, [appState.mode]);
  useEffect(() => { statsRef.current = appState.stats; }, [appState.stats]);
  useEffect(() => { captionsRef.current = appState.captions; }, [appState.captions]);
  useEffect(() => { interimRef.current = appState.interimText; }, [appState.interimText]);
  useEffect(() => { apiKeyRef.current = appState.apiKey; }, [appState.apiKey]);

  // Handle Translation Key Warning
  useEffect(() => {
      if (appState.targetLanguage !== 'en' && !appState.apiKey) {
           alert("Translation Feature Warning:\n\nYou have selected a language for translation, but no API Key is configured.\n\nTranslation uses the Google Gemini API. Please enter your key in Settings > Cloud Access.");
           setGlobalSettingsTab('cloud');
           setShowGlobalSettings(true);
           setAppState(p => ({...p, targetLanguage: 'en'})); // Reset to avoid stuck state
      }
  }, [appState.targetLanguage]);

  // Persist the Context Engine dictionary locally and mirror it to the relay (debounced)
  useEffect(() => {
      try { localStorage.setItem('cc_dictionary', JSON.stringify(appState.dictionary)); } catch {}
      const timer = setTimeout(() => {
          fetch(`${getRelayHttpUrl()}/api/context/dictionary`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ dictionary: appState.dictionary, sensitivity: appState.contextSettings.sensitivity }),
          }).catch(() => {});
      }, 600);
      return () => clearTimeout(timer);
  }, [appState.dictionary, appState.contextSettings.sensitivity]);

  useEffect(() => {
      try {
          if (appState.activeContextName) localStorage.setItem('cc_context_name', appState.activeContextName);
          else localStorage.removeItem('cc_context_name');
      } catch {}
  }, [appState.activeContextName]);

  // Persist Overlay Settings & Broadcast Change
  useEffect(() => {
      localStorage.setItem('cc_overlay_settings', JSON.stringify(appState.overlaySettings));
      // Broadcast settings change to other windows (like the Overlay)
      const bc = new BroadcastChannel('cc_channel');
      bc.postMessage({ type: 'settings', payload: appState.overlaySettings });
      bc.close();
  }, [appState.overlaySettings]);

  // Check for OBS/Overlay URL parameters on load
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const viewParam = params.get('view');
    if (viewParam === 'output') {
        setAppState(prev => ({ ...prev, view: 'caption_output' }));
    } else if (viewParam === 'audience') {
        setAppState(prev => ({ ...prev, view: 'audience_view' } as any));
    }
  }, []);

  // --- OVERLAY MODE DATA SYNC ---
  useEffect(() => {
      if (appState.view === 'caption_output' && !appState.isRecording) {
          
          // Helper to process incoming caption data
          const handleIncomingCaption = (data: { isFinal: boolean, payload: any }) => {
              if (data.isFinal) {
                  setCaptions(prev => {
                      if (prev.some(c => c.id === data.payload.id)) return prev;
                      return [...prev, data.payload];
                  });
                  setAppState(p => ({...p, interimText: ''}));
              } else {
                  setAppState(p => ({...p, interimText: data.payload.text}));
              }
          };

          // 1. BroadcastChannel (Best for Tab-to-Tab)
          const bc = new BroadcastChannel('cc_channel');
          bc.onmessage = (event) => {
              if (event.data.type === 'caption') {
                  handleIncomingCaption(event.data);
              } else if (event.data.type === 'settings') {
                  // Sync settings from main window
                  setAppState(prev => ({ ...prev, overlaySettings: event.data.payload }));
              }
          };

          // 2. LocalStorage Event (Fallback for Tab-to-Popup)
          const handleStorage = (e: StorageEvent) => {
              if (e.key === 'cc_live_data' && e.newValue) {
                  try {
                      const data = JSON.parse(e.newValue);
                      handleIncomingCaption(data);
                  } catch(err) {}
              }
              if (e.key === 'cc_overlay_settings' && e.newValue) {
                  try {
                       setAppState(prev => ({ ...prev, overlaySettings: JSON.parse(e.newValue!) }));
                  } catch(err) {}
              }
          };
          window.addEventListener('storage', handleStorage);

          // 3. WebSocket (Required for OBS Browser Source / Network)
          const relayUrl = getRelayUrl();
          let ws: WebSocket | null = null;
          let retryTimeout: any;

          const connect = () => {
              console.log(`[Overlay] Connecting to Relay: ${relayUrl}`);
              ws = new WebSocket(relayUrl);
              ws.onopen = () => {
                  console.log("Overlay connected to Relay");
                  setRelayStatus('connected');
                  ws?.send(JSON.stringify({ type: 'join', sessionId: 'demo', role: 'audience' }));
              };
              ws.onmessage = (e) => {
                  try {
                      const data = JSON.parse(e.data);
                      if (data.type === 'caption') {
                          handleIncomingCaption(data);
                      } else if (data.type === 'settings') {
                          setAppState(prev => ({ ...prev, overlaySettings: data.payload }));
                      }
                  } catch(err) { console.error(err); }
              };
              ws.onclose = () => {
                  console.log("Overlay disconnected, retrying...");
                  setRelayStatus('disconnected');
                  retryTimeout = setTimeout(connect, 3000);
              };
              ws.onerror = () => {
                  setRelayStatus('disconnected');
                  ws?.close();
              };
          };

          connect();

          return () => {
              bc.close();
              window.removeEventListener('storage', handleStorage);
              if (ws) ws.close();
              clearTimeout(retryTimeout);
          };
      }
  }, [appState.view, appState.isRecording]);

  // --- WAKE LOCK & RESILIENCE LOGIC ---
  useEffect(() => {
    const requestWakeLock = async () => {
        if ('wakeLock' in navigator && appState.isRecording) {
            try {
                wakeLockRef.current = await (navigator as any).wakeLock.request('screen');
                console.log('Wake Lock active');
            } catch (err) {
                console.warn('Wake Lock request failed:', err);
            }
        } else if (!appState.isRecording && wakeLockRef.current) {
            wakeLockRef.current.release();
            wakeLockRef.current = null;
        }
    };

    if (appState.isRecording) {
        if (!keepAliveAudioRef.current) {
            const audio = new Audio("data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABBGYXRhAgAAAAEA");
            audio.loop = true;
            audio.volume = 0.01; 
            keepAliveAudioRef.current = audio;
        }
        keepAliveAudioRef.current.play().catch(e => console.warn("Keep-alive audio blocked", e));
    } else {
        if (keepAliveAudioRef.current) {
            keepAliveAudioRef.current.pause();
        }
    }

    requestWakeLock();

    return () => {
        if (wakeLockRef.current) wakeLockRef.current.release();
    };
  }, [appState.isRecording]);


  // Timer Effect — session clock + a rolling-WPM sample every 5 s (so the chart
  // decays when nobody is speaking). Latency is measured per caption, not here.
  useEffect(() => {
    let interval: any;
    if (appState.isRecording) {
      interval = setInterval(() => {
        setAppState(prev => {
            const nextSeconds = prev.stats.durationSeconds + 1;
            return {
                ...prev,
                stats: {
                    ...prev.stats,
                    durationSeconds: nextSeconds,
                    wpmHistory: nextSeconds % 5 === 0
                      ? [...prev.stats.wpmHistory, { time: nextSeconds, wpm: rollingWpm(prev.captions) }].slice(-720)
                      : prev.stats.wpmHistory,
                }
            };
        });
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [appState.isRecording]);

  const setCaptions = useCallback((val: Caption[] | ((prev: Caption[]) => Caption[])) => {
      setAppState(prev => ({ ...prev, captions: typeof val === 'function' ? val(prev.captions) : val }));
  }, []);

  const setDictionary = useCallback((val: DictionaryEntry[] | ((prev: DictionaryEntry[]) => DictionaryEntry[])) => {
      setAppState(prev => ({ ...prev, dictionary: typeof val === 'function' ? val(prev.dictionary) : val }));
  }, []);

  /**
   * Update session statistics with one final caption.
   *   confidence   recognizer confidence 0–1, or null when the engine doesn't report one (Gemini)
   *   latencyMs    measured end-of-speech → caption delay, or null when no speech was detected
   */
  const updateStats = useCallback((newWordCount: number, confidence: number | null, correctionDetail?: string, latencyMs?: number | null) => {
      setAppState(prev => {
          const now = Date.now();
          const samples = prev.stats.confidenceSamples || 0;
          const hasConf = typeof confidence === 'number' && confidence > 0;
          const newAvg = hasConf ? ((prev.stats.averageConfidence * samples) + confidence) / (samples + 1) : prev.stats.averageConfidence;
          const currentWpm = rollingWpm(prev.captions, now);

          let newNotifications = [...prev.notifications];
          if (correctionDetail) {
             newNotifications.push({ id: Date.now().toString(), message: `Fixed: ${correctionDetail}`, type: 'correction', timestamp: now });
          }

          const latSamples = prev.stats.latencySamples || 0;
          const hasLat = typeof latencyMs === 'number' && latencyMs >= 0;
          const newLatency = hasLat ? (latSamples === 0 ? latencyMs : Math.round(prev.stats.latencyMs * 0.7 + latencyMs * 0.3)) : prev.stats.latencyMs;

          const newRecentCorrections = correctionDetail ? [`${correctionDetail}`, ...prev.stats.recentCorrections].slice(0, 10) : prev.stats.recentCorrections;
          return {
              ...prev,
              stats: {
                  ...prev.stats,
                  totalWords: prev.stats.totalWords + newWordCount,
                  averageConfidence: newAvg,
                  confidenceSamples: hasConf ? samples + 1 : samples,
                  confidenceHistory: hasConf ? [...prev.stats.confidenceHistory, { time: prev.stats.durationSeconds, score: newAvg }] : prev.stats.confidenceHistory,
                  correctionsMade: correctionDetail ? prev.stats.correctionsMade + 1 : prev.stats.correctionsMade,
                  wpmHistory: [...prev.stats.wpmHistory, { time: prev.stats.durationSeconds, wpm: currentWpm }].slice(-720),
                  recentCorrections: newRecentCorrections,
                  latencyMs: newLatency,
                  latencySamples: hasLat ? latSamples + 1 : latSamples,
                  systemHealth: (hasConf && newAvg < 0.7) || (hasLat && newLatency > 4000) ? 'degraded' : 'healthy'
              },
              notifications: newNotifications
          };
      });
  }, []);

  // Operator edited a caption on the Dashboard: keep the edit, and propose
  // dictionary rules from the changed word spans ("Learn from operator edits").
  const handleEditCaption = (id: string, newText: string) => {
    const old = captionsRef.current.find(c => c.id === id);
    const cleaned = newText.trim();
    if (old && cleaned && cleaned !== old.text) {
        const rules = diffForRules(old.text, cleaned);
        if (rules.length) {
            const existing = new Set(dictionaryRef.current.map(e => `${e.original.toLowerCase()}→${e.replacement.toLowerCase()}`));
            const novel = rules.filter(r => !existing.has(`${r.original.toLowerCase()}→${r.replacement.toLowerCase()}`));
            if (novel.length) setEditSuggestions(prev => [...prev, ...novel.map((r, i) => ({ id: `${Date.now()}-${i}`, ...r }))].slice(-6));
        }
    }
    setAppState(prev => ({
        ...prev,
        captions: prev.captions.map(c => c.id === id ? { ...c, text: cleaned || c.text, isFinal: true, corrected: true } : c)
    }));
  };

  const acceptEditSuggestion = (id: string) => {
      const s = editSuggestions.find(x => x.id === id);
      setEditSuggestions(prev => prev.filter(x => x.id !== id));
      if (!s) return;
      setDictionary(prev => {
          const k = `${s.original.toLowerCase()}→${s.replacement.toLowerCase()}`;
          if (prev.some(e => `${e.original.toLowerCase()}→${e.replacement.toLowerCase()}` === k)) return prev;
          return [...prev, { original: s.original, replacement: s.replacement, type: 'correction', source: 'operator_edit' }];
      });
  };
  const dismissEditSuggestion = (id: string) => setEditSuggestions(prev => prev.filter(x => x.id !== id));

  const processText = (text: string): { final: string, detail: string | null } => {
    // Dictionary: exact word-boundary matches, then phonetic ("sounds-like") matches
    // gated by the Correction Sensitivity setting. See shared/corrections.js.
    const { text: corrected, applied } = applyCorrections(text, correctionIndexRef.current, { sensitivity: contextSettingsRef.current?.sensitivity ?? 80 });
    let processed = corrected;
    const detail = applied.length
        ? applied.map(a => `${a.matched} → ${a.replacement}${a.mode === 'phonetic' ? ' (sounds-like)' : ''}`).join(', ')
        : null;

    if (profanityRef.current) {
        const badWords = ['damn', 'hell', 'crap', 'shit', 'fuck'];
        const pattern = new RegExp(`\\b(${badWords.join('|')})\\b`, 'gi');
        processed = processed.replace(pattern, '***');
    }

    return { final: processed, detail };
  };

  // Exposed so audio callbacks can reach it. `confidence` is null for engines
  // that don't report one (Gemini); latency is measured against the VAD.
  const finalizeCaption = (text: string, confidence: number | null = null) => {
        const { final, detail } = processText(text);
        if (!final.trim()) return;

        const now = Date.now();
        const latencyMs = lastVoiceTsRef.current ? Math.min(8000, Math.max(0, now - lastVoiceTsRef.current)) : null;

        const newCaption: Caption = {
            id: `${now}-${Math.random().toString(36).substr(2, 9)}`,
            text: final,
            timestamp: now,
            confidence: typeof confidence === 'number' && confidence > 0 ? confidence : 1,
            isFinal: true,
            corrected: !!detail
        };

        // Handle Translation - Checks for API Key if not English
        if (targetLanguageRef.current !== 'en') {
            const key = apiKeyRef.current;
            if (key) {
                translateText(final, targetLanguageRef.current, key).then(t => {
                     setCaptions(prev => prev.map(c => c.id === newCaption.id ? { ...c, translatedText: t } : c));
                });
            } else {
                console.warn("Translation skipped: No API Key.");
            }
        }

        setCaptions(prev => [...prev, newCaption]);
        updateStats(final.split(/\s+/).filter(Boolean).length, confidence, detail || undefined, latencyMs);
        setAppState(prev => ({...prev, interimText: ''}));
        
        // RTMP Simulation Emit
        if (appState.isStreaming && appState.rtmpUrl) {
            try {
                console.log(`[RTMP EMIT] Sending CEA-608 data: ${final}`);
            } catch(e) {}
        }
  };

  // --- RECORDING LOGIC ---
  useEffect(() => {
    let mounted = true;
    let stream: MediaStream | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let localWs: WebSocket | null = null;
    let geminiSession: any = null;
    
    // Cleanup logic
    const cleanup = () => {
        mounted = false;
        if (stream) stream.getTracks().forEach(t => t.stop());
        if (source) source.disconnect();
        if (geminiContextRef.current) geminiContextRef.current.close();
        if (recognitionRef.current) try { recognitionRef.current.stop(); } catch(e) {}
        if (localWs) localWs.close();
        if (geminiSession) try { geminiSession.close(); } catch(e) {}
        if (vadIntervalRef.current) { clearInterval(vadIntervalRef.current); vadIntervalRef.current = null; }
        if (vadContextRef.current) { try { vadContextRef.current.close(); } catch(e) {} vadContextRef.current = null; }
        lastVoiceTsRef.current = 0;

        setAppState(p => ({...p, interimText: ''}));
    };

    // Voice-activity detector: samples mic RMS every 60 ms and remembers the
    // last moment it exceeded the speech threshold. Used for the latency metric.
    const startVad = (mediaStream: MediaStream) => {
        try {
            const ctx = new AudioContext();
            const src = ctx.createMediaStreamSource(mediaStream);
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 512;
            src.connect(analyser);
            const buf = new Float32Array(analyser.fftSize);
            vadIntervalRef.current = setInterval(() => {
                analyser.getFloatTimeDomainData(buf);
                let sum = 0;
                for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
                const rms = Math.sqrt(sum / buf.length);
                if (rms > 0.02) lastVoiceTsRef.current = Date.now();
            }, 60);
            vadContextRef.current = ctx;
            if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        } catch (e) {
            console.warn('VAD unavailable', e);
        }
    };

    if (!appState.isRecording) {
        cleanup();
        resilienceStrategyRef.current = 'browser';
        return;
    }

    let strategy = appState.mode === 'cloud' ? 'cloud' : appState.mode === 'local' || appState.mode === 'fully_local' ? 'local' : 'browser';

    const startRecording = async () => {
        try {
            // 1. Get Audio Stream
            // CLOUD FIX: Remove sampleRate: 16000 constraint to avoid "OverconstrainedError" on consumer hardware
            // Let the browser pick the native rate, and AudioContext will handle resampling.
            stream = await navigator.mediaDevices.getUserMedia({ 
                audio: { 
                    deviceId: appState.audioSourceId ? { exact: appState.audioSourceId } : undefined,
                    echoCancellation: true,
                    autoGainControl: true,
                    noiseSuppression: true,
                    channelCount: 1
                } 
            });
            if (!mounted) return;
            setCurrentStream(stream);
            startVad(stream);

            // 2. Initialize Strategy
            
            // --- LOCAL WHISPER MODE ---
            if (strategy === 'local') {
                if (!appState.localServerUrl) {
                    alert("Local Server URL missing.");
                    setAppState(p => ({...p, isRecording: false}));
                    return;
                }
                
                const initLocal = () => {
                    const ws = new WebSocket(appState.localServerUrl!);
                    ws.binaryType = 'arraybuffer';
                    localWs = ws;

                    ws.onopen = async () => {
                        console.log("Local speech server connected");
                        setLocalEngine(prev => ({ ...prev, connected: true, url: appState.localServerUrl, error: undefined }));
                        const ctx = new AudioContext({ sampleRate: 16000 });
                        // CRITICAL: Force resume in case browser policy suspended it
                        if (ctx.state === 'suspended') await ctx.resume();
                        
                        source = ctx.createMediaStreamSource(stream!);
                        const processor = ctx.createScriptProcessor(4096, 1, 1);
                        processor.onaudioprocess = (e) => {
                            if (ws.readyState === 1) {
                                const data = e.inputBuffer.getChannelData(0);
                                const pcm = new Int16Array(data.length);
                                for (let i = 0; i < data.length; i++) pcm[i] = Math.max(-1, Math.min(1, data[i])) * 0x7FFF;
                                ws.send(pcm.buffer);
                            }
                        };
                        source.connect(processor);
                        processor.connect(ctx.destination);
                        geminiContextRef.current = ctx; 
                    };
                    ws.onmessage = (e) => {
                        try {
                            const data = JSON.parse(e.data);
                            if (data.type === 'hello') {
                                // Our bundled server announces what it runs; legacy servers never send this
                                setLocalEngine({ connected: true, backend: data.backend, model: data.model, device: data.device, compute: data.compute, url: appState.localServerUrl });
                                return;
                            }
                            if (data.type === 'status') {
                                if (data.state === 'error') setLocalEngine(prev => ({ ...prev, error: data.message }));
                                return;
                            }
                            if (typeof data.text !== 'string') return;
                            if (data.isFinal === false) {
                                setAppState(p => ({ ...p, interimText: data.text }));
                            } else if (data.text.trim()) {
                                finalizeCaption(data.text);
                                setAppState(p => ({ ...p, interimText: '' }));
                            }
                        } catch (err) {}
                    };
                    ws.onerror = (e) => { console.error("Local Server Error", e); setLocalEngine(prev => ({ ...prev, connected: false, error: 'Cannot reach the local speech server' })); };
                    ws.onclose = () => {
                        setLocalEngine(prev => ({ ...prev, connected: false }));
                        // Reconnect strategy
                        if (mounted) setTimeout(initLocal, 1000);
                    };
                };
                initLocal();
            }
            
            // --- BROWSER MODE (WebSpeech) ---
            else if (strategy === 'browser') {
                // Electron Check: Web Speech API relies on Google keys missing in Electron
                if (isElectron) {
                     alert("Balanced Mode (Web Speech API) is not supported in the Desktop App because it requires Google Chrome's built-in servers.\n\nPlease switch to:\n1. Cloud Mode (Recommended, High Accuracy)\n2. Local Mode (Offline, Privacy Focused)");
                     setAppState(p => ({...p, isRecording: false}));
                     return;
                }

                const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
                if (!SpeechRecognition) {
                    alert("Browser does not support Web Speech API");
                    setAppState(p => ({...p, isRecording: false}));
                    return;
                }
                const recognition = new SpeechRecognition();
                recognition.continuous = true;
                recognition.interimResults = true;
                recognition.lang = appState.targetLanguage === 'en' ? 'en-US' : appState.targetLanguage;
                
                recognition.onresult = (event: any) => {
                    let interim = '';
                    for (let i = event.resultIndex; i < event.results.length; ++i) {
                        if (event.results[i].isFinal) {
                            const conf = event.results[i][0].confidence;
                            finalizeCaption(event.results[i][0].transcript, typeof conf === 'number' && conf > 0 ? conf : null);
                        } else {
                            interim += event.results[i][0].transcript;
                        }
                    }
                    setAppState(p => ({...p, interimText: interim}));
                };
                
                recognition.onerror = (event: any) => {
                    console.error("Speech Rec Error", event);
                    if (event.error === 'network') {
                        // Add notification so user sees it in UI
                        setAppState(prev => ({
                             ...prev,
                             notifications: [...prev.notifications, { id: Date.now().toString(), message: "Network Error: Retrying Speech API...", type: 'error', timestamp: Date.now() }]
                        }));
                        // Retry on network error
                        setTimeout(() => { if(mounted) try { recognition.start(); } catch(e){} }, 1000);
                    } else if (event.error === 'not-allowed') {
                        alert("Microphone access denied. Please allow microphone access in your browser settings.");
                        setAppState(p => ({...p, isRecording: false}));
                    }
                };
                
                recognition.onend = () => {
                    // Auto-restart
                    if (mounted) {
                        try { recognition.start(); } catch(e) {}
                    }
                };
                
                recognitionRef.current = recognition;
                try {
                    recognition.start();
                } catch(e) {
                    console.warn("Recognition start failed", e);
                }
            }
            
            // --- CLOUD MODE (Gemini Live) ---
            else if (strategy === 'cloud') {
                if (!appState.apiKey) {
                    alert("API Key required for Cloud Mode");
                    setAppState(p => ({...p, isRecording: false}));
                    return;
                }

                // Cloud Mode Transcript Buffer to prevent race conditions
                let cloudTranscriptBuffer = '';
                const cloudModelKey = (appState.cloudModel && CLOUD_MODELS[appState.cloudModel]) ? appState.cloudModel : 'transcribe-live';
                const isTranscribeModel = cloudModelKey === 'transcribe-live';

                const initGeminiLive = async () => {
                    try {
                        const ai = new GoogleGenAI({ apiKey: appState.apiKey });
                        const sessionPromise = ai.live.connect({
                            model: CLOUD_MODELS[cloudModelKey],
                            config: isTranscribeModel
                                ? {
                                    // Purpose-built live transcription model: no spoken reply, just
                                    // inputTranscription segments finalized by its own VAD.
                                    inputAudioTranscription: {},
                                  }
                                : {
                                    responseModalities: [Modality.AUDIO], // Audio output required for conversation model
                                    inputAudioTranscription: {}, // Enabled without specific model to get user transcript
                                    systemInstruction: { parts: [{ text: "You are a transcriber. Listen silently and do not speak." }] }
                                  },
                            callbacks: {
                                onopen: () => console.log(`Gemini Live Connected (${CLOUD_MODELS[cloudModelKey]})`),
                                onmessage: (msg: LiveServerMessage) => {
                                    const sc: any = msg.serverContent || {};

                                    if (isTranscribeModel) {
                                        // Transcribe Live: `interimInputTranscription` carries the cumulative
                                        // text of the segment being spoken (~2/s); `inputTranscription` is the
                                        // finished segment, emitted ~1.7 s after the speaker pauses.
                                        const interim = sc.interimInputTranscription?.text;
                                        if (interim) setAppState(prev => ({...prev, interimText: interim}));
                                        const segment = sc.inputTranscription?.text;
                                        if (segment && segment.trim()) {
                                            finalizeCaption(segment);
                                            setAppState(p => ({...p, interimText: ''}));
                                        }
                                        return;
                                    }

                                    // Native-audio model: word fragments arrive as inputTranscription and
                                    // the turn completes after a pause.
                                    const transcript = sc.inputTranscription?.text;
                                    if (transcript) {
                                        cloudTranscriptBuffer += transcript;
                                        setAppState(prev => ({...prev, interimText: cloudTranscriptBuffer}));
                                    }
                                    if (sc.turnComplete && cloudTranscriptBuffer.trim()) {
                                        finalizeCaption(cloudTranscriptBuffer);
                                        cloudTranscriptBuffer = ''; // Reset buffer
                                        setAppState(p => ({...p, interimText: ''}));
                                    }
                                },
                                onclose: () => {
                                    console.log("Gemini Connection Closed");
                                    if (mounted) setTimeout(initGeminiLive, 1000); // Reconnect
                                },
                                onerror: (e) => console.error("Gemini Error", e)
                            }
                        });

                        const session = await sessionPromise;
                        geminiSession = session;

                        // Audio Pipeline
                        // Force 16k context for Gemini, browser handles resampling from native stream
                        const ctx = new AudioContext({ sampleRate: 16000 });
                        // CRITICAL: Force resume in case browser policy suspended it (common in Cloud/Production)
                        if (ctx.state === 'suspended') await ctx.resume();

                        const sourceNode = ctx.createMediaStreamSource(stream!);
                        const processor = ctx.createScriptProcessor(4096, 1, 1);
                        
                        processor.onaudioprocess = (e) => {
                            const inputData = e.inputBuffer.getChannelData(0);
                            const pcmBlob = createPcmBlob(inputData);
                            // Fire and forget send
                            session.sendRealtimeInput({ media: pcmBlob });
                        };

                        sourceNode.connect(processor);
                        processor.connect(ctx.destination);
                        geminiContextRef.current = ctx;

                    } catch (e) {
                        console.error("Gemini Init Failed", e);
                        if(mounted) setTimeout(initGeminiLive, 2000);
                    }
                };

                initGeminiLive();
            }

        } catch (e) {
            console.error("Recording init error", e);
            setAppState(p => ({...p, isRecording: false}));
        }
    };

    startRecording();
    return cleanup;
  }, [appState.isRecording, appState.mode, appState.audioSourceId, appState.apiKey, appState.localServerUrl, appState.cloudModel]);

  const getLastCaptionText = () => {
    const lastCaption = appState.captions.length > 0 ? appState.captions[appState.captions.length - 1] : null;
    let text = lastCaption ? (appState.targetLanguage !== 'en' && lastCaption.translatedText ? lastCaption.translatedText : lastCaption.text) : '';
    if (appState.interimText && appState.targetLanguage === 'en') text += (text ? ' ' : '') + appState.interimText;
    return text;
  };

  const handleEndSession = () => {
      setAppState(prev => ({
          ...prev,
          isRecording: false,
          view: 'analytics'
      }));
  };

  const handleExitAnalytics = () => {
       setAppState(prev => {
          const newSession: Session = {
              id: Date.now().toString(),
              date: Date.now(),
              name: prev.activeContextName || `Session ${new Date().toLocaleDateString()}`,
              stats: prev.stats,
              captions: prev.captions,
              activeContextName: prev.activeContextName
          };
          return {
              ...prev,
              view: 'dashboard',
              pastSessions: [newSession, ...prev.pastSessions],
              captions: [],
              stats: initialStats,
              interimText: '',
              notifications: []
          };
       });
  };

  const handleLaunchOutput = () => {
      // Force save settings before opening
      localStorage.setItem('cc_overlay_settings', JSON.stringify(appState.overlaySettings));
      
      const url = `${window.location.origin}?view=output`;
      window.open(url, 'CaptionOverlay', 'width=1280,height=720,menubar=no,toolbar=no,location=no,status=no');
      setShowOutputModal(false);
  };

  const handleOpenWebApp = () => {
    // In Electron, opening an external URL triggers the default browser
    window.open(getRelayUrl(), '_blank');
  };

  if (appState.view === 'caption_output') {
      return (
        <Overlay 
            currentCaption={getLastCaptionText()} 
            isPartial={!!appState.interimText} 
            settings={appState.overlaySettings}
            onBack={() => setAppState(prev => ({...prev, view: 'dashboard'}))}
            status={relayStatus === 'connected' ? 'connected' : 'disconnected'}
        />
      );
  }

  // @ts-ignore
  if (appState.view === 'audience_view') {
      return (
          <AudienceView 
            onBack={() => setAppState(p => ({...p, view: 'landing'}))}
          />
      );
  }

  if (appState.view === 'local_setup') {
      return (
          <LocalSetup
            onBack={() => setAppState(p => ({...p, view: 'choice'}))}
            onComplete={(whisperUrl, llm) => {
                setAppState(p => ({
                    ...p,
                    localServerUrl: whisperUrl,
                    localLlmUrl: llm?.url || p.localLlmUrl,
                    localLlmModel: llm?.model || p.localLlmModel,
                    mode: llm ? 'fully_local' : 'local',
                    view: 'dashboard',
                }));
            }}
            initialWhisperUrl={appState.localServerUrl}
            initialLlmUrl={appState.localLlmUrl}
            initialLlmModel={appState.localLlmModel}
          />
      );
  }

  // --- NEW: Deployment Choice Screen (Web vs Desktop) ---
  if (appState.view === 'deployment_choice') {
      return (
        <div className="h-screen bg-cream flex flex-col items-center justify-center p-8 animate-fade-in relative">
            <button onClick={() => setAppState(p => ({...p, view: 'landing'}))} className="absolute top-8 left-8 text-stone-500 font-bold flex items-center gap-2"><ArrowRight className="rotate-180" size={16} /> Back</button>
            
            <h1 className="text-4xl font-display font-bold text-forest-dark mb-4">How do you want to run Community Captioner?</h1>
            <p className="text-stone-500 mb-12">Choose the method that best fits your infrastructure.</p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-4xl w-full">
                 
                 {/* Card 1: Local / Desktop App */}
                 <div 
                    onClick={() => {
                        // If already in Electron, just proceed to workflow
                        if (isElectron) {
                            setAppState(p => ({...p, view: 'choice'}));
                        } else {
                            // If in browser, ask to download
                            setAppState(p => ({...p, view: 'download'}));
                        }
                    }}
                    className={`bg-white p-8 rounded-2xl border-2 transition-all group relative overflow-hidden cursor-pointer ${isElectron ? 'border-sage-500 shadow-xl' : 'border-stone-200 hover:border-sage-500 hover:shadow-xl'}`}
                 >
                    <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                         <Monitor size={100} />
                    </div>
                    
                    {isElectron && (
                        <div className="absolute top-4 right-4 bg-sage-100 text-forest-dark px-2 py-1 rounded text-xs font-bold uppercase tracking-wider">
                            Current
                        </div>
                    )}

                    <div className="bg-stone-100 w-16 h-16 rounded-full flex items-center justify-center text-stone-600 mb-6 group-hover:scale-110 transition-transform"><Monitor size={32} /></div>
                    <h2 className="text-2xl font-bold text-stone-800 mb-2">{isElectron ? "Continue in App" : "Desktop App"}</h2>
                    <ul className="space-y-2 text-stone-500 text-sm mt-4">
                        <li className="flex items-center gap-2"><ShieldCheck size={14} className="text-green-500" /> Total Privacy (Local Mode)</li>
                        <li className="flex items-center gap-2"><ShieldCheck size={14} className="text-green-500" /> Works Offline</li>
                        <li className="flex items-center gap-2"><ShieldCheck size={14} className="text-green-500" /> System-wide audio capture</li>
                    </ul>
                 </div>

                 {/* Card 2: Web / Cloud Browser */}
                 <div 
                    onClick={() => {
                         if (isElectron) {
                             handleOpenWebApp();
                         } else {
                             setAppState(p => ({...p, view: 'choice'}));
                         }
                    }} 
                    className="bg-white p-8 rounded-2xl border-2 border-stone-200 hover:border-sage-500 hover:shadow-xl cursor-pointer transition-all group relative overflow-hidden"
                 >
                    <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                        <Globe size={100} />
                    </div>
                    <div className="bg-sage-100 w-16 h-16 rounded-full flex items-center justify-center text-forest-dark mb-6 group-hover:scale-110 transition-transform"><Globe size={32} /></div>
                    <h2 className="text-2xl font-bold text-stone-800 mb-2">{isElectron ? "Open Web Dashboard" : "Run in Browser"}</h2>
                    <ul className="space-y-2 text-stone-500 text-sm mt-4">
                        <li className="flex items-center gap-2"><CheckCircle size={14} className="text-green-500" /> Instant Access (No Install)</li>
                        <li className="flex items-center gap-2"><CheckCircle size={14} className="text-green-500" /> Uses Cloud AI or WebSpeech</li>
                        <li className="flex items-center gap-2">
                             {isElectron ? 
                                <><ExternalLink size={14} className="text-stone-400" /> Launches in Chrome/Safari</> : 
                                <><CheckCircle size={14} className="text-green-500" /> Great for testing & meetings</>
                             }
                        </li>
                    </ul>
                 </div>

            </div>
        </div>
      );
  }

  // --- NEW: Download Instructions Screen ---
  if (appState.view === 'download') {
      return (
        <div className="h-screen bg-stone-900 text-white flex flex-col items-center justify-center p-8 animate-fade-in relative">
             <button onClick={() => setAppState(p => ({...p, view: 'deployment_choice'}))} className="absolute top-8 left-8 text-stone-400 hover:text-white font-bold flex items-center gap-2"><ArrowRight className="rotate-180" size={16} /> Back</button>

             <div className="max-w-2xl w-full text-center">
                 <div className="w-20 h-20 bg-stone-800 rounded-full flex items-center justify-center mx-auto mb-6 text-white border border-white/10">
                     <Monitor size={40} />
                 </div>
                 <h1 className="text-3xl font-display font-bold mb-4">Download Community Captioner</h1>
                 <p className="text-stone-400 mb-10">
                     Grab the prebuilt desktop app for your platform — no install steps, just unzip and launch.
                     <br/>Prefer to build it yourself? The source commands are below.
                 </p>

                 <div className="flex flex-wrap gap-4 justify-center mb-4">
                     <a
                        href={MAC_DOWNLOAD_URL}
                        target="_blank"
                        rel="noreferrer"
                        className="bg-white text-stone-900 px-6 py-3 rounded-lg font-bold hover:bg-stone-200 transition-colors flex items-center gap-2"
                     >
                         <Download size={18} /> Mac (Apple Silicon)
                     </a>
                     <a
                        href={WINDOWS_DOWNLOAD_URL}
                        target="_blank"
                        rel="noreferrer"
                        className="bg-white text-stone-900 px-6 py-3 rounded-lg font-bold hover:bg-stone-200 transition-colors flex items-center gap-2"
                     >
                         <Download size={18} /> Windows (x64)
                     </a>
                 </div>
                 <a
                    href={RELEASES_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-block text-stone-500 hover:text-stone-300 text-sm font-bold mb-10 transition-colors"
                 >
                     All releases →
                 </a>

                 <div className="bg-black p-6 rounded-xl border border-stone-700 text-left mb-8 shadow-2xl">
                     <div className="flex items-center gap-2 text-stone-400 font-bold text-xs uppercase tracking-wider mb-4 border-b border-stone-800 pb-2">
                         <Terminal size={14} /> Build From Source
                     </div>
                     <div className="space-y-4 font-mono text-sm">
                         <div>
                             <p className="text-stone-500 mb-1"># 1. Clone the repository</p>
                             <p className="text-green-400">git clone {GITHUB_CLONE_URL}</p>
                         </div>
                         <div>
                             <p className="text-stone-500 mb-1"># 2. Install dependencies</p>
                             <p className="text-green-400">npm install</p>
                         </div>
                         <div>
                             <p className="text-stone-500 mb-1"># 3. Build the Windows/Mac app</p>
                             <p className="text-green-400">npm run build:app</p>
                         </div>
                     </div>
                 </div>

                 <div className="flex gap-4 justify-center">
                     <a
                        href={GITHUB_REPO_URL}
                        target="_blank"
                        rel="noreferrer"
                        className="text-stone-400 font-bold hover:text-white px-6 py-3 flex items-center gap-2 transition-colors"
                     >
                         <Github size={18} /> View Source
                     </a>
                 </div>
                 
                 <button 
                    onClick={() => setAppState(p => ({...p, view: 'choice'}))}
                    className="mt-8 text-stone-500 font-bold hover:text-stone-400 text-sm"
                 >
                     No thanks, I'll stick with the Web App
                 </button>
             </div>
        </div>
      );
  }

  // --- EXISTING: Web App Workflow Selection (Renamed intent slightly) ---
  if (appState.view === 'choice') {
      return (
          <div className="h-screen bg-cream flex flex-col items-center justify-center p-8 animate-fade-in relative">
              <button onClick={() => setAppState(p => ({...p, view: 'deployment_choice'}))} className="absolute top-8 left-8 text-stone-500 font-bold">Back</button>
              
              <h1 className="text-4xl font-display font-bold text-forest-dark mb-12">Web App Workspace</h1>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6 max-w-7xl w-full">
                  <div onClick={() => setAppState(p => ({...p, view: 'dashboard'}))} className="bg-white p-7 rounded-2xl border-2 border-stone-200 hover:border-sage-500 hover:shadow-xl cursor-pointer transition-all group">
                      <div className="bg-sage-100 w-14 h-14 rounded-full flex items-center justify-center text-forest-dark mb-5 group-hover:scale-110 transition-transform"><Mic size={28} /></div>
                      <h2 className="text-xl font-bold text-stone-800 mb-2">Live Session</h2>
                      <p className="text-stone-500 leading-relaxed text-sm">Real-time captioning. Browser or Cloud mode.</p>
                  </div>

                  {/* Caption Injection workflow (same card style as the others) */}
                  <div
                      onClick={() => setAppState(p => ({...p, view: 'caption_injection'}))}
                      className="bg-white p-7 rounded-2xl border-2 border-stone-200 hover:border-sage-500 hover:shadow-xl cursor-pointer transition-all group"
                  >
                      <div className="bg-sage-100 w-14 h-14 rounded-full flex items-center justify-center text-forest-dark mb-5 group-hover:scale-110 transition-transform"><Zap size={28} /></div>
                      <h2 className="text-xl font-bold text-stone-800 mb-2">Caption Injection</h2>
                      <p className="text-stone-500 leading-relaxed text-sm">Embed CEA-608/708 into your SDI feed for web-presenter passthrough to YouTube.</p>
                      {addonStatus && !addonStatus.loaded && (
                          <div className="mt-3 px-2.5 py-1.5 bg-amber-50 border border-amber-200 text-amber-800 rounded-lg text-[11px] font-medium flex items-center gap-1.5">
                              <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                              Setup required — DeckLink driver not loaded{addonStatus.platform === 'windows' ? ' on Windows' : ''}
                          </div>
                      )}
                  </div>

                  <div onClick={() => setAppState(p => ({...p, view: 'prerecorded'}))} className="bg-white p-7 rounded-2xl border-2 border-stone-200 hover:border-sage-500 hover:shadow-xl cursor-pointer transition-all group">
                      <div className="bg-sage-100 w-14 h-14 rounded-full flex items-center justify-center text-forest-dark mb-5 group-hover:scale-110 transition-transform"><FileVideo size={28} /></div>
                      <h2 className="text-xl font-bold text-stone-800 mb-2">Prerecorded</h2>
                      <p className="text-stone-500 leading-relaxed text-sm">Upload files. Process with Cloud or Local AI.</p>
                  </div>

                  <div onClick={() => setAppState(p => ({...p, view: 'local_setup'}))} className="bg-white p-7 rounded-2xl border-2 border-stone-200 hover:border-sage-500 hover:shadow-xl cursor-pointer transition-all group opacity-75">
                      <div className="bg-stone-100 w-14 h-14 rounded-full flex items-center justify-center text-stone-600 mb-5 group-hover:scale-110 transition-transform"><Server size={28} /></div>
                      <h2 className="text-xl font-bold text-stone-800 mb-2">Connect Local AI</h2>
                      <p className="text-stone-500 leading-relaxed text-sm">Connect this web app to a local Whisper server via WebSocket.</p>
                  </div>
              </div>
          </div>
      );
  }

  return (
    <div className="relative h-screen w-full bg-cream text-forest-dark font-sans overflow-hidden">
      
      {/* Floating Settings Button */}
      <button 
        onClick={() => { setGlobalSettingsTab('general'); setShowGlobalSettings(true); }}
        className="fixed bottom-6 right-6 z-50 bg-white p-4 rounded-full shadow-xl border border-stone-200 text-stone-600 hover:text-forest-dark hover:scale-110 transition-all hover:bg-stone-50"
      >
        <Settings size={28} />
      </button>

      {appState.view === 'landing' && <LandingPage
        onStart={() => {
          // "Start Captioning" jumps straight into the live browser captioning session
          setAppState(p => ({...p, view: 'dashboard'}));
        }}
        onChooseMode={() => {
          // Skip the Desktop vs Cloud choice when running locally (from the .app/.exe)
          // Only show it on cloud-hosted deployments where users might need to download
          const host = window.location.hostname;
          const isLocal = host === 'localhost' || host === '127.0.0.1' || host.startsWith('192.168.') || host.startsWith('10.') || host.startsWith('172.');
          setAppState(p => ({...p, view: isLocal ? 'choice' : 'deployment_choice'}));
        }}
      />}
      
      {appState.view === 'dashboard' && (
        <Dashboard 
            isRecording={appState.isRecording}
            setIsRecording={(v) => setAppState(p => ({...p, isRecording: v}))}
            captions={appState.captions}
            setCaptions={setCaptions}
            interimText={appState.interimText}
            setInterimText={(v) => setAppState(p => ({...p, interimText: v}))}
            dictionary={appState.dictionary}
            setDictionary={setDictionary}
            mode={appState.mode}
            setMode={(v) => setAppState(p => ({...p, mode: v}))}
            audioSourceId={appState.audioSourceId}
            setAudioSourceId={(v) => setAppState(p => ({...p, audioSourceId: v}))}
            stats={appState.stats}
            updateStats={updateStats}
            onOpenContext={() => setShowContextModal(true)}
            onEndSession={handleEndSession}
            openObsView={() => setShowOutputModal(true)}
            targetLanguage={appState.targetLanguage}
            setTargetLanguage={(v) => setAppState(p => ({...p, targetLanguage: v}))}
            goHome={() => setAppState(prev => ({ ...prev, view: 'landing' }))}
            notifications={appState.notifications}
            activeContextName={appState.activeContextName}
            uiLanguage={appState.uiLanguage}
            profanityFilter={appState.profanityFilter}
            currentStream={currentStream}
            onEditCaption={handleEditCaption}
            overlaySettings={appState.overlaySettings}
            cea708Enabled={appState.cea708Enabled}
            editSuggestions={editSuggestions}
            onAcceptEditSuggestion={acceptEditSuggestion}
            onDismissEditSuggestion={dismissEditSuggestion}
            localEngine={localEngine}
            onOpenLocalSetup={() => setAppState(p => ({ ...p, isRecording: false, view: 'local_setup' }))}
        />
      )}

      {appState.view === 'prerecorded' && (
          <PrerecordedStudio 
             onBack={() => setAppState(p => ({...p, view: 'choice'}))}
             onComplete={(captions, file) => setAppState(p => ({
                ...p, 
                captions, 
                uploadedVideoFile: file || null,
                view: 'analytics', 
                activeContextName: 'Prerecorded Session'
             }))}
             dictionary={appState.dictionary}
             apiKey={appState.apiKey}
             localServerUrl={appState.localServerUrl}
          />
      )}

      {appState.view === 'analytics' && (
          <Analytics 
             currentCaptions={appState.captions} 
             currentStats={appState.stats} 
             pastSessions={appState.pastSessions}
             onBack={handleExitAnalytics}
             apiKey={appState.apiKey}
             localLlmUrl={appState.localLlmUrl}
             localLlmModel={appState.localLlmModel}
             isLocalMode={appState.mode === 'fully_local'}
             onAddToCart={(clip) => setAppState(p => ({...p, highlightCart: [...p.highlightCart, clip]}))}
             cartCount={appState.highlightCart.length}
             onOpenStudio={() => setAppState(p => ({...p, view: 'studio'}))}
          />
      )}

      {appState.view === 'studio' && (
          <HighlightStudio
            clips={appState.highlightCart}
            sourceFile={appState.uploadedVideoFile} // In a real app we'd pass this from PrerecordedStudio or allow upload here
            localServerUrl={appState.localServerUrl}
            onBack={() => setAppState(p => ({...p, view: 'analytics'}))}
          />
      )}

      {appState.view === 'caption_injection' && (
          <CaptionInjection
              onBack={() => setAppState(p => ({...p, view: 'choice'}))}
              apiKey={appState.apiKey}
          />
      )}

      <GlobalSettings 
        isOpen={showGlobalSettings} 
        onClose={() => setShowGlobalSettings(false)} 
        appState={appState}
        setAppState={setAppState}
        initialTab={globalSettingsTab}
      />

      {showContextModal && (
          <ContextEngine 
            dictionary={appState.dictionary}
            setDictionary={setDictionary}
            onClose={() => setShowContextModal(false)}
            learningEnabled={appState.learningEnabled}
            setLearningEnabled={(v) => setAppState(p => ({...p, learningEnabled: v}))}
            activeContextName={appState.activeContextName}
            setActiveContextName={(v) => setAppState(p => ({...p, activeContextName: v}))}
            profanityFilter={appState.profanityFilter}
            setProfanityFilter={(v) => setAppState(p => ({...p, profanityFilter: v}))}
            partialResults={appState.partialResults}
            setPartialResults={(v) => setAppState(p => ({...p, partialResults: v}))}
            speakerLabels={appState.speakerLabels}
            setSpeakerLabels={(v) => setAppState(p => ({...p, speakerLabels: v}))}
            apiKey={appState.apiKey}
            contextSettings={appState.contextSettings}
            setContextSettings={(v) => setAppState(p => ({...p, contextSettings: v}))}
          />
      )}

      {showOutputModal && (
          <OutputSettings
             settings={appState.overlaySettings}
             setSettings={(v) => setAppState(p => ({...p, overlaySettings: v}))}
             outputMode={appState.outputMode}
             setOutputMode={(v) => setAppState(p => ({...p, outputMode: v}))}
             onClose={() => setShowOutputModal(false)}
             onLaunch={handleLaunchOutput}
             previewText={getLastCaptionText()}
             cea708Enabled={appState.cea708Enabled}
             setCea708Enabled={(v) => setAppState(p => ({...p, cea708Enabled: v}))}
             onCea708Clear={() => {
                 // Send clear command via the relay WebSocket
                 const relayUrl = getRelayUrl();
                 const ws = new WebSocket(relayUrl);
                 ws.onopen = () => {
                     ws.send(JSON.stringify({ type: 'join', sessionId: 'demo' }));
                     ws.send(JSON.stringify({ type: 'cea708_clear' }));
                     setTimeout(() => ws.close(), 500);
                 };
             }}
          />
      )}
    </div>
  );
}

export default App;