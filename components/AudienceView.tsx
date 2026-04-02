import React, { useEffect, useState, useRef } from 'react';
import { ArrowLeft, Wifi, WifiOff, Globe, MessageSquare } from 'lucide-react';
import { Caption } from '../types';

interface AudienceViewProps {
    onBack: () => void;
}

const AudienceView: React.FC<AudienceViewProps> = ({ onBack }) => {
    const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
    const [captions, setCaptions] = useState<Caption[]>([]);
    const [interim, setInterim] = useState('');
    const [language, setLanguage] = useState('Original');
    const scrollRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        // Extract session ID from URL params
        const params = new URLSearchParams(window.location.search);
        const sessionId = params.get('session') || 'demo';
        
        // Dynamic WS URL logic
        const getWsUrl = () => {
            const manual = localStorage.getItem('cc_relay_url');
            if (manual) return manual;

            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const host = window.location.hostname;
            const port = window.location.port;
            // DEV MODE: Vite dev server → relay on 8080
            if (port === '5173') return `${protocol}//${host}:8080`;
            // CLOUD/TUNNEL: No port (default 80/443) → don't append colon
            const portSuffix = port ? `:${port}` : '';
            return `${protocol}//${host}${portSuffix}`;
        };

        const wsUrl = getWsUrl();
        const ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            setStatus('connected');
            ws.send(JSON.stringify({ type: 'join', sessionId, role: 'audience' }));
        };

        ws.onclose = () => setStatus('disconnected');
        ws.onerror = () => setStatus('disconnected');

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.type === 'caption') {
                    if (data.isFinal) {
                        setCaptions(prev => [...prev, data.payload]);
                        setInterim('');
                    } else {
                        setInterim(data.payload.text);
                    }
                }
            } catch(e) {}
        };

        return () => ws.close();
    }, []);

    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [captions, interim]);

    return (
        <div className="h-screen bg-stone-900 text-white flex flex-col font-sans">
            {/* Header */}
            <div className="p-4 border-b border-white/10 flex justify-between items-center bg-stone-900/90 backdrop-blur sticky top-0 z-10">
                <div className="flex items-center gap-3">
                    <div className={`w-2 h-2 rounded-full ${status === 'connected' ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`}></div>
                    <span className="font-display font-bold text-lg">Live Caption</span>
                </div>
                <div className="flex gap-2">
                     {/* Placeholder for Client-Side Translation if we added it */}
                     <button className="bg-stone-800 p-2 rounded-full text-stone-400"><Globe size={18} /></button>
                </div>
            </div>

            {/* Content */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto p-6 space-y-6 scroll-smooth">
                {captions.length === 0 && !interim && (
                    <div className="h-full flex flex-col items-center justify-center text-stone-500 opacity-50">
                        <MessageSquare size={48} className="mb-4" />
                        <p>Waiting for broadcast...</p>
                    </div>
                )}
                
                {captions.map((cap) => (
                    <div key={cap.id} className="animate-slide-up">
                        <p className="text-xl md:text-2xl leading-relaxed text-stone-200 font-medium">
                            {cap.text}
                        </p>
                    </div>
                ))}
                
                {interim && (
                    <div className="animate-pulse opacity-70">
                        <p className="text-xl md:text-2xl leading-relaxed text-stone-400 italic">
                            {interim}
                        </p>
                    </div>
                )}
            </div>

            {/* Footer */}
            <div className="p-4 border-t border-white/10 bg-stone-900 text-center text-xs text-stone-600">
                Powered by Community Captioner
            </div>
        </div>
    );
};

export default AudienceView;