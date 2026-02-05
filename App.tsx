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
import { AppState, Caption, DictionaryEntry, UILanguage, SessionStats, Session, ContextSettings, HighlightClip } from './types';
import { Mic, FileVideo, Settings, Loader2, Server, Globe, Download, Monitor, CheckCircle, ArrowRight, ShieldCheck, Terminal, ExternalLink, Github } from 'lucide-react';
import { GoogleGenAI, LiveServerMessage, Modality } from "@google/genai";
import { translateText } from './services/geminiService';

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
    
    // DEV MODE FIX: If running in Vite Dev (5173), assume relay is on 8080 locally
    if (port === '5173') {
        return `${protocol}//${host}:8080`;
    }

    return `${protocol}//${host}${portSuffix}`;
};

const initialStats: SessionStats = {
    durationSeconds: 0,
    totalWords: 0,
    averageConfidence: 0.95,
    confidenceHistory: [],
    correctionsMade: 0,
    wpmHistory: [],
    recentCorrections: [],
    systemHealth: 'healthy',
    latencyMs: 150,
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
        dictionary: [],
        stats: initialStats,
        mode: 'balanced',
        audioSourceId: '',
        targetLanguage: 'en',
        outputMode: 'browser_overlay',
        overlaySettings,
        learningEnabled: true,
        notifications: [],
        activeContextName: null,
        profanityFilter: false,
        partialResults: true,
        speakerLabels: false,
        uiLanguage: 'en',
        pastSessions: [],
        contextSettings: { sensitivity: 80, acronymExpansion: true, dialect: 'general' },
        // Load config
        apiKey: localStorage.getItem('cc_api_key') || process.env.API_KEY || '',
        localServerUrl: localStorage.getItem('cc_local_url') || 'ws://localhost:9000',
        localLlmUrl: 'http://localhost:11434',
        
        // Video Studio
        uploadedVideoFile: null,
        highlightCart: [],
        
        // RTMP
        rtmpUrl: 'ws://localhost:3000',
        isStreaming: false
    };
  });

  const [showContextModal, setShowContextModal] = useState(false);
  const [showOutputModal, setShowOutputModal] = useState(false);
  const [showGlobalSettings, setShowGlobalSettings] = useState(false);
  const [globalSettingsTab, setGlobalSettingsTab] = useState<'general'|'cloud'|'local'|'guide'>('general');
  const [relayStatus, setRelayStatus] = useState<'connected'|'disconnected'>('disconnected');
  
  // Audio Refs
  const recognitionRef = useRef<any>(null);
  const geminiContextRef = useRef<AudioContext | null>(null);
  const wakeLockRef = useRef<any>(null);
  const keepAliveAudioRef = useRef<HTMLAudioElement | null>(null);
  const resilienceStrategyRef = useRef<string>('browser');

  const [currentStream, setCurrentStream] = useState<MediaStream | null>(null);
  const dictionaryRef = useRef(appState.dictionary);
  const targetLanguageRef = useRef(appState.targetLanguage);
  const profanityRef = useRef(appState.profanityFilter);
  const activeModeRef = useRef(appState.mode);
  const statsRef = useRef(appState.stats);
  const captionsRef = useRef(appState.captions); // Ref for immediate access in callbacks
  const interimRef = useRef(appState.interimText);
  const apiKeyRef = useRef(appState.apiKey);

  // Sync refs
  useEffect(() => { dictionaryRef.current = appState.dictionary; }, [appState.dictionary]);
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


  // Timer Effect
  useEffect(() => {
    let interval: any;
    if (appState.isRecording) {
      interval = setInterval(() => {
        setAppState(prev => {
            const lastWpm = prev.stats.wpmHistory.length > 0 ? prev.stats.wpmHistory[prev.stats.wpmHistory.length - 1].wpm : 0;
            return {
                ...prev,
                stats: {
                    ...prev.stats,
                    durationSeconds: prev.stats.durationSeconds + 1,
                    wpmHistory: prev.stats.durationSeconds % 5 === 0 
                      ? [...prev.stats.wpmHistory, { time: prev.stats.durationSeconds, wpm: lastWpm }]
                      : prev.stats.wpmHistory,
                    latencyMs: Math.floor(100 + Math.random() * 200)
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

  const updateStats = useCallback((newWordCount: number, confidence: number, correctionDetail?: string) => {
      setAppState(prev => {
          const totalConfidence = (prev.stats.averageConfidence * prev.captions.length) + confidence;
          const newAvg = totalConfidence / (prev.captions.length + 1);
          const currentWpm = newWordCount * 12; 
          
          let newNotifications = [...prev.notifications];
          if (correctionDetail) {
             newNotifications.push({ id: Date.now().toString(), message: `Fixed: ${correctionDetail}`, type: 'correction', timestamp: Date.now() });
          }

          const newRecentCorrections = correctionDetail ? [`${correctionDetail}`, ...prev.stats.recentCorrections].slice(0, 10) : prev.stats.recentCorrections;
          return {
              ...prev,
              stats: {
                  ...prev.stats,
                  totalWords: prev.stats.totalWords + newWordCount,
                  averageConfidence: newAvg,
                  confidenceHistory: [...prev.stats.confidenceHistory, { time: prev.stats.durationSeconds, score: newAvg }],
                  correctionsMade: correctionDetail ? prev.stats.correctionsMade + 1 : prev.stats.correctionsMade,
                  wpmHistory: [...prev.stats.wpmHistory, { time: prev.stats.durationSeconds, wpm: currentWpm }],
                  recentCorrections: newRecentCorrections,
                  systemHealth: newAvg < 0.7 ? 'degraded' : 'healthy'
              },
              notifications: newNotifications
          };
      });
  }, []);

  const handleEditCaption = (id: string, newText: string) => {
    setAppState(prev => ({
        ...prev,
        captions: prev.captions.map(c => c.id === id ? { ...c, text: newText, isFinal: true, corrected: true } : c)
    }));
  };

  const processText = (text: string): { final: string, detail: string | null } => {
    let processed = text;
    let detail = null;

    const sortedDict = [...dictionaryRef.current].sort((a, b) => b.original.length - a.original.length);
    for (const entry of sortedDict) {
        const escapedOriginal = entry.original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`\\b${escapedOriginal}\\b`, 'gi');
        if (regex.test(processed)) {
            processed = processed.replace(regex, entry.replacement);
            detail = `${entry.original} → ${entry.replacement}`;
        }
    }

    if (profanityRef.current) {
        const badWords = ['damn', 'hell', 'crap', 'shit', 'fuck'];
        const pattern = new RegExp(`\\b(${badWords.join('|')})\\b`, 'gi');
        processed = processed.replace(pattern, '***');
    }

    return { final: processed, detail };
  };

  // Exposed so audio callbacks can reach it
  const finalizeCaption = (text: string, confidence: number = 0.95) => {
        const { final, detail } = processText(text);
        if (!final.trim()) return;

        const newCaption: Caption = {
            id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            text: final,
            timestamp: Date.now(),
            confidence: confidence,
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
        updateStats(final.split(' ').length, confidence, detail || undefined);
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
        
        setAppState(p => ({...p, interimText: ''}));
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
                        console.log("Local Whisper Connected");
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
                            if (data.text) finalizeCaption(data.text);
                        } catch (err) {}
                    };
                    ws.onerror = (e) => console.error("Local Server Error", e);
                    ws.onclose = () => {
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
                            finalizeCaption(event.results[i][0].transcript, event.results[i][0].confidence);
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

                const initGeminiLive = async () => {
                    try {
                        const ai = new GoogleGenAI({ apiKey: appState.apiKey });
                        const sessionPromise = ai.live.connect({
                            model: 'gemini-2.5-flash-native-audio-preview-12-2025',
                            config: {
                                responseModalities: [Modality.AUDIO], // Audio output required for conversation model
                                inputAudioTranscription: {}, // Enabled without specific model to get user transcript
                                systemInstruction: { parts: [{ text: "You are a transcriber. Listen silently and do not speak." }] }
                            },
                            callbacks: {
                                onopen: () => console.log("Gemini Live Connected"),
                                onmessage: (msg: LiveServerMessage) => {
                                    // Handle Real-time Transcription from Gemini
                                    const transcript = msg.serverContent?.inputTranscription?.text;
                                    if (transcript) {
                                        cloudTranscriptBuffer += transcript;
                                        setAppState(prev => ({...prev, interimText: cloudTranscriptBuffer}));
                                    }
                                    
                                    // If turn completes, flush accumulated buffer to final
                                    if (msg.serverContent?.turnComplete) {
                                        if (cloudTranscriptBuffer.trim()) {
                                            finalizeCaption(cloudTranscriptBuffer);
                                            cloudTranscriptBuffer = ''; // Reset buffer
                                            setAppState(p => ({...p, interimText: ''}));
                                        }
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
  }, [appState.isRecording, appState.mode, appState.audioSourceId, appState.apiKey, appState.localServerUrl]);

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
            onComplete={(llm, whisper) => {
                setAppState(p => ({...p, localLlmUrl: llm, localServerUrl: whisper, mode: 'fully_local', view: 'dashboard'}));
            }}
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
                     To run locally with maximum privacy, you need to build the Electron app.
                     <br/>Since this is an open-source project, you currently build it from source.
                 </p>

                 <div className="bg-black p-6 rounded-xl border border-stone-700 text-left mb-8 shadow-2xl">
                     <div className="flex items-center gap-2 text-stone-400 font-bold text-xs uppercase tracking-wider mb-4 border-b border-stone-800 pb-2">
                         <Terminal size={14} /> Terminal Commands
                     </div>
                     <div className="space-y-4 font-mono text-sm">
                         <div>
                             <p className="text-stone-500 mb-1"># 1. Clone the repository</p>
                             <p className="text-green-400">git clone https://github.com/amateurmenace/community-captioner-5.git</p>
                         </div>
                         <div>
                             <p className="text-stone-500 mb-1"># 2. Install dependencies</p>
                             <p className="text-green-400">npm install</p>
                         </div>
                         <div>
                             <p className="text-stone-500 mb-1"># 3. Build the Windows/Mac Installer</p>
                             <p className="text-green-400">npm run dist</p>
                         </div>
                     </div>
                 </div>

                 <div className="flex gap-4 justify-center">
                     <a 
                        href="https://github.com/amateurmenace/community-captioner-5/releases/latest" 
                        target="_blank"
                        rel="noreferrer"
                        className="bg-white text-stone-900 px-6 py-3 rounded-lg font-bold hover:bg-stone-200 transition-colors flex items-center gap-2"
                     >
                         <Download size={18} /> Download Installer
                     </a>
                     <a 
                        href="https://github.com/amateurmenace/community-captioner-5" 
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
              <div className="grid grid-cols-1 md:grid-cols-3 gap-8 max-w-6xl w-full">
                  <div onClick={() => setAppState(p => ({...p, view: 'dashboard'}))} className="bg-white p-8 rounded-2xl border-2 border-stone-200 hover:border-sage-500 hover:shadow-xl cursor-pointer transition-all group">
                      <div className="bg-sage-100 w-16 h-16 rounded-full flex items-center justify-center text-forest-dark mb-6 group-hover:scale-110 transition-transform"><Mic size={32} /></div>
                      <h2 className="text-2xl font-bold text-stone-800 mb-2">Live Session</h2>
                      <p className="text-stone-500 leading-relaxed">Real-time captioning. Browser or Cloud mode.</p>
                  </div>

                  <div onClick={() => setAppState(p => ({...p, view: 'prerecorded'}))} className="bg-white p-8 rounded-2xl border-2 border-stone-200 hover:border-sage-500 hover:shadow-xl cursor-pointer transition-all group">
                      <div className="bg-sage-100 w-16 h-16 rounded-full flex items-center justify-center text-forest-dark mb-6 group-hover:scale-110 transition-transform"><FileVideo size={32} /></div>
                      <h2 className="text-2xl font-bold text-stone-800 mb-2">Prerecorded</h2>
                      <p className="text-stone-500 leading-relaxed">Upload files. Process with Cloud or Local AI.</p>
                  </div>
                  
                  <div onClick={() => setAppState(p => ({...p, view: 'local_setup'}))} className="bg-white p-8 rounded-2xl border-2 border-stone-200 hover:border-sage-500 hover:shadow-xl cursor-pointer transition-all group opacity-75">
                      <div className="bg-stone-100 w-16 h-16 rounded-full flex items-center justify-center text-stone-600 mb-6 group-hover:scale-110 transition-transform"><Server size={32} /></div>
                      <h2 className="text-2xl font-bold text-stone-800 mb-2">Connect Local AI</h2>
                      <p className="text-stone-500 leading-relaxed">Connect this web app to a local Whisper server via WebSocket.</p>
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

      {appState.view === 'landing' && <LandingPage onStart={() => setAppState(p => ({...p, view: 'deployment_choice'}))} />}
      
      {appState.view === 'dashboard' && (
        <Dashboard 
            isRecording={appState.isRecording}
            setIsRecording={(v) => setAppState(p => ({...p, isRecording: v}))}
            captions={appState.captions}
            setCaptions={setCaptions}
            interimText={appState.interimText}
            setInterimText={(v) => setAppState(p => ({...p, interimText: v}))}
            dictionary={appState.dictionary}
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
          />
      )}
    </div>
  );
}

export default App;