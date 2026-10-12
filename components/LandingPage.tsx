
import React, { useState, useEffect } from 'react';
import { Users, ArrowRight, Database, Layers, Lock, Github, ShieldCheck, Cpu, Mic, Radio, Captions, Zap, Brain, Layout, BarChart3, ChevronDown, HelpCircle, CheckCircle, XCircle, Heart, Globe, MessageSquare, Feather, Code, Download, CloudLightning, FileVideo } from 'lucide-react';
import { GITHUB_REPO_URL, RELEASES_URL } from '../utils/appLinks';
import { phoneticKey } from '../shared/corrections.js';

interface LandingPageProps {
  /** Jump straight into a live browser captioning session */
  onStart: () => void;
  /** Open the workflow/deployment picker (the "choose your own adventure" flow) */
  onChooseMode: () => void;
}

// --- Logo Component ---
const BrandLogo = () => (
    <div className="flex items-center gap-3">
        <svg width="42" height="42" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" className="transform hover:scale-105 transition-transform shrink-0">
            <rect x="8" y="12" width="32" height="6" rx="3" fill="#3A574A" />
            <rect x="8" y="22" width="24" height="6" rx="3" fill="#64947F" />
            <rect x="8" y="32" width="16" height="6" rx="3" fill="#A3C0B0" />
        </svg>
        <div className="flex flex-col leading-none select-none">
            <span className="font-display font-bold text-xl tracking-tight text-forest-dark uppercase">Community Captioner</span>
            <span className="font-bold text-xs text-forest-dark opacity-60 ml-0.5">[CC]</span>
        </div>
    </div>
);

// --- Partner Logos ---
const WeirdMachineLogo = () => (
    <svg width="140" height="50" viewBox="0 0 200 80" fill="none" xmlns="http://www.w3.org/2000/svg" className="opacity-80 hover:opacity-100 transition-opacity">
        {/* Box Border with Glitch gaps */}
        <path d="M10 10 H60 M80 10 H190 V30 M190 50 V70 H140 M120 70 H10 V50 M10 30 V10" stroke="white" strokeWidth="2" strokeLinecap="round" />
        <rect x="188" y="35" width="4" height="10" fill="white" />
        <rect x="8" y="35" width="4" height="10" fill="white" />
        
        {/* Text: WEIRD */}
        <text x="100" y="35" fontFamily="monospace" fontSize="28" fontWeight="bold" fill="white" textAnchor="middle" letterSpacing="4">WEIRD</text>
        
        {/* Text: MACHINE */}
        <text x="100" y="62" fontFamily="monospace" fontSize="28" fontWeight="bold" fill="none" stroke="white" strokeWidth="1" textAnchor="middle" letterSpacing="4">MACHINE</text>
        
        {/* Glitch Elements */}
        <path d="M30 18 L40 18" stroke="white" strokeWidth="1" />
        <path d="M160 62 L170 62" stroke="white" strokeWidth="1" />
        <rect x="45" y="25" width="2" height="15" fill="white" transform="rotate(20)" />
        <rect x="155" y="45" width="2" height="15" fill="white" transform="rotate(-20)" />
    </svg>
);

const BigLogo = () => (
    <svg width="60" height="60" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" className="opacity-90 hover:opacity-100 transition-opacity">
        {/* Background Circle */}
        <circle cx="50" cy="50" r="48" fill="#2E2E5E" />
        
        {/* Arches */}
        <path d="M25 45 A 25 25 0 0 1 75 45" stroke="white" strokeWidth="6" strokeLinecap="round" />
        <path d="M35 45 A 15 15 0 0 1 65 45" stroke="white" strokeWidth="6" strokeLinecap="round" />
        <circle cx="50" cy="45" r="4" fill="white" />

        {/* Text BIG */}
        <text x="50" y="75" fontFamily="sans-serif" fontSize="32" fontWeight="900" fill="white" textAnchor="middle" letterSpacing="-1">BIG</text>
        
        {/* Subtext */}
        <text x="50" y="88" fontFamily="sans-serif" fontSize="6" fontWeight="bold" fill="white" textAnchor="middle">brookline</text>
        <text x="50" y="94" fontFamily="sans-serif" fontSize="6" fontWeight="bold" fill="white" textAnchor="middle">interactive</text>
    </svg>
);

const TypingHeader = () => {
    const [text, setText] = useState('');
    const [isDeleting, setIsDeleting] = useState(false);
    const [loopNum, setLoopNum] = useState(0);
    const [typingSpeed, setTypingSpeed] = useState(150);

    const words = ["your town.", "your name.", "your community.", "your streets."];

    useEffect(() => {
        const handleType = () => {
            const i = loopNum % words.length;
            const fullText = words[i];

            setText(isDeleting 
                ? fullText.substring(0, text.length - 1) 
                : fullText.substring(0, text.length + 1)
            );

            setTypingSpeed(isDeleting ? 30 : 150);

            if (!isDeleting && text === fullText) {
                setTimeout(() => setIsDeleting(true), 2000);
            } else if (isDeleting && text === '') {
                setIsDeleting(false);
                setLoopNum(loopNum + 1);
            }
        };

        const timer = setTimeout(handleType, typingSpeed);
        return () => clearTimeout(timer);
    }, [text, isDeleting, loopNum, typingSpeed, words]);

    return (
        <span className="text-sage-500">
            {text}
            <span className="typing-cursor text-forest-dark"></span>
        </span>
    );
};

const CorrectionDemo = () => {
    const scenarios = [
        {
            phrase: "The select board chair Bernard Green called the meeting to order.",
            correction: "The select board chair Bernard Greene called the meeting to order.",
            highlight: "Bernard Greene",
            correctionPoint: 50
        },
        {
            phrase: "We are reporting live from Brooklyn where the event is starting.",
            correction: "We are reporting live from Brookline where the event is starting.",
            highlight: "Brookline",
            correctionPoint: 45
        },
        {
            phrase: "Our next speaker tonight is steven woo from the committee.",
            correction: "Our next speaker tonight is Stephen Wu from the committee.",
            highlight: "Stephen Wu",
            correctionPoint: 55
        }
    ];

    const [scenarioIndex, setScenarioIndex] = useState(0);
    const [step, setStep] = useState(0);
    const [displayContent, setDisplayContent] = useState<React.ReactNode>("");
    
    useEffect(() => {
        const interval = setInterval(() => {
            setStep(s => {
                if (s > 140) { // Reset cycle
                    setScenarioIndex(prev => (prev + 1) % scenarios.length);
                    return 0;
                }
                return s + 1;
            });
        }, 60);
        return () => clearInterval(interval);
    }, []);

    useEffect(() => {
        const current = scenarios[scenarioIndex];
        const { phrase, correction, highlight, correctionPoint } = current;

        if (step < correctionPoint) {
            // Typing out the wrong phrase
            setDisplayContent(
                <span>
                    {phrase.substring(0, step)}
                    <span className="inline-block w-2 h-4 bg-stone-900 ml-1 animate-pulse"></span>
                </span>
            );
        } else if (step >= correctionPoint && step < correctionPoint + 15) {
            // Pausing/Thinking state
             setDisplayContent(
                <span>
                    {phrase.substring(0, step)}
                    <span className="inline-block w-2 h-4 bg-stone-900 ml-1 animate-pulse"></span>
                </span>
            );
        } else {
            // Corrected state
            // Reconstruct string with highlight
            const parts = correction.split(highlight);
            setDisplayContent(
                <span>
                    {parts[0]}
                    <span className="bg-sage-100 text-forest-dark font-bold px-1 rounded animate-pulse">{highlight}</span>
                    {parts[1] || ""}
                </span>
            );
        }
    }, [step, scenarioIndex]);

    return (
        <div className="relative max-w-3xl mx-auto mt-16 mb-20 group">
             {/* Main Box - Bigger text, padding, rotating */}
            <div className="bg-white rounded-2xl shadow-2xl border border-stone-200 p-10 transform -rotate-1 group-hover:rotate-0 transition-all duration-500 relative overflow-hidden min-h-[200px] flex flex-col justify-center">
                <div className="absolute top-0 left-0 w-full h-1.5 bg-gradient-to-r from-sage-400 to-forest-light"></div>
                <div className="mb-6 flex items-center gap-3 text-xs font-bold text-stone-400 uppercase tracking-wider">
                    <div className="w-2.5 h-2.5 bg-red-500 rounded-full animate-pulse"></div> Live Stream Output
                </div>
                <div className="text-stone-800 text-3xl font-display font-medium leading-relaxed">
                    {displayContent}
                </div>
            </div>

            {/* Bubble - Positioned relative to wrapper, outside the box */}
            {step > (scenarios[scenarioIndex].correctionPoint + 10) && (
                <div className="absolute -bottom-5 right-8 z-10 flex items-center gap-2 text-[10px] uppercase tracking-wide text-white font-bold bg-forest-dark px-4 py-1.5 rounded-full shadow-lg animate-fade-in border border-forest-light">
                    <ShieldCheck size={12} className="text-sage-300" /> Context Engine Active
                </div>
            )}
        </div>
    );
};

const ComparisonSection = () => (
    <div className="py-24 bg-stone-900 text-white relative overflow-hidden">
        {/* Background Grid */}
        <div className="absolute inset-0 opacity-10" style={{ backgroundImage: 'radial-gradient(#4D7563 1px, transparent 1px)', backgroundSize: '30px 30px' }}></div>
        
        <div className="max-w-6xl mx-auto px-6 relative z-10">
            <div className="text-center mb-16">
                <h2 className="text-3xl md:text-5xl font-display font-bold mb-4">Context Matters in a Democracy</h2>
                <p className="text-stone-400 max-w-2xl mx-auto text-lg">
                    Public meetings are made of proper nouns: the people who govern, the streets they argue about, the acronyms that carry the budget. Generic recognisers get them wrong, and a resident reading captions deserves better than "Mr. Low from Need Ham".
                </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                {/* Before */}
                <div className="bg-red-500/5 border border-red-500/20 rounded-2xl p-8 relative">
                    <div className="absolute top-4 right-4 text-red-500">
                        <XCircle size={24} />
                    </div>
                    <h3 className="text-sm font-bold text-red-400 uppercase tracking-wider mb-6">Standard AI</h3>
                    <div className="space-y-4 font-mono text-lg text-stone-300">
                        <p className="opacity-60">"Welcome to the meeting..."</p>
                        <p>
                            "Next speaker is <span className="text-red-400 font-bold decoration-2 underline decoration-red-500/50 underline-offset-4">Mr. Low</span> from <span className="text-red-400 font-bold decoration-2 underline decoration-red-500/50 underline-offset-4">Need Ham</span>."
                        </p>
                        <p className="opacity-60">"Discussing the <span className="text-red-400 font-bold decoration-2 underline decoration-red-500/50 underline-offset-4">cip</span> budget."</p>
                    </div>
                </div>

                {/* After */}
                <div className="bg-green-500/5 border border-green-500/20 rounded-2xl p-8 relative">
                    <div className="absolute top-4 right-4 text-green-500">
                        <CheckCircle size={24} />
                    </div>
                    <h3 className="text-sm font-bold text-green-400 uppercase tracking-wider mb-6">Community Captioner</h3>
                    <div className="space-y-4 font-mono text-lg text-white">
                        <p className="opacity-60">"Welcome to the meeting..."</p>
                        <p>
                            "Next speaker is <span className="text-green-400 font-bold bg-green-400/10 px-1 rounded">Mr. Lowe</span> from <span className="text-green-400 font-bold bg-green-400/10 px-1 rounded">Needham</span>."
                        </p>
                        <p className="opacity-60">"Discussing the <span className="text-green-400 font-bold bg-green-400/10 px-1 rounded">CIP</span> budget."</p>
                    </div>
                </div>
            </div>
        </div>
    </div>
);

const FeatureCard = ({ icon: Icon, title, desc }: { icon: any, title: string, desc: string }) => (
    <div className="bg-white p-6 rounded-2xl border border-stone-100 shadow-sm hover:shadow-md transition-all hover:-translate-y-1">
        <div className="w-12 h-12 bg-sage-50 rounded-xl flex items-center justify-center text-forest-dark mb-4">
            <Icon size={24} />
        </div>
        <h3 className="font-bold text-lg text-forest-dark mb-2">{title}</h3>
        <p className="text-stone-600 leading-relaxed text-sm">{desc}</p>
    </div>
);

const FaqItem = ({ q, a }: { q: string, a: string }) => (
    <div className="bg-white border border-stone-200 rounded-xl p-6 hover:border-sage-300 transition-colors">
        <h4 className="font-bold text-forest-dark flex items-center gap-2 mb-2">
            <HelpCircle size={16} className="text-sage-500" /> {q}
        </h4>
        <p className="text-stone-600 text-sm leading-relaxed">{a}</p>
    </div>
);

// ---------------------------------------------------------------------------
// Animated explanations. Each one is driven by a small step counter so the
// motion is deterministic, cheap and readable; the keyframes live in index.css.
// ---------------------------------------------------------------------------

const Eyebrow = ({ children }: { children: React.ReactNode }) => (
    <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-sage-600 mb-3">{children}</p>
);

/** 1. The caption pipeline: one line, five stages, the text changing at each one. */
const PipelineFlow = () => {
    const stages = [
        { key: 'audio', label: 'Audio', note: 'Microphone, mixer feed, loopback from Zoom, or a file.' },
        { key: 'recognise', label: 'Recognise', note: 'Browser speech, Gemini live transcription, or Whisper on your GPU.' },
        { key: 'context', label: 'Context Engine', note: 'Exact rules, then a phonetic pass over one to six words.' },
        { key: 'polish', label: 'Polish', note: 'Capitalisation, punctuation, contractions. A few milliseconds.' },
        { key: 'deliver', label: 'Deliver', note: 'Overlay, phones, SDI and YouTube, all from the same line.' },
    ];
    const [step, setStep] = useState(0);
    useEffect(() => { const id = setInterval(() => setStep(st => (st + 1) % (stages.length + 1)), 1500); return () => clearInterval(id); }, []);
    const texts: React.ReactNode[] = [
        <span className="flex items-end gap-[3px] h-6">{Array.from({ length: 28 }, (_, i) => <span key={i} className="w-[3px] rounded-full bg-sage-500 cc-bar" style={{ height: `${8 + ((i * 7) % 16)}px`, animationDelay: `${(i % 7) * 0.12}s` }} />)}</span>,
        <span className="font-mono text-stone-500">the select board chair bernard grene called the meeting to order</span>,
        <span className="font-mono text-stone-700">the select board chair <span className="bg-sage-100 text-forest-dark font-bold px-1 rounded">Bernard Greene</span> called the meeting to order</span>,
        <span className="font-mono text-stone-900"><span className="bg-sage-100 px-1 rounded">The</span> Select Board chair Bernard Greene called the meeting to order<span className="bg-sage-100 px-1 rounded">.</span></span>,
        <span className="flex flex-wrap gap-2">{['OBS / vMix overlay', 'Phones · 15 languages', 'SDI · CEA-608/708', 'YouTube captions'].map((o, i) => <span key={o} className="text-xs font-bold px-2.5 py-1 rounded-full bg-forest-dark text-white cc-rise" style={{ animationDelay: `${i * 0.12}s` }}>{o}</span>)}</span>,
    ];
    const active = Math.min(step, stages.length - 1);
    return (
        <div className="bg-white rounded-3xl border border-stone-200 shadow-xl p-8 md:p-10">
            <div className="relative">
                <div className="absolute left-[10%] right-[10%] top-5 h-px bg-stone-200" />
                <div className="absolute top-5 h-px bg-sage-500 transition-all duration-700 ease-out" style={{ left: '10%', width: `${(active / (stages.length - 1)) * 80}%` }} />
                <div className="absolute top-5 w-3 h-3 -mt-1.5 -ml-1.5 rounded-full bg-sage-500 cc-pulse-ring transition-all duration-700 ease-out" style={{ left: `${10 + (active / (stages.length - 1)) * 80}%` }} />
                <div className="grid grid-cols-5 relative">
                    {stages.map((st, i) => (
                        <div key={st.key} className="text-center px-1">
                            <div className={`w-10 h-10 mx-auto rounded-full border-2 flex items-center justify-center text-xs font-bold transition-all duration-500 ${i <= active ? 'bg-forest-dark border-forest-dark text-white' : 'bg-white border-stone-200 text-stone-400'}`}>{i + 1}</div>
                            <p className={`mt-3 text-sm font-bold transition-colors ${i === active ? 'text-forest-dark' : 'text-stone-400'}`}>{st.label}</p>
                            <p className={`mt-1 text-[11px] leading-snug hidden md:block transition-opacity duration-500 ${i === active ? 'text-stone-600 opacity-100' : 'text-stone-400 opacity-60'}`}>{st.note}</p>
                        </div>
                    ))}
                </div>
            </div>
            <div className="mt-8 min-h-[64px] bg-stone-50 border border-stone-100 rounded-2xl px-5 py-4 flex items-center text-base md:text-lg leading-relaxed">
                <div key={active} className="cc-rise w-full">{texts[active]}</div>
            </div>
            <p className="mt-3 text-[11px] text-stone-400 text-right">Stage {active + 1} of 5 · {stages[active].label}</p>
        </div>
    );
};

/** 2. Where the audio goes in each mode. The arrows animate outward, or stay inside the laptop. */
const AudioRouting = () => {
    const Laptop = ({ children, lock }: { children?: React.ReactNode; lock?: boolean }) => (
        <div className="relative mx-auto w-44">
            <div className="rounded-xl border-2 border-stone-300 bg-white h-28 p-3 flex flex-col items-center justify-center gap-1.5 text-[11px] font-bold text-stone-600">{children}</div>
            <div className="h-2 rounded-b-lg bg-stone-300 mx-[-10px]" />
            {lock && <div className="absolute -top-3 -right-3 w-7 h-7 rounded-full bg-forest-dark text-white flex items-center justify-center shadow"><Lock size={13} /></div>}
        </div>
    );
    const Outbound = ({ to }: { to: string }) => (
        <div className="flex flex-col items-center mt-3">
            <svg width="120" height="34" viewBox="0 0 120 34" className="text-stone-400">
                <path d="M4 17 H104" stroke="currentColor" strokeWidth="2" fill="none" className="cc-dash" />
                <path d="M100 11 L110 17 L100 23" stroke="currentColor" strokeWidth="2" fill="none" />
            </svg>
            <span className="text-[11px] font-bold text-stone-500 bg-stone-100 px-2.5 py-1 rounded-full">{to}</span>
        </div>
    );
    return (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="bg-white rounded-2xl border border-stone-200 p-6 text-center">
                <p className="font-bold text-forest-dark mb-1">Browser mode</p>
                <p className="text-xs text-stone-500 mb-5 min-h-[32px]">Instant and free. The browser's own speech service.</p>
                <Laptop><Mic size={16} /> microphone</Laptop>
                <Outbound to="Google or Apple speech servers" />
                <p className="mt-4 text-[11px] text-stone-500">Audio leaves the machine; text comes back. Captions, dictionary and outputs stay local.</p>
            </div>
            <div className="bg-white rounded-2xl border border-stone-200 p-6 text-center">
                <p className="font-bold text-forest-dark mb-1">Cloud mode</p>
                <p className="text-xs text-stone-500 mb-5 min-h-[32px]">Most accurate on hard audio. Needs a Gemini key.</p>
                <Laptop><Mic size={16} /> microphone</Laptop>
                <Outbound to="Gemini live transcription" />
                <p className="mt-4 text-[11px] text-stone-500">Audio streams to Google's purpose-built transcription model; finished sentences return about 1.7 s after a pause.</p>
            </div>
            <div className="bg-sage-50 rounded-2xl border-2 border-sage-300 p-6 text-center">
                <p className="font-bold text-forest-dark mb-1">Local-only mode</p>
                <p className="text-xs text-stone-600 mb-5 min-h-[32px]">Nothing leaves the room. Works with no internet.</p>
                <Laptop lock>
                    <span className="flex items-center gap-1"><Mic size={14} /> microphone</span>
                    <span className="text-stone-300">↓</span>
                    <span className="flex items-center gap-1"><Cpu size={14} /> Whisper on the GPU</span>
                    <span className="flex items-center gap-1"><Brain size={14} /> Ollama brain</span>
                </Laptop>
                <div className="mt-3 h-[34px] flex items-center justify-center"><span className="text-[11px] font-bold text-forest-dark bg-white border border-sage-300 px-2.5 py-1 rounded-full">no outbound audio or text</span></div>
                <p className="mt-4 text-[11px] text-stone-600">Speech, names, the Municipality Wizard's web reading and translations all run as processes on this computer.</p>
            </div>
        </div>
    );
};

/** 3. How speech is cut into captions: a live waveform, the live line every 0.3 s, the final line after the pause. */
const UtteranceDemo = () => {
    const words = ['The', 'Transportation', 'Board', 'will', 'present', 'the', 'Coolidge', 'Corner', 'parking', 'study.'];
    const TOTAL = words.length + 6; // speaking, then a pause, then the final
    const [t, setT] = useState(0);
    useEffect(() => { const id = setInterval(() => setT(x => (x + 1) % TOTAL), 340); return () => clearInterval(id); }, []);
    const speaking = t < words.length;
    const finalised = t >= words.length + 2;
    const live = words.slice(0, Math.min(words.length, t + 1)).join(' ');
    return (
        <div className="bg-white rounded-2xl border border-stone-200 p-6">
            <p className="font-bold text-forest-dark">From sound to sentence</p>
            <p className="text-xs text-stone-500 mt-1 mb-5">An energy-based voice detector listens in 20 ms hops. While you speak, the growing utterance is transcribed every 0.3 s for the live line. 550 ms after you pause, it is transcribed once more as the final line.</p>
            <div className="flex items-end gap-[3px] h-10 mb-3">
                {Array.from({ length: 44 }, (_, i) => {
                    const inSpeech = speaking || i < 30;
                    return <span key={i} className={`flex-1 rounded-full ${inSpeech && speaking ? 'bg-sage-500 cc-bar' : 'bg-stone-200'}`} style={{ height: `${speaking ? 10 + ((i * 11) % 26) : 6}px`, animationDelay: `${(i % 9) * 0.1}s` }} />;
                })}
            </div>
            <div className="space-y-2 text-sm">
                <div className="flex items-start gap-3">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-stone-400 w-16 pt-1 shrink-0">Live</span>
                    <span className={`flex-1 font-mono ${finalised ? 'text-stone-300' : 'text-stone-500'}`}>{live}{speaking && <span className="inline-block w-1.5 h-4 bg-stone-400 ml-1 align-middle animate-pulse" />}</span>
                    <span className="text-[10px] text-stone-400 font-mono shrink-0">every 0.3 s</span>
                </div>
                <div className="flex items-start gap-3 min-h-[24px]">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-stone-400 w-16 pt-1 shrink-0">Final</span>
                    {finalised ? <span className="flex-1 font-mono text-forest-dark font-bold cc-rise">{words.join(' ')}</span> : <span className="flex-1 text-stone-300 text-xs pt-1">{speaking ? 'waiting for a pause…' : 'pause detected · transcribing once more…'}</span>}
                    <span className="text-[10px] text-stone-400 font-mono shrink-0">≈0.9 s after the pause</span>
                </div>
            </div>
        </div>
    );
};

/** 4. Phonetic matching, computed with the app's real key function. */
const PhoneticDemo = () => {
    const pairs = [
        { heard: 'bernard grene', meant: 'Bernard Greene' },
        { heard: 'coolage corner', meant: 'Coolidge Corner' },
        { heard: 'perlman', meant: 'Pearlman' },
        { heard: 'wine troub', meant: 'Weintraub' },
    ];
    const [i, setI] = useState(0);
    useEffect(() => { const id = setInterval(() => setI(x => (x + 1) % pairs.length), 2600); return () => clearInterval(id); }, []);
    const key = (s: string) => s.split(' ').map(w => phoneticKey(w)).join(' ');
    const pair = pairs[i];
    return (
        <div className="bg-white rounded-2xl border border-stone-200 p-6">
            <p className="font-bold text-forest-dark">Names it has never seen spelled</p>
            <p className="text-xs text-stone-500 mt-1 mb-5">Every word is reduced to how it sounds. A misheard name and the right one share a key, so one rule covers every misspelling. The keys below are computed by the app's own function.</p>
            <div key={i} className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 cc-rise">
                <div className="text-center">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-stone-400 mb-1">Heard</p>
                    <p className="font-mono text-red-500 line-through">{pair.heard}</p>
                    <p className="mt-2 inline-block font-mono text-xs bg-stone-100 text-stone-600 px-2 py-1 rounded">{key(pair.heard)}</p>
                </div>
                <div className="text-sage-500 text-2xl">=</div>
                <div className="text-center">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-stone-400 mb-1">In the dictionary</p>
                    <p className="font-mono text-forest-dark font-bold">{pair.meant}</p>
                    <p className="mt-2 inline-block font-mono text-xs bg-sage-100 text-forest-dark px-2 py-1 rounded">{key(pair.meant)}</p>
                </div>
            </div>
            <p className="mt-4 text-[11px] text-stone-400">Windows of one to six words are compared, so split names ("wine troub") still match. Common English words are never touched, and a sensitivity slider decides how bold the pass is.</p>
        </div>
    );
};

/** 5. Caption packets riding on video frames: one per frame, consumed once. */
const CdpConveyor = () => {
    const frames = Array.from({ length: 16 }, (_, i) => i);
    return (
        <div className="bg-white rounded-2xl border border-stone-200 p-6 overflow-hidden">
            <p className="font-bold text-forest-dark">Captions on the SDI signal</p>
            <p className="text-xs text-stone-500 mt-1 mb-5">Each final line is encoded as CEA-608 pairs (and CEA-708 service blocks in DTVCC mode), wrapped in a SMPTE 334 caption packet and queued inside the native DeckLink addon. The output loop takes exactly one packet per video frame, so text is never repeated and never lost.</p>
            <div className="relative">
                <div className="flex gap-2 w-[200%] cc-conveyor">
                    {[...frames, ...frames].map((f, i) => (
                        <div key={i} className="flex-1 min-w-0">
                            <div className={`h-12 rounded-md border flex items-center justify-center text-[10px] font-mono ${f % 5 === 0 ? 'border-sage-400 bg-sage-50 text-forest-dark' : 'border-stone-200 bg-stone-50 text-stone-400'}`}>{f % 5 === 0 ? 'CDP' : 'frame'}</div>
                        </div>
                    ))}
                </div>
                <div className="absolute inset-y-0 left-0 w-10 bg-gradient-to-r from-white to-transparent" />
                <div className="absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-white to-transparent" />
            </div>
            <div className="mt-4 grid grid-cols-3 gap-3 text-center">
                <div className="bg-stone-50 rounded-lg p-2"><p className="text-sm font-bold text-forest-dark">≈60</p><p className="text-[10px] text-stone-500">chars/s · CEA-608 roll-up</p></div>
                <div className="bg-stone-50 rounded-lg p-2"><p className="text-sm font-bold text-forest-dark">200+</p><p className="text-[10px] text-stone-500">chars/s · CEA-708 DTVCC</p></div>
                <div className="bg-stone-50 rounded-lg p-2"><p className="text-sm font-bold text-forest-dark">1 / frame</p><p className="text-[10px] text-stone-500">packets, consumed once</p></div>
            </div>
        </div>
    );
};

/** 6. Measured on the development machine; the wizard lets you run the same tests. */
const FactsStrip = () => {
    const facts = [
        { n: '0.3 s', d: 'between live-caption updates on an Apple GPU' },
        { n: '0.9 s', d: 'from a pause to the final line' },
        { n: '11×', d: 'faster than real time for prerecorded files (M1 Max)' },
        { n: '100 %', d: 'of known names found by Gemma 4 E2B on the agenda test' },
        { n: '15', d: 'languages on the audience phone view' },
        { n: '0', d: 'bytes of audio leave the room in local-only mode' },
    ];
    return (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-px bg-stone-200 rounded-2xl overflow-hidden border border-stone-200">
            {facts.map(f => (
                <div key={f.d} className="bg-white p-5 text-center">
                    <p className="text-2xl font-display font-bold text-forest-dark tabular-nums">{f.n}</p>
                    <p className="text-[11px] text-stone-500 mt-1 leading-snug">{f.d}</p>
                </div>
            ))}
        </div>
    );
};

const LandingPage: React.FC<LandingPageProps> = ({ onStart, onChooseMode }) => {
  const scrollToSection = (id: string) => {
    const element = document.getElementById(id);
    if (element) {
        element.scrollIntoView({ behavior: 'smooth' });
    }
  };

  return (
    <div className="h-full bg-cream text-stone-900 font-sans overflow-y-auto scroll-smooth relative">
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
           <div className="absolute top-[-10%] left-[-10%] w-[50%] h-[50%] bg-sage-200/30 rounded-full blur-[120px] animate-blob"></div>
      </div>

      <nav className="sticky top-0 z-50 bg-cream/90 backdrop-blur border-b border-stone-200 px-6 py-4">
        <div className="max-w-7xl mx-auto flex justify-between items-center">
            <div className="flex items-center gap-3 select-none cursor-pointer" onClick={() => scrollToSection('top')}>
                 <BrandLogo />
            </div>
            <div className="hidden md:flex items-center gap-6 text-sm font-medium text-stone-600">
                 <button onClick={() => scrollToSection('features')} className="hover:text-forest-dark transition-colors">Features</button>
                 <button onClick={() => scrollToSection('modes')} className="hover:text-forest-dark transition-colors">Modes</button>
                 <button onClick={() => scrollToSection('how-it-works')} className="hover:text-forest-dark transition-colors">How It Works</button>
                 <button onClick={() => scrollToSection('values')} className="hover:text-forest-dark transition-colors">Our Values</button>
                 <button onClick={onChooseMode} className="bg-stone-900 text-white px-4 py-2 rounded-lg hover:bg-forest-light transition-colors shadow-lg hover:shadow-xl transform hover:-translate-y-0.5">Launch App</button>
            </div>
        </div>
      </nav>

      {/* Hero Section */}
      <div id="top" className="pt-24 pb-12 max-w-6xl mx-auto px-6 text-center relative z-10">
            <h1 className="text-5xl md:text-7xl lg:text-8xl font-display font-bold text-forest-dark mb-8 tracking-tight leading-[1.1]">
                Captions that actually&nbsp;know <br/>
                <TypingHeader />
            </h1>
            <p className="text-xl md:text-2xl text-stone-600 mb-12 max-w-3xl mx-auto leading-relaxed">
                Open-source live captioning for community media, built around a Context Engine that learns the names, places and acronyms of the place you broadcast from. <br/>
                <span className="font-bold text-forest-dark">Runs in a browser, in the cloud, or entirely on your own machine. Broadcast-standard output when you need it.</span>
            </p>
            <div className="flex flex-col sm:flex-row sm:flex-wrap items-center justify-center gap-4 mb-16">
                <button onClick={onStart} className="bg-forest-dark hover:bg-forest-light text-white px-10 py-5 rounded-2xl font-bold text-xl transition-all shadow-xl hover:shadow-2xl transform hover:-translate-y-1 flex items-center gap-3">
                    Start Captioning <ArrowRight />
                </button>
                <button onClick={onChooseMode} className="bg-white border-2 border-stone-200 hover:border-sage-500 text-forest-dark px-8 py-5 rounded-2xl font-bold text-xl transition-all shadow-md hover:shadow-xl transform hover:-translate-y-1 flex items-center gap-3">
                    Or Choose Your Mode <Layers size={22} />
                </button>
                <a href={RELEASES_URL} target="_blank" rel="noopener noreferrer" className="bg-white border-2 border-stone-200 hover:border-sage-500 text-forest-dark px-8 py-5 rounded-2xl font-bold text-xl transition-all shadow-md hover:shadow-xl transform hover:-translate-y-1 flex items-center gap-3">
                    Download Local Version <Download size={22} />
                </a>
                <button onClick={() => scrollToSection('features')} className="text-stone-500 font-bold hover:text-forest-dark px-6 py-4 flex items-center gap-2 transition-colors">
                    Learn More <ChevronDown size={20} />
                </button>
            </div>

            <CorrectionDemo />
      </div>

      {/* Features Section */}
      <div id="features" className="py-24 bg-white/50 relative z-10 scroll-mt-20">
          <div className="max-w-7xl mx-auto px-6">
              <div className="text-center mb-16">
                  <h2 className="text-4xl font-display font-bold text-forest-dark mb-4">One tool, several ways to run it</h2>
                  <p className="text-stone-500 max-w-2xl mx-auto">From a laptop at a select board meeting to a broadcast chain with SDI and a YouTube simulcast, the same captions and the same dictionary.</p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  <FeatureCard
                    icon={Lock}
                    title="Local-only mode"
                    desc="Whisper for speech and an Ollama language model as the brain, both on your computer. Audio, agendas and captions never leave the room; it works with no internet at all. A guided setup checks the machine, picks a model and installs everything."
                  />
                  <FeatureCard
                    icon={Captions}
                    title="Broadcast-standard injection"
                    desc="CEA-608 and CEA-708 closed captions embedded in SDI through a Blackmagic DeckLink card: standalone, SDI passthrough or NDI passthrough. Plus a direct path to YouTube's caption ingestion for encoders that drop VANC."
                  />
                  <FeatureCard
                    icon={Brain}
                    title="Context Engine"
                    desc="Type a town and the Municipality Wizard researches its officials, boards, places and acronyms. Drop agendas and packets for review. Sounds-like matching fixes names it has never seen spelled, and Auto-Learn picks up new ones as they are spoken."
                  />
                  <FeatureCard
                    icon={CloudLightning}
                    title="Cloud mode"
                    desc="When you want the most accurate recognition on difficult audio, stream to Google's purpose-built live transcription model and keep every other part of the pipeline the same."
                  />
                  <FeatureCard
                    icon={FileVideo}
                    title="Prerecorded"
                    desc="Transcribe a recording of any length on your own machine, roughly ten times faster than real time on an Apple GPU, with timestamps on every line and the dictionary applied. Or send it to the cloud for speaker labels."
                  />
                  <FeatureCard
                    icon={Globe}
                    title="Audience phones, fifteen languages"
                    desc="A QR code puts captions on every phone in the room. Each viewer chooses their language; translation runs on the local brain or in the cloud and is shared between viewers. Live machine stats show how the hardware is coping."
                  />
              </div>
          </div>
      </div>

      {/* Modes: where the audio goes */}
      <div id="modes" className="py-24 bg-cream relative z-10 scroll-mt-20">
          <div className="max-w-6xl mx-auto px-6">
              <div className="text-center mb-12">
                  <Eyebrow>Modes</Eyebrow>
                  <h2 className="text-4xl font-display font-bold text-forest-dark mb-4">Where your audio goes</h2>
                  <p className="text-stone-500 max-w-2xl mx-auto">Privacy is a routing decision. Each mode sends audio somewhere different, and the app says so in the interface, not in a policy page.</p>
              </div>
              <AudioRouting />
          </div>
      </div>

      <ComparisonSection />

      <div id="how-it-works" className="py-24 bg-white border-y border-stone-100 relative z-10 scroll-mt-20">
        <div className="max-w-6xl mx-auto px-6">
            <div className="text-center mb-10">
                <Eyebrow>How it works</Eyebrow>
                <h2 className="text-4xl font-display font-bold text-forest-dark mb-4">One pipeline, whichever engine you choose</h2>
                <p className="text-stone-500 max-w-2xl mx-auto">Follow a single caption from the microphone to the screen. The recogniser can change; everything after it stays the same.</p>
            </div>
            <PipelineFlow />

            <div className="mt-20 text-center mb-10">
                <Eyebrow>Under the hood</Eyebrow>
                <h2 className="text-3xl font-display font-bold text-forest-dark mb-3">The parts worth understanding</h2>
                <p className="text-stone-500 max-w-2xl mx-auto">Three mechanisms do most of the work. They are small, and they are the reason the captions feel immediate, read correctly, and survive a broadcast chain.</p>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <UtteranceDemo />
                <PhoneticDemo />
                <div className="lg:col-span-2"><CdpConveyor /></div>
            </div>

            <div className="mt-16 text-center mb-6">
                <Eyebrow>Measured, not guessed</Eyebrow>
                <p className="text-stone-500 max-w-2xl mx-auto text-sm">Numbers from the development machine. Every local model in the catalogue was run through the app's own agenda-extraction test, and the setup wizard lets you run the same test on yours before you trust it.</p>
            </div>
            <FactsStrip />
        </div>
      </div>

      <div id="values" className="py-24 bg-sage-50 scroll-mt-20">
           <div className="max-w-6xl mx-auto px-6 text-center">
               <div className="inline-flex items-center gap-2 bg-white px-4 py-2 rounded-full shadow-sm mb-8 text-forest-dark font-bold text-sm">
                   <Heart size={16} className="text-red-500 fill-current" /> Made with love in Brookline, MA
               </div>
               <h2 className="text-4xl font-display font-bold text-forest-dark mb-8">Our Mission</h2>
               <p className="text-xl text-stone-700 leading-relaxed font-medium mb-12 max-w-3xl mx-auto">
                   Accessibility should not depend on a budget. Community Captioner replaces expensive proprietary caption hardware and per-hour services with open-source software that a small station or a town clerk can run.
               </p>
               <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 text-left">
                   <div className="bg-white p-8 rounded-2xl shadow-sm border border-stone-200 hover:border-sage-300 transition-colors">
                        <ShieldCheck className="text-sage-500 mb-4" size={32} />
                        <h4 className="font-bold text-lg mb-2">Democratizing Access</h4>
                        <p className="text-stone-600 leading-relaxed text-sm">
                            Small towns and non-profits rarely have $150 an hour for human captioners. This gives them accurate, correctable automated captions that keep improving as the dictionary grows.
                        </p>
                   </div>
                   <div className="bg-white p-8 rounded-2xl shadow-sm border border-stone-200 hover:border-sage-300 transition-colors">
                        <Globe className="text-sage-500 mb-4" size={32} />
                        <h4 className="font-bold text-lg mb-2">Local Control</h4>
                        <p className="text-stone-600 leading-relaxed text-sm">
                            You own the data and the dictionary. In local-only mode nothing is sent anywhere; cloud services are a choice you make per mode, and the app tells you what each one sends.
                        </p>
                   </div>
                   <div className="bg-white p-8 rounded-2xl shadow-sm border border-stone-200 hover:border-sage-300 transition-colors">
                        <Feather className="text-sage-500 mb-4" size={32} />
                        <h4 className="font-bold text-lg mb-2">Lightweight</h4>
                        <p className="text-stone-600 leading-relaxed text-sm">
                            Runs beside OBS on an ordinary laptop. The Dashboard shows CPU, GPU, memory and network as you go, so you know when a smaller model is the right call.
                        </p>
                   </div>
                   <div className="bg-white p-8 rounded-2xl shadow-sm border border-stone-200 hover:border-sage-300 transition-colors">
                        <Code className="text-sage-500 mb-4" size={32} />
                        <h4 className="font-bold text-lg mb-2">Open Standard</h4>
                        <p className="text-stone-600 leading-relaxed text-sm">
                            CEA-608/708 on SDI, WebVTT and SRT for files, plain HTTP and WebSocket APIs on the relay, and an open repository. Nothing here locks you in.
                        </p>
                   </div>
               </div>
           </div>
      </div>

      <div className="py-24 bg-cream border-t border-stone-100">
          <div className="max-w-3xl mx-auto px-6">
              <h2 className="text-3xl font-display font-bold text-center mb-12">Frequently Asked Questions</h2>
              <div className="space-y-4">
                  <FaqItem
                    q="Is this really free?"
                    a="Yes. The software is open source. Local-only mode costs nothing to run. Cloud mode uses Google's Gemini API, which you pay Google for directly (a few cents per hour of captioning)."
                  />
                  <FaqItem
                    q="How accurate is it?"
                    a="Browser mode lands around 90–95 %. Whisper large-v3-turbo locally and Gemini's live transcription model in the cloud are both well above that on clear audio, and the Context Engine closes most of the remaining gap on the names and terms that matter in your town."
                  />
                  <FaqItem
                    q="What do I need for local-only mode?"
                    a="A Mac with Apple Silicon (16 GB recommended) or a PC with an NVIDIA GPU runs the best models in real time; a CPU-only laptop runs the smaller ones. The setup wizard checks your machine, recommends a model and installs everything with ordinary installers."
                  />
                  <FaqItem
                    q="What do I need for SDI caption injection?"
                    a="A Blackmagic DeckLink card with Desktop Video installed, and the desktop app. Captions are embedded as CEA-608/708 in the SDI output; an NDI source can be used as the video input."
                  />
                  <FaqItem
                    q="Does it work with Zoom or a mixer?"
                    a="Yes. Route the audio into the app with a virtual audio cable or a loopback device, or take a feed from the mixer. The Dashboard lists every input."
                  />
                  <FaqItem
                    q="Can the audience read in other languages?"
                    a="Yes. The phone view offers fifteen languages, each viewer picks their own, and translation runs on the local brain or in the cloud."
                  />
                  <FaqItem
                    q="Is my data private?"
                    a="It depends on the mode, and the app says so in each one. Browser mode sends microphone audio to your browser maker's speech service. Cloud mode streams audio to Google's Gemini. Local and local-only modes keep audio, agendas and captions on your machine; the only network traffic is the optional public link for the audience page."
                  />
              </div>
          </div>
      </div>

      <footer className="bg-forest-dark text-white py-20 text-center relative z-10">
         <div className="max-w-5xl mx-auto px-6 space-y-12">
             
             {/* Logos */}
             <div className="flex justify-center items-center gap-10">
                 <WeirdMachineLogo />
                 <BigLogo />
             </div>

             <div className="space-y-4">
                 <p className="text-xl md:text-2xl font-display font-bold text-white leading-relaxed">
                    <a href="https://communityai.studio" target="_blank" rel="noopener noreferrer" className="hover:text-sage-300 transition-colors border-b border-white/30 hover:border-sage-300">A Community AI Project</a>
                    {' '}from{' '}
                    <a href="https://brooklineinteractive.org" target="_blank" rel="noopener noreferrer" className="hover:text-sage-300 transition-colors border-b border-white/30 hover:border-sage-300">Brookline Interactive Group</a>
                    {' '}and{' '}
                    <a href="https://weirdmachine.org" target="_blank" rel="noopener noreferrer" className="hover:text-sage-300 transition-colors border-b border-white/30 hover:border-sage-300">Weird Machine</a>.
                 </p>
                 <p className="text-stone-400 text-sm max-w-2xl mx-auto">
                    Built in Brookline, Massachusetts for community media centers, town meetings and the people who watch them. Open source, so the next town can start where this one left off.
                 </p>
             </div>

             <div className="flex flex-col items-center justify-center gap-6 pt-8 border-t border-white/10">
                 <div className="text-center space-y-1">
                     <div className="font-bold text-lg">CC</div>
                     <div className="text-xs text-stone-500 uppercase tracking-widest font-bold">BY-NC-SA 4.0</div>
                     <div className="text-xs text-stone-500 uppercase tracking-widest font-bold">NonCommercial ShareAlike</div>
                 </div>
                 
                 <a href={GITHUB_REPO_URL} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 text-stone-400 hover:text-white transition-colors font-bold text-sm mt-4">
                    <Github size={16} /> View Source on GitHub
                 </a>
             </div>
         </div>
      </footer>
    </div>
  );
};

export default LandingPage;
