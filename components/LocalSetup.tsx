import React, { useState } from 'react';
import { Server, CheckCircle, AlertCircle, ArrowRight, ArrowLeft, Terminal, Cpu, Download, RefreshCw, XCircle, Monitor, Command, Copy, ExternalLink, Zap, Target, Layers, Rocket, Code, Box, FileDown, Play, HelpCircle, AlertTriangle } from 'lucide-react';
import { checkOllamaConnection } from '../services/localAIService';

interface LocalSetupProps {
    onBack: () => void;
    onComplete: (llmUrl: string, whisperUrl: string) => void;
    initialLlmUrl?: string;
    initialWhisperUrl?: string;
}

const LocalSetup: React.FC<LocalSetupProps> = ({ onBack, onComplete, initialLlmUrl, initialWhisperUrl }) => {
    const [step, setStep] = useState(1);
    const [os, setOs] = useState<'mac' | 'windows'>('mac'); // Default to Mac since user mentioned it
    const [llmUrl, setLlmUrl] = useState(initialLlmUrl || 'http://127.0.0.1:11434');
    const [whisperUrl, setWhisperUrl] = useState(initialWhisperUrl || 'ws://127.0.0.1:9000');
    
    // Model Config
    const [modelSize, setModelSize] = useState<'tiny' | 'base' | 'small' | 'medium' | 'large-v3-turbo'>('base');
    const [device, setDevice] = useState<'cpu' | 'cuda' | 'mps'>('mps');
    
    // Detailed Status State
    const [globalStatus, setGlobalStatus] = useState<'idle' | 'testing' | 'success' | 'fail'>('idle');
    const [llmStatus, setLlmStatus] = useState<'unknown' | 'success' | 'fail'>('unknown');
    const [whisperStatus, setWhisperStatus] = useState<'unknown' | 'success' | 'fail'>('unknown');

    const copyToClipboard = (text: string) => {
        navigator.clipboard.writeText(text);
    };

    const testConnections = async () => {
        setGlobalStatus('testing');
        setLlmStatus('unknown');
        setWhisperStatus('unknown');
        
        // 1. Test LLM
        const llmOk = await checkOllamaConnection(llmUrl);
        setLlmStatus(llmOk ? 'success' : 'fail');
        
        // 2. Test Whisper
        let whisperOk = false;
        try {
            const ws = new WebSocket(whisperUrl);
            await new Promise((resolve, reject) => {
                ws.onopen = () => { whisperOk = true; ws.close(); resolve(true); };
                ws.onerror = () => { whisperOk = false; resolve(false); };
                setTimeout(() => { if(!whisperOk) resolve(false); }, 2000);
            });
        } catch(e) { whisperOk = false; }
        setWhisperStatus(whisperOk ? 'success' : 'fail');

        // Final Decision
        if (llmOk && whisperOk) {
            setGlobalStatus('success');
            setTimeout(() => onComplete(llmUrl, whisperUrl), 1000);
        } else {
            setGlobalStatus('fail');
        }
    };

    const StatusIcon = ({ status }: { status: 'unknown' | 'success' | 'fail' }) => {
        if (status === 'success') return <CheckCircle size={18} className="text-green-500" />;
        if (status === 'fail') return <XCircle size={18} className="text-red-500" />;
        return <div className="w-4 h-4 rounded-full border-2 border-stone-200"></div>;
    };

    const CodeBlock = ({ label, cmd }: { label: string, cmd: string }) => (
        <div className="mb-4 w-full">
            <div className="flex justify-between text-[10px] text-stone-400 mb-1 uppercase font-bold tracking-wider">
                <span>{label}</span>
                <button onClick={() => copyToClipboard(cmd)} className="flex items-center gap-1 hover:text-forest-dark transition-colors"><Copy size={10} /> Copy</button>
            </div>
            <div className="bg-stone-900 text-green-400 p-3 rounded-lg font-mono text-xs overflow-x-auto border border-stone-700 shadow-inner select-all whitespace-pre-wrap leading-relaxed">
                {cmd}
            </div>
        </div>
    );

    // Python Script Updated for Mac Apple Silicon (MPS)
    const pythonScript = `import asyncio
import websockets
import numpy as np
import torch
import whisper
import json
import sys
import os

# --- CONFIGURATION ---
PORT = 9000
MODEL_SIZE = "${modelSize}" 

print(f"--- Community Captioner Local Server ---")
print(f"--- System Diagnostics ---")
print(f"PyTorch Version: {torch.__version__}")

# Robust Device Selection
if torch.backends.mps.is_available():
    DEVICE = "mps"
    print("✅ Apple Silicon (MPS) Detected! Using Metal Acceleration.")
elif torch.cuda.is_available():
    DEVICE = "cuda"
    print(f"✅ NVIDIA GPU (CUDA) Detected: {torch.cuda.get_device_name(0)}")
else:
    DEVICE = "cpu"
    print("⚠️  No GPU detected. Running on CPU (slower).")

print(f"--------------------------")
print(f"Loading Model: {MODEL_SIZE}")
print(f"Running on: {DEVICE}")

try:
    # Load the model
    model = whisper.load_model(MODEL_SIZE, device=DEVICE)
except Exception as e:
    print(f"❌ CRITICAL ERROR LOADING MODEL: {e}")
    print("Tip: If you see 'ffmpeg' error, ensure ffmpeg is installed and in your PATH.")
    sys.exit(1)

print(f"✅ Server ready! Listening on 0.0.0.0:{PORT}")
print(f"👉 App Connection URL: ws://127.0.0.1:{PORT}")

async def echo(websocket):
    print("Client connected!")
    buffer = np.array([], dtype=np.float32)
    
    try:
        async for message in websocket:
            # Incoming audio is 16kHz 16-bit PCM mono. Convert to float32.
            data = np.frombuffer(message, dtype=np.int16).flatten().astype(np.float32) / 32768.0
            buffer = np.concatenate((buffer, data))
            
            # Process every 2 seconds
            if len(buffer) > 16000 * 2:
                # Transcribe
                # FP16 is often supported on CUDA and MPS, but fallback to FP32 if issues arise
                try:
                    result = model.transcribe(buffer, fp16=False, language="en")
                    text = result["text"].strip()
                    if text:
                        print(f"Caption: {text}")
                        await websocket.send(json.dumps({"text": text}))
                except Exception as e:
                    print(f"Inference Error: {e}")
                
                # Keep last 0.5s context to avoid cutting words
                buffer = buffer[-8000:] 
    except websockets.exceptions.ConnectionClosed:
        print("Client disconnected")
    except Exception as e:
        print(f"Error processing audio: {e}")

async def main():
    # Bind to 0.0.0.0 to support both localhost and network IP
    async with websockets.serve(echo, "0.0.0.0", PORT):
        await asyncio.Future() # run forever

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("Server stopped.")`;

    // Generate installation command based on device selection and OS
    let installCommand = "";
    
    if (os === 'mac') {
        installCommand = "pip3 install torch torchvision torchaudio openai-whisper websockets numpy";
    } else {
        // Windows/Linux
        const cmdSeparator = '; ';
        installCommand = device === 'cuda' 
            ? `pip uninstall -y torch torchvision torchaudio${cmdSeparator}pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121${cmdSeparator}pip install openai-whisper websockets numpy`
            : "pip install torch torchvision torchaudio openai-whisper websockets numpy";
    }

    return (
        <div className="h-full bg-cream p-6 flex flex-col items-center justify-center font-sans overflow-y-auto">
            <div className="max-w-5xl w-full bg-white rounded-3xl shadow-2xl p-8 border border-stone-200 relative overflow-hidden my-auto">
                {/* Background Decor */}
                <div className="absolute top-0 right-0 w-64 h-64 bg-sage-50 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2 pointer-events-none"></div>

                {/* Header */}
                <div className="relative z-10">
                    <button onClick={onBack} className="flex items-center gap-2 text-stone-400 hover:text-forest-dark font-bold text-xs mb-6 transition-colors uppercase tracking-wider">
                        <ArrowLeft size={14} /> Cancel Setup
                    </button>
                    
                    <div className="flex flex-col md:flex-row justify-between items-start md:items-end mb-8 gap-4">
                        <div>
                            <h1 className="text-3xl font-display font-bold text-forest-dark mb-2">Local Privacy Stack</h1>
                            <p className="text-stone-500 max-w-md text-sm">Run the entire captioning pipeline on your own hardware.<br/>No internet required. Zero data leaks.</p>
                        </div>
                        <div className="bg-stone-100 p-1 rounded-lg flex gap-1 shrink-0">
                            <button 
                                onClick={() => { setOs('mac'); setDevice('mps'); }}
                                className={`px-4 py-1.5 rounded-md text-xs font-bold flex items-center gap-2 transition-all ${os === 'mac' ? 'bg-white shadow text-forest-dark' : 'text-stone-400 hover:text-stone-600'}`}
                            >
                                <Command size={14} /> macOS
                            </button>
                            <button 
                                onClick={() => { setOs('windows'); setDevice('cuda'); }}
                                className={`px-4 py-1.5 rounded-md text-xs font-bold flex items-center gap-2 transition-all ${os === 'windows' ? 'bg-white shadow text-forest-dark' : 'text-stone-400 hover:text-stone-600'}`}
                            >
                                <Monitor size={14} /> Windows
                            </button>
                        </div>
                    </div>

                    {/* Progress Stepper */}
                    <div className="flex gap-4 mb-8">
                        <div 
                            onClick={() => setStep(1)}
                            className={`flex-1 p-4 rounded-xl border-2 transition-all cursor-pointer relative overflow-hidden group ${step === 1 ? 'border-sage-500 bg-sage-50' : 'border-stone-100 bg-white hover:border-sage-200'}`}
                        >
                            <div className="flex justify-between items-start mb-2">
                                <Cpu size={24} className={step === 1 ? "text-forest-dark" : "text-stone-300"} />
                                <StatusIcon status={llmStatus} />
                            </div>
                            <div className="font-bold text-forest-dark text-sm">1. The Brain</div>
                            <div className="text-xs text-stone-500">Ollama (Llama 3)</div>
                        </div>
                        <div 
                            onClick={() => setStep(2)}
                            className={`flex-1 p-4 rounded-xl border-2 transition-all cursor-pointer relative overflow-hidden group ${step === 2 ? 'border-sage-500 bg-sage-50' : 'border-stone-100 bg-white hover:border-sage-200'}`}
                        >
                            <div className="flex justify-between items-start mb-2">
                                <Server size={24} className={step === 2 ? "text-forest-dark" : "text-stone-300"} />
                                <StatusIcon status={whisperStatus} />
                            </div>
                            <div className="font-bold text-forest-dark text-sm">2. The Ears</div>
                            <div className="text-xs text-stone-500">Whisper Server</div>
                        </div>
                    </div>

                    {/* STEP 1: OLLAMA */}
                    {step === 1 && (
                        <div className="animate-fade-in">
                            <div className="bg-stone-50 p-6 rounded-xl border border-stone-200 mb-6">
                                <div className="flex justify-between items-start mb-4">
                                    <div>
                                        <h3 className="font-bold text-lg text-forest-dark">Install Ollama</h3>
                                        <p className="text-xs text-stone-500">This runs the "Language Model" that summarizes text and corrects spelling.</p>
                                    </div>
                                    <span className="bg-white border border-stone-200 px-2 py-1 rounded text-[10px] font-bold text-stone-400">PORT 11434</span>
                                </div>
                                
                                {os === 'mac' ? (
                                    <>
                                        <CodeBlock label="1. Download & Install (Terminal)" cmd="brew install ollama" />
                                        <CodeBlock label="2. Start Model" cmd="ollama run llama3" />
                                    </>
                                ) : (
                                    <>
                                        <div className="bg-white p-4 rounded-lg border border-stone-200 mb-4 flex items-center justify-between">
                                            <div>
                                                <div className="font-bold text-sm text-stone-700">1. Download Installer</div>
                                                <div className="text-xs text-stone-400">Get OllamaSetup.exe from the official site.</div>
                                            </div>
                                            <a href="https://ollama.com/download/windows" target="_blank" rel="noreferrer" className="bg-stone-100 hover:bg-stone-200 text-stone-700 px-4 py-2 rounded-lg text-xs font-bold flex items-center gap-2">
                                                Download <ExternalLink size={12} />
                                            </a>
                                        </div>
                                        <p className="text-xs text-stone-500 mb-2 font-bold uppercase tracking-wider">2. Run in PowerShell</p>
                                        <CodeBlock label="Start Model" cmd="ollama run llama3" />
                                    </>
                                )}
                                
                                <div className="mt-4 pt-4 border-t border-stone-200 flex items-center gap-4">
                                    <div className="flex-1">
                                        <label className="text-[10px] font-bold text-stone-400 uppercase tracking-wider block mb-1">Local URL</label>
                                        <input 
                                            value={llmUrl} 
                                            onChange={e => { setLlmUrl(e.target.value); setLlmStatus('unknown'); }}
                                            className="w-full bg-white text-stone-900 border border-stone-200 rounded p-2 text-sm font-mono focus:border-sage-500 outline-none" 
                                        />
                                    </div>
                                    <button onClick={() => { checkOllamaConnection(llmUrl).then(ok => setLlmStatus(ok ? 'success' : 'fail')) }} className="mt-5 text-xs font-bold underline text-stone-500 hover:text-forest-dark">Check Now</button>
                                </div>
                            </div>
                            <div className="flex justify-end">
                                <button onClick={() => setStep(2)} className="bg-forest-dark text-white px-8 py-3 rounded-xl font-bold hover:bg-forest-light shadow-lg flex items-center gap-2">
                                    Next: Audio Server <ArrowRight size={18} />
                                </button>
                            </div>
                        </div>
                    )}

                    {/* STEP 2: WHISPER (PYTHON) */}
                    {step === 2 && (
                         <div className="animate-fade-in">
                            {/* Configuration */}
                            <div className="flex gap-6 mb-6">
                                <div className="flex-1">
                                    <label className="text-[10px] font-bold text-stone-400 uppercase tracking-wider block mb-2">Model Size</label>
                                    <div className="flex bg-stone-100 rounded-lg p-1">
                                        {['tiny', 'base', 'small', 'medium', 'large-v3-turbo'].map((s) => (
                                            <button 
                                                key={s} 
                                                onClick={() => setModelSize(s as any)}
                                                className={`flex-1 py-2 text-xs font-bold rounded-md capitalize transition-all ${modelSize === s ? 'bg-white shadow text-forest-dark' : 'text-stone-500 hover:text-stone-700'}`}
                                            >
                                                {s.replace('-v3-turbo', '+')}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                                <div>
                                    <label className="text-[10px] font-bold text-stone-400 uppercase tracking-wider block mb-2">Hardware</label>
                                    <div className="flex bg-stone-100 rounded-lg p-1">
                                        {os === 'mac' && (
                                            <button 
                                                className={`px-4 py-2 text-xs font-bold rounded-md transition-all bg-white shadow text-forest-dark`}
                                            >
                                                Apple Silicon (MPS)
                                            </button>
                                        )}
                                        {os === 'windows' && (
                                            <>
                                            <button onClick={() => setDevice('cpu')} className={`px-4 py-2 text-xs font-bold rounded-md transition-all ${device === 'cpu' ? 'bg-white shadow text-forest-dark' : 'text-stone-500'}`}>CPU</button>
                                            <button onClick={() => setDevice('cuda')} className={`px-4 py-2 text-xs font-bold rounded-md transition-all ${device === 'cuda' ? 'bg-indigo-500 shadow text-white' : 'text-stone-500'}`}>GPU (CUDA)</button>
                                            </>
                                        )}
                                    </div>
                                </div>
                            </div>

                            <div className="bg-stone-50 p-6 rounded-xl border border-stone-200 mb-6">
                                <div className="flex justify-between items-start mb-6 border-b border-stone-200 pb-4">
                                    <div>
                                        <h3 className="font-bold text-lg text-forest-dark">Python Server Setup</h3>
                                        <p className="text-xs text-stone-500">
                                            We use a Python script to create a WebSocket bridge that enables real-time streaming.
                                        </p>
                                    </div>
                                    <span className="bg-white border border-stone-200 px-2 py-1 rounded text-[10px] font-bold text-stone-400">PORT 9000</span>
                                </div>

                                <div className="space-y-6">
                                    {/* Step 2a: Install Dependencies */}
                                    <div className="bg-white p-4 rounded-lg border border-stone-200 shadow-sm">
                                        <div className="flex items-center gap-3 mb-2">
                                            <div className="w-8 h-8 bg-sage-100 rounded flex items-center justify-center text-forest-dark font-bold">1</div>
                                            <h4 className="font-bold text-sm text-stone-700">Install Prerequisites</h4>
                                        </div>
                                        <div className="text-xs text-stone-500 mb-3 space-y-1">
                                            {os === 'mac' ? (
                                                <p>Requires <strong className="text-stone-800">Homebrew</strong> and <strong className="text-stone-800">Python 3</strong>. Use Terminal.</p>
                                            ) : (
                                                <p>Install <a href="https://www.python.org/downloads/" target="_blank" className="underline text-blue-600 font-bold">Python 3.10+</a> (Check "Add to PATH" during install).</p>
                                            )}
                                        </div>
                                        <div className="mb-2 text-[10px] font-bold text-stone-400 uppercase tracking-wider">Run in Terminal / PowerShell:</div>
                                        <CodeBlock label="Install Libraries" cmd={installCommand} />
                                    </div>

                                    {/* Step 2b: The Script */}
                                    <div className="bg-white p-4 rounded-lg border border-stone-200 shadow-sm">
                                        <div className="flex items-center gap-3 mb-2">
                                            <div className="w-8 h-8 bg-sage-100 rounded flex items-center justify-center text-forest-dark font-bold">2</div>
                                            <div>
                                                <h4 className="font-bold text-sm text-stone-700">Create & Run Server</h4>
                                                <div className="text-[10px] text-green-600 font-bold">Script updated for {os === 'mac' ? 'Apple Silicon' : 'Windows'}</div>
                                            </div>
                                        </div>
                                        <p className="text-xs text-stone-500 mb-2">Create a file named <code>server.py</code> and paste the code below:</p>
                                        <div className="bg-stone-900 text-green-400 p-3 rounded-lg font-mono text-xs h-40 overflow-y-auto border border-stone-700 shadow-inner mb-3 custom-scrollbar">
                                            {pythonScript}
                                        </div>
                                        <button onClick={() => copyToClipboard(pythonScript)} className="mb-4 text-xs font-bold text-forest-dark hover:text-green-600 flex items-center gap-1">
                                            <Copy size={12} /> Copy Python Code
                                        </button>
                                        
                                        <CodeBlock label="Run Server" cmd={os === 'mac' ? "python3 server.py" : "python server.py"} />
                                    </div>
                                </div>

                                <div className="mt-6 pt-4 border-t border-stone-200 flex items-center gap-4">
                                    <div className="flex-1">
                                        <label className="text-[10px] font-bold text-stone-400 uppercase tracking-wider block mb-1">WebSocket URL</label>
                                        <input 
                                            value={whisperUrl} 
                                            onChange={e => { setWhisperUrl(e.target.value); setWhisperStatus('unknown'); }}
                                            className="w-full bg-white text-stone-900 border border-stone-200 rounded p-2 text-sm font-mono focus:border-sage-500 outline-none" 
                                        />
                                    </div>
                                </div>
                            </div>
                            
                            {globalStatus === 'fail' && (
                                <div className="text-red-600 bg-red-50 p-3 rounded-lg flex items-center gap-2 text-xs font-bold mb-4 border border-red-100">
                                    <AlertCircle size={16} /> Connection failed. Is the python script running?
                                </div>
                            )}

                            <div className="flex justify-between items-center">
                                 <button onClick={() => setStep(1)} className="text-stone-500 font-bold hover:text-forest-dark text-sm">Back to Ollama</button>
                                 <button 
                                    onClick={testConnections} 
                                    disabled={globalStatus === 'testing'}
                                    className={`px-8 py-3 rounded-xl font-bold transition-all shadow-lg flex items-center gap-2 ${globalStatus === 'success' ? 'bg-green-600 text-white' : 'bg-forest-dark text-white hover:bg-forest-light'}`}
                                 >
                                    {globalStatus === 'testing' ? (
                                        <>Connecting... <RefreshCw size={16} className="animate-spin" /></>
                                    ) : globalStatus === 'success' ? (
                                        <>All Systems Online <CheckCircle size={18} /></>
                                    ) : (
                                        'Test Connection'
                                    )}
                                 </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default LocalSetup;