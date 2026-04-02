import React, { useEffect, useState, useRef, useCallback } from 'react';
import { Globe, MessageSquare, Sun, Moon, Maximize, Minimize, Type } from 'lucide-react';
import { Caption } from '../types';

const LANGUAGES = [
    { code: 'en', name: 'English', flag: '🇺🇸' },
    { code: 'es', name: 'Español', flag: '🇪🇸' },
    { code: 'zh', name: '中文', flag: '🇨🇳' },
    { code: 'fr', name: 'Français', flag: '🇫🇷' },
    { code: 'pt', name: 'Português', flag: '🇧🇷' },
    { code: 'ht', name: 'Kreyòl', flag: '🇭🇹' },
    { code: 'ru', name: 'Русский', flag: '🇷🇺' },
    { code: 'ar', name: 'العربية', flag: '🇸🇦' },
    { code: 'vi', name: 'Tiếng Việt', flag: '🇻🇳' },
    { code: 'ko', name: '한국어', flag: '🇰🇷' },
    { code: 'ja', name: '日本語', flag: '🇯🇵' },
    { code: 'de', name: 'Deutsch', flag: '🇩🇪' },
    { code: 'it', name: 'Italiano', flag: '🇮🇹' },
    { code: 'pl', name: 'Polski', flag: '🇵🇱' },
    { code: 'tl', name: 'Tagalog', flag: '🇵🇭' },
];

const FONT_SIZES = ['normal', 'large', 'xl'] as const;
type FontSize = typeof FONT_SIZES[number];
const FONT_SIZE_CLASSES: Record<FontSize, string> = {
    normal: 'text-lg md:text-xl',
    large: 'text-xl md:text-2xl',
    xl: 'text-2xl md:text-3xl',
};

interface AudienceViewProps {
    onBack: () => void;
}

const AudienceView: React.FC<AudienceViewProps> = ({ onBack }) => {
    const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
    const [captions, setCaptions] = useState<{ text: string; translatedText?: string; id: number }[]>([]);
    const [interim, setInterim] = useState('');
    const [lang, setLang] = useState(() => localStorage.getItem('cc_audience_lang') || 'en');
    const [showLangPicker, setShowLangPicker] = useState(false);
    const [darkMode, setDarkMode] = useState(() => localStorage.getItem('cc_audience_dark') !== 'false');
    const [fontSize, setFontSize] = useState<FontSize>(() => (localStorage.getItem('cc_audience_font') as FontSize) || 'large');
    const [isFullscreen, setIsFullscreen] = useState(false);
    const scrollRef = useRef<HTMLDivElement>(null);
    const wsRef = useRef<WebSocket | null>(null);

    // Persist preferences
    useEffect(() => { localStorage.setItem('cc_audience_lang', lang); }, [lang]);
    useEffect(() => { localStorage.setItem('cc_audience_dark', String(darkMode)); }, [darkMode]);
    useEffect(() => { localStorage.setItem('cc_audience_font', fontSize); }, [fontSize]);

    // WebSocket connection with reconnect
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const sessionId = params.get('session') || 'demo';

        const getWsUrl = () => {
            const manual = localStorage.getItem('cc_relay_url');
            if (manual) return manual;
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const host = window.location.hostname;
            const port = window.location.port;
            if (port === '5173') return `${protocol}//${host}:8080`;
            const portSuffix = port ? `:${port}` : '';
            return `${protocol}//${host}${portSuffix}`;
        };

        const wsUrl = getWsUrl();
        let retryDelay = 1000;
        let active = true;

        const connect = () => {
            const ws = new WebSocket(wsUrl);
            wsRef.current = ws;

            ws.onopen = () => {
                setStatus('connected');
                retryDelay = 1000; // reset backoff
                ws.send(JSON.stringify({ type: 'join', sessionId, role: 'audience', lang }));
            };

            ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    if (data.type === 'caption') {
                        if (data.isFinal) {
                            const entry = {
                                text: data.payload?.text || (typeof data.payload === 'string' ? data.payload : ''),
                                translatedText: data.payload?.translatedText,
                                id: data.payload?.id || Date.now(),
                            };
                            setCaptions(prev => {
                                const next = [...prev, entry];
                                return next.length > 50 ? next.slice(-50) : next; // 50-caption memory limit
                            });
                            setInterim('');
                        } else {
                            setInterim(data.payload?.text || '');
                        }
                    }
                } catch (e) {}
            };

            ws.onclose = () => {
                setStatus('disconnected');
                if (active) {
                    setTimeout(connect, retryDelay);
                    retryDelay = Math.min(retryDelay * 1.5, 10000); // backoff up to 10s
                }
            };

            ws.onerror = () => {
                setStatus('disconnected');
                ws.close();
            };
        };

        connect();

        // Heartbeat ping every 30s
        const heartbeat = setInterval(() => {
            if (wsRef.current?.readyState === 1) {
                wsRef.current.send(JSON.stringify({ type: 'ping' }));
            }
        }, 30000);

        return () => {
            active = false;
            clearInterval(heartbeat);
            wsRef.current?.close();
        };
    }, []);

    // Language change — tell the server
    const changeLanguage = useCallback((newLang: string) => {
        setLang(newLang);
        setShowLangPicker(false);
        if (wsRef.current?.readyState === 1) {
            wsRef.current.send(JSON.stringify({ type: 'set_language', lang: newLang }));
        }
    }, []);

    // Cycle font size
    const cycleFontSize = () => {
        const idx = FONT_SIZES.indexOf(fontSize);
        setFontSize(FONT_SIZES[(idx + 1) % FONT_SIZES.length]);
    };

    // Toggle fullscreen
    const toggleFullscreen = () => {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch(() => {});
            setIsFullscreen(true);
        } else {
            document.exitFullscreen().catch(() => {});
            setIsFullscreen(false);
        }
    };

    // Auto-scroll
    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [captions, interim]);

    const bg = darkMode ? 'bg-stone-900' : 'bg-white';
    const textColor = darkMode ? 'text-stone-200' : 'text-stone-800';
    const mutedColor = darkMode ? 'text-stone-400' : 'text-stone-500';
    const borderColor = darkMode ? 'border-white/10' : 'border-stone-200';
    const headerBg = darkMode ? 'bg-stone-900/90' : 'bg-white/90';
    const btnBg = darkMode ? 'bg-stone-800 text-stone-400 hover:bg-stone-700' : 'bg-stone-100 text-stone-600 hover:bg-stone-200';
    const currentLang = LANGUAGES.find(l => l.code === lang);

    return (
        <div className={`h-screen ${bg} flex flex-col font-sans transition-colors duration-300`}>
            {/* Header */}
            <div className={`p-3 px-4 ${borderColor} border-b flex justify-between items-center ${headerBg} backdrop-blur sticky top-0 z-10`}>
                <div className="flex items-center gap-3">
                    <div className={`w-2 h-2 rounded-full ${status === 'connected' ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
                    <span className={`font-display font-bold text-lg ${darkMode ? 'text-white' : 'text-stone-900'}`}>Live Caption</span>
                </div>
                <div className="flex gap-1.5">
                    <button onClick={cycleFontSize} className={`p-2 rounded-full transition-colors ${btnBg}`} title="Font size">
                        <Type size={16} />
                    </button>
                    <button onClick={() => setDarkMode(!darkMode)} className={`p-2 rounded-full transition-colors ${btnBg}`} title="Toggle theme">
                        {darkMode ? <Sun size={16} /> : <Moon size={16} />}
                    </button>
                    <button onClick={toggleFullscreen} className={`p-2 rounded-full transition-colors ${btnBg}`} title="Fullscreen">
                        {isFullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
                    </button>
                    <button onClick={() => setShowLangPicker(!showLangPicker)} className={`p-2 rounded-full transition-colors ${showLangPicker ? 'bg-blue-600 text-white' : btnBg}`} title="Language">
                        <Globe size={16} />
                    </button>
                </div>
            </div>

            {/* Language Picker Bar */}
            {showLangPicker && (
                <div className={`${borderColor} border-b ${darkMode ? 'bg-stone-800/80' : 'bg-stone-50'} backdrop-blur`}>
                    <div className="flex gap-1.5 overflow-x-auto p-3 scrollbar-hide">
                        {LANGUAGES.map(l => (
                            <button
                                key={l.code}
                                onClick={() => changeLanguage(l.code)}
                                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium whitespace-nowrap shrink-0 transition-all ${
                                    lang === l.code
                                        ? 'bg-blue-600 text-white shadow-md'
                                        : darkMode
                                            ? 'bg-stone-700 text-stone-300 hover:bg-stone-600'
                                            : 'bg-white text-stone-600 hover:bg-stone-100 border border-stone-200'
                                }`}
                            >
                                <span>{l.flag}</span>
                                <span>{l.name}</span>
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {/* Translation indicator */}
            {lang !== 'en' && (
                <div className="bg-blue-600/10 border-b border-blue-600/20 px-4 py-1.5 text-center">
                    <span className="text-blue-400 text-xs font-medium">Translating to {currentLang?.name} {currentLang?.flag}</span>
                </div>
            )}

            {/* Content */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto p-6 space-y-5 scroll-smooth">
                {captions.length === 0 && !interim && (
                    <div className={`h-full flex flex-col items-center justify-center ${mutedColor} opacity-50`}>
                        <MessageSquare size={48} className="mb-4" />
                        <p>Waiting for broadcast...</p>
                    </div>
                )}

                {captions.map((cap) => (
                    <div key={cap.id} className="animate-slide-up">
                        {/* Translated text shown large, original small below */}
                        {cap.translatedText && lang !== 'en' ? (
                            <>
                                <p className={`${FONT_SIZE_CLASSES[fontSize]} leading-relaxed ${textColor} font-medium`}>
                                    {cap.translatedText}
                                </p>
                                <p className={`text-sm mt-1 ${mutedColor} opacity-60`}>
                                    {cap.text}
                                </p>
                            </>
                        ) : (
                            <p className={`${FONT_SIZE_CLASSES[fontSize]} leading-relaxed ${textColor} font-medium`}>
                                {cap.text}
                            </p>
                        )}
                    </div>
                ))}

                {interim && (
                    <div className="animate-pulse opacity-70">
                        <p className={`${FONT_SIZE_CLASSES[fontSize]} leading-relaxed ${mutedColor} italic`}>
                            {interim}
                        </p>
                    </div>
                )}
            </div>

            {/* Footer */}
            <div className={`p-3 ${borderColor} border-t ${headerBg} text-center text-xs ${mutedColor}`}>
                Powered by Community Captioner
            </div>
        </div>
    );
};

export default AudienceView;
