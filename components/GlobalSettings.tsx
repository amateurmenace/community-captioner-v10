import React, { useState, useEffect } from 'react';
import { X, Globe, Key, Cpu, Settings, Cloud, Server, Terminal, ShieldCheck, BookOpen, AlertCircle, Loader2, Check } from 'lucide-react';
import { AppState, UILanguage } from '../types';
import { GoogleGenAI } from "@google/genai";

interface GlobalSettingsProps {
  isOpen: boolean;
  onClose: () => void;
  appState: AppState;
  setAppState: React.Dispatch<React.SetStateAction<AppState>>;
  initialTab?: 'general' | 'cloud' | 'local' | 'guide';
}

type ConnectionStatus = 'idle' | 'testing' | 'success' | 'error';

const GlobalSettings: React.FC<GlobalSettingsProps> = ({ isOpen, onClose, appState, setAppState, initialTab = 'general' }) => {
  const [activeTab, setActiveTab] = useState<'general' | 'cloud' | 'local' | 'guide'>(initialTab);
  const [apiKeyInput, setApiKeyInput] = useState(appState.apiKey || '');
  const [localUrlInput, setLocalUrlInput] = useState(appState.localServerUrl || 'ws://localhost:9000');
  
  // Connection States
  const [cloudStatus, setCloudStatus] = useState<ConnectionStatus>('idle');
  const [localStatus, setLocalStatus] = useState<ConnectionStatus>('idle');
  const [statusMessage, setStatusMessage] = useState('');

  useEffect(() => {
      if (isOpen) setActiveTab(initialTab);
  }, [isOpen, initialTab]);

  if (!isOpen) return null;

  // --- Connection Tests ---
  const testCloudConnection = async () => {
      if (!apiKeyInput) {
          setCloudStatus('error');
          setStatusMessage('API Key is missing');
          return;
      }
      setCloudStatus('testing');
      setStatusMessage('');
      try {
          const ai = new GoogleGenAI({ apiKey: apiKeyInput });
          await ai.models.generateContent({
              model: "gemini-3-flash-preview",
              contents: "ping",
          });
          setCloudStatus('success');
          setStatusMessage('Connected to Gemini API successfully.');
      } catch (e: any) {
          setCloudStatus('error');
          setStatusMessage(e.message || "Invalid API Key or Network Error");
      }
  };

  const testLocalConnection = () => {
      setLocalStatus('testing');
      setStatusMessage('');
      
      try {
          const ws = new WebSocket(localUrlInput);
          
          ws.onopen = () => {
              setLocalStatus('success');
              setStatusMessage('Connected to Whisper Server successfully.');
              ws.close();
          };
          
          ws.onerror = () => {
              setLocalStatus('error');
              setStatusMessage('Connection refused. Is the server running?');
          };

      } catch (e) {
          setLocalStatus('error');
          setStatusMessage('Invalid URL format.');
      }
  };

  const saveSettings = () => {
      setAppState(prev => ({
          ...prev,
          apiKey: apiKeyInput,
          localServerUrl: localUrlInput
      }));
      localStorage.setItem('cc_api_key', apiKeyInput);
      localStorage.setItem('cc_local_url', localUrlInput);
      onClose();
  };

  const StatusIndicator = ({ status, msg }: { status: ConnectionStatus, msg: string }) => {
      if (status === 'idle') return null;
      return (
          <div className={`mt-3 p-3 rounded-lg flex items-start gap-3 text-sm ${status === 'success' ? 'bg-green-50 text-green-800 border border-green-200' : status === 'error' ? 'bg-red-50 text-red-800 border border-red-200' : 'bg-blue-50 text-blue-800'}`}>
              {status === 'testing' && <Loader2 size={16} className="animate-spin shrink-0 mt-0.5" />}
              {status === 'success' && <ShieldCheck size={16} className="shrink-0 mt-0.5" />}
              {status === 'error' && <AlertCircle size={16} className="shrink-0 mt-0.5" />}
              <div>
                  <span className="font-bold block">{status === 'testing' ? 'Testing Connection...' : status === 'success' ? 'System Ready' : 'Connection Failed'}</span>
                  {msg && <span className="opacity-90 text-xs">{msg}</span>}
              </div>
          </div>
      );
  };

  return (
    <div className="fixed inset-0 z-[60] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="bg-stone-50 border-b border-stone-200 p-4 flex justify-between items-center shrink-0">
             <h2 className="font-display font-bold text-lg text-forest-dark flex items-center gap-2">
                <Settings size={20} className="text-sage-600" /> Application Settings
             </h2>
             <button onClick={onClose} className="p-1 hover:bg-stone-200 rounded-full transition-colors"><X size={20} className="text-stone-500" /></button>
        </div>
        
        <div className="flex flex-1 overflow-hidden">
            {/* Sidebar */}
            <div className="w-56 bg-stone-50 border-r border-stone-200 p-4 flex flex-col gap-2 shrink-0 overflow-y-auto">
                <button onClick={() => setActiveTab('general')} className={`text-left px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-2 ${activeTab === 'general' ? 'bg-white shadow-sm text-forest-dark' : 'text-stone-500 hover:bg-stone-100'}`}>
                    <Globe size={16} /> General
                </button>
                <button onClick={() => setActiveTab('guide')} className={`text-left px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-2 ${activeTab === 'guide' ? 'bg-white shadow-sm text-forest-dark' : 'text-stone-500 hover:bg-stone-100'}`}>
                    <Terminal size={16} /> Build Guide
                </button>
                <div className="h-px bg-stone-200 my-2"></div>
                <button onClick={() => setActiveTab('cloud')} className={`text-left px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-2 ${activeTab === 'cloud' ? 'bg-white shadow-sm text-forest-dark' : 'text-stone-500 hover:bg-stone-100'}`}>
                    <Cloud size={16} /> Cloud Access
                </button>
                <button onClick={() => setActiveTab('local')} className={`text-left px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-2 ${activeTab === 'local' ? 'bg-white shadow-sm text-forest-dark' : 'text-stone-500 hover:bg-stone-100'}`}>
                    <Server size={16} /> Local AI
                </button>
            </div>

            {/* Content */}
            <div className="flex-1 p-8 overflow-y-auto bg-white custom-scrollbar">
                {activeTab === 'general' && (
                    <div className="space-y-6">
                        <div>
                            <label className="text-xs font-bold text-stone-400 uppercase tracking-wider mb-2 block">Interface Language</label>
                            <div className="flex items-center gap-3 p-3 border border-stone-200 rounded-xl bg-white">
                                <Globe size={20} className="text-forest-dark" />
                                <select 
                                    value={appState.uiLanguage}
                                    onChange={(e) => setAppState(p => ({...p, uiLanguage: e.target.value as UILanguage}))}
                                    className="bg-transparent font-bold text-stone-700 w-full outline-none"
                                >
                                    <option value="en">English</option>
                                    <option value="es">Español</option>
                                    <option value="fr">Français</option>
                                </select>
                            </div>
                        </div>
                        <div>
                             <label className="text-xs font-bold text-stone-400 uppercase tracking-wider mb-2 block">Current Runtime</label>
                             <div className="p-4 bg-sage-50 rounded-xl border border-sage-200 flex items-center gap-4">
                                 <div className="bg-white p-2 rounded-lg shadow-sm text-sage-600">
                                     <Cpu size={24} />
                                 </div>
                                 <div>
                                     <div className="font-bold text-forest-dark">
                                         {appState.mode === 'cloud' ? 'Cloud (Gemini)' : 
                                          appState.mode === 'local' ? 'Local Server' : 'Browser (Balanced)'}
                                     </div>
                                     <div className="text-xs text-stone-500">
                                         {window.location.hostname === 'localhost' ? 'Localhost Deployment' : 'Production Build'}
                                     </div>
                                 </div>
                             </div>
                        </div>
                    </div>
                )}

                {activeTab === 'guide' && (
                    <div className="space-y-8 animate-fade-in">
                        <div className="bg-stone-900 rounded-xl p-6 text-white font-mono">
                            <h3 className="text-lg font-bold mb-4 flex items-center gap-2"><Terminal size={20} /> Terminal Commands</h3>
                            <p className="text-stone-400 text-sm mb-6">Run these commands in your project folder to build the application.</p>
                            
                            <div className="space-y-6">
                                <div>
                                    <div className="text-xs text-stone-500 mb-2 uppercase tracking-widest font-bold">1. Install Dependencies</div>
                                    <div className="bg-black p-3 rounded border border-stone-700 flex justify-between items-center group">
                                        <code>npm install</code>
                                        <button onClick={() => navigator.clipboard.writeText("npm install")} className="opacity-0 group-hover:opacity-100 text-xs bg-stone-800 px-2 py-1 rounded">Copy</button>
                                    </div>
                                </div>
                                
                                <div>
                                    <div className="text-xs text-stone-500 mb-2 uppercase tracking-widest font-bold">2. Build Installer (EXE)</div>
                                    <div className="bg-black p-3 rounded border border-stone-700 flex justify-between items-center group">
                                        <code>npm run dist</code>
                                        <button onClick={() => navigator.clipboard.writeText("npm run dist")} className="opacity-0 group-hover:opacity-100 text-xs bg-stone-800 px-2 py-1 rounded">Copy</button>
                                    </div>
                                </div>
                                
                                <div>
                                    <div className="text-xs text-stone-500 mb-2 uppercase tracking-widest font-bold">3. Run Dev Mode</div>
                                    <div className="bg-black p-3 rounded border border-stone-700 flex justify-between items-center group">
                                        <code>npm run dev</code>
                                        <button onClick={() => navigator.clipboard.writeText("npm run dev")} className="opacity-0 group-hover:opacity-100 text-xs bg-stone-800 px-2 py-1 rounded">Copy</button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {activeTab === 'cloud' && (
                    <div className="space-y-6">
                        <div>
                            <h3 className="text-lg font-bold text-forest-dark mb-2">Google Gemini API</h3>
                            <p className="text-sm text-stone-500 mb-4">Required for "Cloud Mode" and "Resilience Mode".</p>
                            
                            <label className="text-xs font-bold text-stone-400 uppercase tracking-wider mb-2 block">API Key</label>
                            <div className="flex gap-2">
                                <div className="flex-1 flex items-center gap-3 p-3 border border-stone-200 rounded-xl bg-white focus-within:ring-2 focus-within:ring-sage-400 transition-all shadow-sm">
                                    <Key size={20} className="text-forest-dark" />
                                    <input 
                                        type="password"
                                        value={apiKeyInput}
                                        onChange={(e) => {
                                            setApiKeyInput(e.target.value);
                                            setCloudStatus('idle');
                                        }}
                                        placeholder="AIzaSy..."
                                        className="w-full bg-transparent outline-none font-mono text-sm text-stone-800 placeholder:text-stone-400"
                                    />
                                </div>
                                <button 
                                    onClick={testCloudConnection}
                                    disabled={cloudStatus === 'testing' || !apiKeyInput}
                                    className="bg-stone-100 hover:bg-stone-200 text-stone-600 px-4 rounded-xl font-bold text-sm transition-colors disabled:opacity-50"
                                >
                                    Test
                                </button>
                            </div>
                            
                            <StatusIndicator status={cloudStatus} msg={statusMessage} />
                        </div>
                    </div>
                )}

                {activeTab === 'local' && (
                    <div className="space-y-8">
                        <div>
                            <h3 className="text-lg font-bold text-forest-dark mb-2">Local Whisper Server</h3>
                            <p className="text-sm text-stone-500 mb-4">Connect to a Whisper ASR WebSocket server running on your machine.</p>
                            
                            <label className="text-xs font-bold text-stone-400 uppercase tracking-wider mb-2 block">Server URL</label>
                            <div className="flex gap-2">
                                <div className="flex-1 flex items-center gap-3 p-3 border border-stone-200 rounded-xl bg-white focus-within:ring-2 focus-within:ring-sage-400 transition-all shadow-sm">
                                    <Server size={20} className="text-forest-dark" />
                                    <input 
                                        type="text"
                                        value={localUrlInput}
                                        onChange={(e) => {
                                            setLocalUrlInput(e.target.value);
                                            setLocalStatus('idle');
                                        }}
                                        placeholder="ws://localhost:9000"
                                        className="w-full bg-transparent outline-none font-mono text-sm text-stone-800 placeholder:text-stone-400"
                                    />
                                </div>
                                <button 
                                    onClick={testLocalConnection}
                                    disabled={localStatus === 'testing' || !localUrlInput}
                                    className="bg-stone-100 hover:bg-stone-200 text-stone-600 px-4 rounded-xl font-bold text-sm transition-colors disabled:opacity-50"
                                >
                                    Test
                                </button>
                            </div>

                            <StatusIndicator status={localStatus} msg={statusMessage} />
                        </div>
                    </div>
                )}
            </div>
        </div>

        <div className="p-4 border-t border-stone-200 bg-stone-50 flex justify-end">
            <button onClick={saveSettings} className="bg-forest-dark text-white px-6 py-2 rounded-lg font-bold hover:bg-forest-light transition-colors flex items-center gap-2">
                <Check size={16} /> Save Changes
            </button>
        </div>
      </div>
    </div>
  );
};

export default GlobalSettings;