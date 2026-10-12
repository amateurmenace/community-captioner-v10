
export interface Caption {
  id: string;
  text: string;
  translatedText?: string;
  timestamp: number;
  confidence: number;
  isFinal: boolean;
  speaker?: string;
  corrected?: boolean;
}

export interface DictionaryEntry {
  original: string;
  replacement: string;
  type: 'proper_noun' | 'place' | 'correction' | 'acronym';
  sensitivity?: number; // 0-1
  /** Role, expansion or context shown in the UI (e.g. "Select Board Chair", "Department of Public Works") */
  note?: string;
  /** Where the entry came from: wizard, pdf, paste, url, names, auto_learned, manual */
  source?: string;
}

export interface Notification {
  id: string;
  message: string;
  type: 'correction' | 'learning' | 'system' | 'error' | 'mode_switch';
  timestamp: number;
}

export interface SessionStats {
  durationSeconds: number;
  totalWords: number;
  /** Mean of the recognizer's confidence scores (only engines that report one, e.g. Web Speech) */
  averageConfidence: number;
  /** How many captions contributed a real confidence score; 0 → show "—" */
  confidenceSamples?: number;
  confidenceHistory: { time: number; score: number }[];
  correctionsMade: number;
  /** Rolling words-per-minute over the last 60 seconds, sampled every 5 s */
  wpmHistory: { time: number; wpm: number }[];
  recentCorrections: string[];
  systemHealth: 'healthy' | 'degraded' | 'offline';
  /** Measured end-of-speech → final caption delay (EMA, ms); 0 until the first measurement */
  latencyMs: number;
  latencySamples?: number;
  modeSwitches?: { from: string; to: string; time: number }[];
}

/** Which Gemini Live model Cloud mode uses */
export type CloudModel = 'transcribe-live' | 'native-audio';

/** Live status of the local speech server connection (Local / Fully Local modes) */
export interface LocalEngineInfo {
    connected: boolean;
    /** Set while the app is bringing the speech server up ("Starting the speech server…") */
    starting?: string;
    backend?: string;   // "mlx-whisper" | "faster-whisper" | legacy
    model?: string;
    device?: string;
    compute?: string;
    url?: string;
    error?: string;
}

export interface Session {
  id: string;
  date: number;
  name: string;
  stats: SessionStats;
  captions: Caption[];
  activeContextName: string | null;
}

export type OperationMode = 'balanced' | 'local' | 'resilience' | 'cloud' | 'fully_local';

export interface OverlaySettings {
  fontFamily: string;
  fontSize: number; // in px
  color: string;
  backgroundColor: string;
  // Position is now relative percentage 0-100
  x: number; 
  y: number;
  width: number;
  maxLines: number;
  textAlign: 'left' | 'center' | 'right';
}

export interface AudioDevice {
    deviceId: string;
    label: string;
}

export type UILanguage = 'en' | 'es' | 'fr';

export interface ContextSettings {
    sensitivity: number; // 0-100
    acronymExpansion: boolean;
    dialect: 'general' | 'medical' | 'legal';
}

export interface HighlightClip {
    id: string;
    start: number; // ms
    end: number; // ms
    text: string;
    padding: number; // ms
}

export interface AppState {
  view: 'landing' | 'deployment_choice' | 'download' | 'choice' | 'dashboard' | 'prerecorded' | 'analytics' | 'context' | 'caption_output' | 'studio' | 'local_setup' | 'caption_injection';
  isRecording: boolean;
  captions: Caption[];
  interimText: string; // Lifted state for real-time preview
  dictionary: DictionaryEntry[];
  stats: SessionStats;
  mode: OperationMode;
  audioSourceId: string;
  targetLanguage: string;
  overlaySettings: OverlaySettings;
  outputMode: 'browser_overlay' | 'rtmp_embed' | 'sdi_cea708';
  learningEnabled: boolean;
  notifications: Notification[];
  activeContextName: string | null;
  profanityFilter: boolean;
  contextSettings: ContextSettings; 
  partialResults: boolean;
  speakerLabels: boolean;
  uiLanguage: UILanguage;
  pastSessions: Session[];
  // User Config
  apiKey?: string;
  localServerUrl?: string; // Whisper
  localLlmUrl?: string; // Ollama (new)
  localLlmModel?: string; // Ollama model for the Context Engine (default: qwen3:4b)
  cloudModel?: CloudModel; // Cloud mode recognizer (default: transcribe-live)
  
  // Video Studio
  uploadedVideoFile: File | null;
  highlightCart: HighlightClip[];
  
  // RTMP
  rtmpUrl?: string;
  isStreaming: boolean;

  // CEA-708 SDI Bridge
  cea708Enabled: boolean;
}

// DeckLink native integration (available when running in Electron with addon)
export interface DeckLinkDevice {
    name: string;
    index: number;
    hasInput: boolean;
    hasOutput: boolean;
    displayModes?: DeckLinkDisplayMode[];
}

export interface DeckLinkDisplayMode {
    name: string;
    mode: number;
    width: number;
    height: number;
    fps: number;
}

export interface DeckLinkStatus {
    running: boolean;
    mode: 'standalone' | 'passthrough' | 'ndi_passthrough' | 'stopped';
    framesOutput: number;
    droppedFrames: number;
    frameRate?: string;
}

// Declare window.decklink (injected by Electron preload)
declare global {
    interface Window {
        decklink?: {
            available: boolean;
            enumerateDevices: () => Promise<DeckLinkDevice[]>;
            startOutput: (opts: { deviceIndex: number; displayMode: number; frameRate?: string }) => Promise<boolean>;
            startPassthrough: (opts: { inputDevice: number; outputDevice: number; displayMode: number; frameRate?: string }) => Promise<boolean>;
            stop: () => Promise<void>;
            getStatus: () => Promise<DeckLinkStatus>;
            clearCaptions: () => Promise<void>;
        };
    }
}

export enum ProcessingStatus {
  IDLE = 'idle',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  ERROR = 'error'
}