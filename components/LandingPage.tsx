
import React, { useState, useEffect } from 'react';
import { Users, ArrowRight, Database, Layers, Lock, Github, ShieldCheck, Cpu, Mic, Radio, Captions, Zap, Brain, Layout, BarChart3, ChevronDown, HelpCircle, CheckCircle, XCircle, Heart, Globe, MessageSquare, Feather, Code } from 'lucide-react';

interface LandingPageProps {
  onStart: () => void;
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
                <h2 className="text-3xl md:text-5xl font-display font-bold mb-4">Context is Everything</h2>
                <p className="text-stone-400 max-w-2xl mx-auto text-lg">
                    Generic AI models don't know your local politicians, street names, or acronyms. We fix that.
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

const LandingPage: React.FC<LandingPageProps> = ({ onStart }) => {
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
                 <button onClick={() => scrollToSection('how-it-works')} className="hover:text-forest-dark transition-colors">How It Works</button>
                 <button onClick={() => scrollToSection('values')} className="hover:text-forest-dark transition-colors">Our Values</button>
                 <button onClick={onStart} className="bg-stone-900 text-white px-4 py-2 rounded-lg hover:bg-forest-light transition-colors shadow-lg hover:shadow-xl transform hover:-translate-y-0.5">Launch App</button>
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
                Open source, AI-powered live captioning for community media. <br/>
                <span className="font-bold text-forest-dark">Zero cost. Easy Setup. Total Privacy.</span>
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-16">
                <button onClick={onStart} className="bg-forest-dark hover:bg-forest-light text-white px-10 py-5 rounded-2xl font-bold text-xl transition-all shadow-xl hover:shadow-2xl transform hover:-translate-y-1 flex items-center gap-3">
                    Start Captioning <ArrowRight />
                </button>
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
                  <h2 className="text-4xl font-display font-bold text-forest-dark mb-4">Production Ready Tools, Open Sourced</h2>
                  <p className="text-stone-500 max-w-2xl mx-auto">Everything you need to broadcast accessible content, from local government meetings to live sports.</p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                  <FeatureCard 
                    icon={Brain}
                    title="Context Engine" 
                    desc="Define custom dictionaries or scrape municipal agendas to ensure names like 'Smythe' are spelled correctly, not 'Smith'."
                  />
                  <FeatureCard 
                    icon={Layout}
                    title="OBS Ready" 
                    desc="Output a transparent window perfectly styled for your broadcast overlay. Change fonts, colors, and positions live."
                  />
                  <FeatureCard 
                    icon={Lock}
                    title="Privacy First" 
                    desc="Run in 'Local Mode' to keep all audio on-device using WebSpeech, perfect for executive sessions or sensitive content."
                  />
                  <FeatureCard 
                    icon={BarChart3}
                    title="Live Analytics" 
                    desc="Track Words Per Minute (WPM), AI confidence scores, and latency in real-time to ensure broadcast quality."
                  />
              </div>
          </div>
      </div>

      <ComparisonSection />

      <div id="how-it-works" className="py-24 bg-white border-y border-stone-100 relative z-10 scroll-mt-20">
        <div className="max-w-6xl mx-auto px-6">
            <h2 className="text-4xl font-display font-bold text-forest-dark mb-16 text-center">How It Works</h2>
            
            <div className="grid grid-cols-1 md:grid-cols-3 gap-12 text-center">
                <div className="relative group">
                    <div className="w-20 h-20 bg-stone-100 rounded-full flex items-center justify-center mx-auto mb-6 group-hover:bg-sage-100 transition-colors">
                        <Mic size={32} className="text-stone-600 group-hover:text-sage-600" />
                    </div>
                    <div className="absolute top-10 right-[-50%] w-full h-0.5 bg-stone-100 hidden md:block -z-10"></div>
                    <h3 className="text-xl font-bold mb-3">1. Capture</h3>
                    <p className="text-stone-500 leading-relaxed text-sm">
                        Select your audio source (Microphone, Loopback, or File). Choose <strong>Local Mode</strong> for privacy or <strong>Cloud Mode</strong> for maximum accuracy.
                    </p>
                </div>

                <div className="relative group">
                    <div className="w-20 h-20 bg-stone-100 rounded-full flex items-center justify-center mx-auto mb-6 group-hover:bg-sage-100 transition-colors">
                        <Database size={32} className="text-stone-600 group-hover:text-sage-600" />
                    </div>
                    <div className="absolute top-10 right-[-50%] w-full h-0.5 bg-stone-100 hidden md:block -z-10"></div>
                    <h3 className="text-xl font-bold mb-3">2. Process</h3>
                    <p className="text-stone-500 leading-relaxed text-sm">
                        The audio is transcribed and then passed through your custom <strong>Context Engine</strong> to correct proper nouns and formatting in milliseconds.
                    </p>
                </div>

                <div className="relative group">
                    <div className="w-20 h-20 bg-stone-100 rounded-full flex items-center justify-center mx-auto mb-6 group-hover:bg-sage-100 transition-colors">
                        <Radio size={32} className="text-stone-600 group-hover:text-sage-600" />
                    </div>
                    <h3 className="text-xl font-bold mb-3">3. Broadcast</h3>
                    <p className="text-stone-500 leading-relaxed text-sm">
                        Display the captions via a chroma-keyed overlay window for OBS/vMix, or generate live translated subtitles for alternate streams.
                    </p>
                </div>
            </div>
        </div>
      </div>

      <div id="values" className="py-24 bg-sage-50 scroll-mt-20">
           <div className="max-w-6xl mx-auto px-6 text-center">
               <div className="inline-flex items-center gap-2 bg-white px-4 py-2 rounded-full shadow-sm mb-8 text-forest-dark font-bold text-sm">
                   <Heart size={16} className="text-red-500 fill-current" /> Made with love in Brookline, MA
               </div>
               <h2 className="text-4xl font-display font-bold text-forest-dark mb-8">Our Mission</h2>
               <p className="text-xl text-stone-700 leading-relaxed font-medium mb-12 max-w-3xl mx-auto">
                   We believe accessibility shouldn't be a luxury. Community Captioner was built to replace expensive proprietary hardware with accessible, open-source software.
               </p>
               <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 text-left">
                   <div className="bg-white p-8 rounded-2xl shadow-sm border border-stone-200 hover:border-sage-300 transition-colors">
                        <ShieldCheck className="text-sage-500 mb-4" size={32} />
                        <h4 className="font-bold text-lg mb-2">Democratizing Access</h4>
                        <p className="text-stone-600 leading-relaxed text-sm">
                            Small towns and non-profits often can't afford $150/hr for human captioners. We provide a "good enough" automated alternative.
                        </p>
                   </div>
                   <div className="bg-white p-8 rounded-2xl shadow-sm border border-stone-200 hover:border-sage-300 transition-colors">
                        <Globe className="text-sage-500 mb-4" size={32} />
                        <h4 className="font-bold text-lg mb-2">Local Control</h4>
                        <p className="text-stone-600 leading-relaxed text-sm">
                            You own your data. You define your dictionary. We don't train models on your private meetings unless you opt-in to cloud services.
                        </p>
                   </div>
                   <div className="bg-white p-8 rounded-2xl shadow-sm border border-stone-200 hover:border-sage-300 transition-colors">
                        <Feather className="text-sage-500 mb-4" size={32} />
                        <h4 className="font-bold text-lg mb-2">Lightweight</h4>
                        <p className="text-stone-600 leading-relaxed text-sm">
                            Designed to run on any laptop alongside OBS without consuming all your CPU or GPU resources.
                        </p>
                   </div>
                   <div className="bg-white p-8 rounded-2xl shadow-sm border border-stone-200 hover:border-sage-300 transition-colors">
                        <Code className="text-sage-500 mb-4" size={32} />
                        <h4 className="font-bold text-lg mb-2">Open Standard</h4>
                        <p className="text-stone-600 leading-relaxed text-sm">
                            We use standard WebVTT and open APIs, meaning you aren't locked into a proprietary ecosystem forever.
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
                    a="Yes. The core software is open source. If you use Local Mode, it costs $0. If you use Cloud Mode (Gemini), you pay Google directly for API usage (approx $0.06/hour)." 
                  />
                  <FaqItem 
                    q="How accurate is it?" 
                    a="Local mode is about 90-95% accurate. Cloud mode with Gemini 1.5 Flash is 98%+ accurate, especially when using the Context Engine." 
                  />
                  <FaqItem 
                    q="Does it work with Zoom?" 
                    a="Yes. You can route Zoom audio into the app using a Virtual Audio Cable (VB-Cable), or simply let your microphone pick up the speakers." 
                  />
                  <FaqItem 
                    q="What browsers are supported?" 
                    a="We strongly recommend Google Chrome or Microsoft Edge for the best experience, as they have the most robust Web Speech API implementation." 
                  />
                  <FaqItem 
                    q="Can I translate into other languages?" 
                    a="Yes! The dashboard supports real-time translation into Spanish and French. This runs in parallel with the English captions." 
                  />
                  <FaqItem 
                    q="Is my data private?" 
                    a="In Local Mode, no audio leaves your browser. In Cloud Mode, audio is sent to Google's enterprise API which does not train on your data by default (unlike the free consumer version)." 
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
                    <a href="https://community.weirdmachine.org" target="_blank" rel="noopener noreferrer" className="hover:text-sage-300 transition-colors border-b border-transparent hover:border-sage-300">A Community AI Project</a> from <a href="https://brooklineinteractive.org" target="_blank" rel="noopener noreferrer" className="hover:text-sage-300 transition-colors border-b border-transparent hover:border-sage-300">Brookline Interactive Group</a> in partnership with <a href="https://neighborhoodai.org" target="_blank" rel="noopener noreferrer" className="hover:text-sage-300 transition-colors border-b border-transparent hover:border-sage-300">Neighborhood AI</a>
                 </p>
                 <p className="text-stone-400">
                    Designed and developed by <a href="https://weirdmachine.org" target="_blank" rel="noopener noreferrer" className="text-stone-300 hover:text-white transition-colors underline decoration-stone-500 hover:decoration-white underline-offset-4">Stephen Walter</a> + AI
                 </p>
             </div>

             <div className="flex flex-col items-center justify-center gap-6 pt-8 border-t border-white/10">
                 <div className="text-center space-y-1">
                     <div className="font-bold text-lg">CC</div>
                     <div className="text-xs text-stone-500 uppercase tracking-widest font-bold">BY-NC-SA 4.0</div>
                     <div className="text-xs text-stone-500 uppercase tracking-widest font-bold">NonCommercial ShareAlike</div>
                 </div>
                 
                 <a href="https://github.com/amateurmenace/community-captioner-v5" className="flex items-center gap-2 text-stone-400 hover:text-white transition-colors font-bold text-sm mt-4">
                    <Github size={16} /> View Source on GitHub
                 </a>
             </div>
         </div>
      </footer>
    </div>
  );
};

export default LandingPage;
