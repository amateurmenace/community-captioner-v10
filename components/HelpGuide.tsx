import React, { useState } from 'react';
import { Mic, Server, Brain, Captions, FileVideo, Smartphone, Activity, Wrench, Cpu, ChevronDown, ChevronRight, Zap, Lock, CloudLightning, ShieldAlert, Globe } from 'lucide-react';
import { GITHUB_REPO_URL, RELEASES_URL } from '../utils/appLinks';

/**
 * In-app guide. Kept as plain data so it is easy to keep current: one entry per
 * area of the app, each with short bullets and an optional "under the hood" note.
 */
type Section = {
    id: string;
    icon: any;
    title: string;
    lead: string;
    bullets: (string | React.ReactNode)[];
    tech?: string[];
};

const SECTIONS: Section[] = [
    {
        id: 'start', icon: Mic, title: 'Start captioning',
        lead: 'Start Captioning on the landing page opens the Dashboard in Balanced mode. Or Choose a workflow for Caption Injection, Prerecorded files, or Local AI setup.',
        bullets: [
            'Pick the audio source in the bottom bar (a microphone, a mixer or an audio-loopback device for Zoom), then press Start. Stop pauses, Resume continues, End closes the session and opens the transcript, analytics and highlight tools.',
            'The row under the controls shows the session: duration, latency (end of speech to caption on screen), words per minute over the last minute, and recognizer confidence where the engine reports one.',
            'Below that, four hairline graphs run across the page: CPU, GPU, RAM and network for the last five minutes, with what the local speech server and Ollama are using. Click the machine name for the detailed panel.',
            'Edit any caption line in place; the Context Engine offers to turn your edit into a correction rule.',
        ],
        tech: [
            'Latency is measured, not estimated: a voice-activity detector samples the microphone every 60 ms and timestamps the last moment speech was heard; each final caption subtracts that from now.',
        ],
    },
    {
        id: 'modes', icon: Zap, title: 'Captioning modes',
        lead: 'The mode bar at the bottom chooses where speech recognition runs. Each mode sends audio somewhere different, and the app says where.',
        bullets: [
            <><strong>Balanced</strong> (<Zap size={11} className="inline" />): the browser's own speech service. Chrome and Edge send microphone audio to Google's speech servers; Safari uses Apple's. Free, instant, no setup. Not private.</>,
            <><strong>Cloud</strong> (<CloudLightning size={11} className="inline" />): audio streams to Google's Gemini transcription model (gemini-3.5-transcribe-live). The most accurate option for difficult audio; needs a Gemini API key.</>,
            <><strong>Local</strong> (<Lock size={11} className="inline" />): Whisper running on this computer. Audio never leaves the machine. Needs the one-time Local AI setup.</>,
            <><strong>Fully local</strong> (<Server size={11} className="inline" />): Local speech plus an Ollama model as the "brain", so the Context Engine, the Municipality Wizard, translation and session analysis also run here. Works with no internet at all.</>,
            <><strong>Resilience</strong> (<ShieldAlert size={11} className="inline" />): browser speech with aggressive automatic retry when the network drops. For venues with flaky Wi-Fi.</>,
            'In every mode, final captions pass through the Context Engine, then the polisher (capitalisation, punctuation, contractions), then on to the audience view, the OBS overlay and the SDI encoder.',
        ],
    },
    {
        id: 'local', icon: Server, title: 'Local AI setup (the wizard)',
        lead: 'Workspace → Local AI, or the Local pill in the Dashboard. Four steps: check this machine, speech engine, AI brain (optional), finish.',
        bullets: [
            'Check this machine: CPU, RAM, GPU (Apple Silicon or NVIDIA), Python and Ollama. Plain installer links for anything missing; no Homebrew or Terminal required. Python 3.10–3.13 is used (on Windows it is found through the py launcher); 3.14 is too new for the speech packages.',
            'Speech engine: pick a Whisper model. large-v3-turbo is the default on Apple Silicon with 16 GB or more and on NVIDIA cards with 4 GB or more and the CUDA 12 runtime installed; small.en everywhere else, because on a CPU the large models need 3–4 seconds per caption and fall behind (small.en needs about 1 s). Install & start creates a private Python environment, downloads the model and runs the server. Test with your microphone before you commit.',
            'First start on a computer takes minutes, not seconds: the Python packages (about 500 MB) and the model (up to 1.6 GB) download once. The wizard, the Dashboard pill and the Prerecorded card all show that progress and the live log. After that, starts take 10–40 seconds, and the app starts the server itself whenever a local workflow needs it.',
            'If an older copy of the speech server is still running on port 9000, the wizard says so and offers to replace it with the current version.',
            'Advanced options: backend, language, interim captions, and a separate small "live caption model" that drafts the live line while the main model does the finals (useful on CPU-only machines).',
            'AI brain: Ollama runs a small language model on this machine. Gemma 4 E2B is the recommended default (every known name on our agenda test in about 5 s, runs on 8 GB); Gemma 4 E4B is the thorough option for 16 GB+. Download shows live progress; Test with the app runs a real agenda extraction and grades it.',
        ],
        tech: [
            'The speech server cuts audio into utterances with an energy-based voice-activity detector (20 ms hops, adaptive noise floor), transcribes the growing utterance every 0.3 s on a GPU for the live line, and finalises it 550 ms after you pause. Finals never wait behind a live update, and a late live update can never overwrite a finished line.',
            'mlx-whisper runs on the Apple GPU; faster-whisper (CTranslate2) covers CPU and NVIDIA. On Windows the GPU needs NVIDIA\'s CUDA 12 runtime (cuBLAS); without it, or when the card does not support the model, the server says why in its log and runs on the CPU instead. On big CPUs it uses up to 12 threads.',
            'Models and the Python environment live in ~/.community-captioner/data/local (on Windows: %USERPROFILE%\\.community-captioner\\data\\local).',
        ],
    },
    {
        id: 'context', icon: Brain, title: 'Context Engine',
        lead: 'The dictionary that makes captions know your town: names, boards, places and acronyms, with the mishearings that speech recognisers produce for them.',
        bullets: [
            'Municipality Wizard: type a town ("Brookline, MA"). With a Gemini key it researches officials, boards, places and acronyms with Google Search grounding; with the local brain it searches the web key-free and reads the official pages with your model. Results arrive in four groups with checkboxes; one click adds them as rules.',
            'Documents: drop agendas, minutes or packets (PDF, Word, text, HTML), several at once. Each file shows reading and extraction progress, then a grouped review (people & organisations, places, acronyms, corrections) with "already in the dictionary" counts before anything is added.',
            'Paste text, scrape a URL, Quick Names (paste a list of names to get their likely mishearings) and Meeting Body setup (members and acronyms in one form).',
            'Auto-Learn (the Learn pill): while captioning, new names heard in the transcript are proposed as toasts and added after 10 seconds unless you reject them.',
            'Correction sensitivity controls the phonetic ("sounds-like") pass: "bernard grene" becomes "Bernard Greene" without a rule for every misspelling. Settings has a "Try a sentence" box.',
            'Profiles: save the dictionary under a name on the relay so every operator machine sees the same rules. Export and import as JSON.',
        ],
        tech: [
            'Two passes per caption: exact word-boundary matches first, then a Metaphone-style phonetic comparison over windows of one to six words, gated by the sensitivity slider and guarded against common English words.',
            'Extraction goes local brain → Gemini → pattern matching, and every engine reports which one produced the result.',
        ],
    },
    {
        id: 'prerecorded', icon: FileVideo, title: 'Prerecorded files',
        lead: 'Workspace → Prerecorded. Transcribe a recording on this computer or with Gemini, review it, then export.',
        bullets: [
            'On this computer: any file size and format (MP4, MOV, MKV, MP3, WAV, M4A…). The file uploads to the relay on this machine with a progress bar, is decoded there, cut into utterances at pauses and transcribed by your Whisper model. Lines appear with timestamps as they are done, with the stage, speed (× real time) and time left. A 4-minute recording takes about 20 seconds on an M1 Max; on a Windows PC without a usable GPU (24-core Xeon, small.en) a 2-minute recording took 39 seconds, including starting the speech server.',
            'YouTube link: the audio is fetched on this computer with yt-dlp (installed automatically the first time) and transcribed the same way.',
            'Gemini cloud: files under 500 MB, can label speakers, needs an API key.',
            'Every line goes through the Context Engine when it finishes; corrected lines are highlighted. Review transcript opens the editor and analytics.',
        ],
    },
    {
        id: 'inject', icon: Captions, title: 'Caption Injection (broadcast)',
        lead: 'Workspace → Caption Injection. Embeds standards-compliant closed captions into an SDI signal with a Blackmagic DeckLink card, or forwards them to YouTube.',
        bullets: [
            'Three output modes: standalone (captions on black), SDI passthrough (SDI in → SDI out with captions added), and NDI passthrough (an NDI source → SDI with captions, audio resampled to 48 kHz).',
            'CEA-608 roll-up (2 or 3 rows, about 60 characters per second, works with every decoder) or DTVCC / CEA-708 (about 200+ characters per second, with CEA-608 still carried for older decoders).',
            'Caption strategy when speech outruns the standard: truncate at a word boundary, summarise with Gemini, or verbatim.',
            'YouTube caption ingestion URL: the Blackmagic Web Presenter does not forward VANC captions into its RTMP stream, so the app can POST each caption straight to YouTube\'s per-stream ingestion URL instead.',
            'Output designer: the OBS / vMix overlay URL, fonts, colours, size and position.',
        ],
        tech: [
            'Captions become SMPTE 334 CDP packets with a service-info block and are queued one per output frame in the native addon; each packet is consumed exactly once, which is what fixed the repeated-character garbling earlier versions produced.',
            'Only final captions reach the encoders. Interim text is never sent, because CEA-608 cannot erase and rewrite.',
        ],
    },
    {
        id: 'audience', icon: Smartphone, title: 'Audience phone view and translation',
        lead: 'The QR button in the Dashboard shares a page where people in the room read captions on their own phones, in their own language.',
        bullets: [
            'Local URL for the room Wi-Fi, plus a public URL through a Cloudflare tunnel with a localhost.run backup; the modal shows how many viewers are connected.',
            'Fifteen languages. Each viewer picks their own; translations are cached and shared between viewers of the same language.',
            'Translation runs on the local brain when it is enabled (nothing leaves the machine) or through Gemini. The Dashboard\'s side-by-side translation uses the same path.',
            'Dark and light mode, three text sizes, fullscreen, and a transcript download.',
        ],
    },
    {
        id: 'stats', icon: Activity, title: 'Machine stats',
        lead: 'Local models are only as good as the hardware under them, so the Dashboard watches it.',
        bullets: [
            'CPU, GPU (Apple and NVIDIA report utilisation), RAM (with memory pressure on macOS; RAM in use on Windows), and network up and down, sampled every two seconds while captioning.',
            'The detail panel lists what the Whisper server, Ollama and the relay are each using (on Windows memory only, no CPU share), and spells out warnings: CPU saturated, memory nearly full, GPU fully busy.',
            'If captions lag in a local mode and the CPU graph is pinned, pick a smaller Whisper model in Local AI setup; if memory pressure is high, close other apps or choose a smaller brain model.',
        ],
    },
    {
        id: 'trouble', icon: Wrench, title: 'When something is wrong',
        lead: 'The usual causes, in the order they come up.',
        bullets: [
            'Captions stop in Balanced mode even though the audio meter moves, and the pill says "no text": the browser\'s own speech service has wedged. Quit and reopen the browser; that has fixed every case so far. The app logs the silent restarts so you can see it happening.',
            'Where to look: the Log button in the session line keeps a timeline of session starts, microphone, speech engines, relay and errors (kept across reloads, with Copy and Download). Help & Settings → Diagnostics runs the checks and includes the relay\'s own log; the full relay log file is in ~/.community-captioner/data/logs/relay.log.',
            'Nothing happens when you press Start, in any mode: the microphone could not be opened. The app now says why (permission blocked, no input device, a remembered device that is not on this computer, in use by another app) in a red banner, and Help & Settings → Diagnostics runs the checks and gives you a report to copy.',
            'Balanced mode shows the audio meter but no text: the browser speech service is not answering. The header pill says "waiting for text" and then "no text" with the reason. Chrome and Edge need internet access to Google\'s speech servers; Safari uses Apple\'s. Check the spoken language in Help & Settings → General (the audience translation picker never changes it), or switch to Local mode.',
            '"Local server offline" or a file stuck while "starting the speech server": on a first run the engine and model are downloading; the card shows the log. If Local AI was never set up, open the wizard.',
            'Port 8080 already in use: another copy of the app (or the development server) is running. Close it and launch again.',
            'Windows with an NVIDIA card, but Local AI says the GPU is not used for speech: the CUDA 12 runtime is not installed or the card has under 4 GB. Install NVIDIA\'s CUDA 12 runtime for GPU speech, or keep the recommended CPU model (small.en), which keeps up on its own.',
            'Captions fall behind on SDI: CEA-608 is limited to about 60 characters per second. Switch the strategy to truncate with a lower line length, use summarise, or switch to DTVCC if your decoder supports it.',
            'PDF upload finds nothing: the PDF has no text layer (a scan). Export a text PDF from the agenda software or paste the text.',
            'The Municipality Wizard cannot read a town site: many municipal hosts block automated readers. With Gemini the pages are read from Google\'s side; locally, upload the agenda PDF for full coverage.',
            'The Web Presenter shows captions but YouTube does not: use the YouTube caption ingestion URL instead of the encoder path.',
        ],
    },
    {
        id: 'tech', icon: Cpu, title: 'How it is built',
        lead: 'For the curious and for whoever maintains this next.',
        bullets: [
            'A React interface talks over a WebSocket to a Node relay on port 8080 on the operator\'s machine. The relay polishes and routes captions, hosts the audience view, runs the Context Engine endpoints, manages the local speech server and Ollama, and drives the DeckLink card through a C++ N-API addon.',
            'The desktop app is that relay plus the interface packaged into one binary (signed and notarised on the Mac; a plain CommunityCaptioner.exe on Windows); data lives in ~/.community-captioner/data, on Windows %USERPROFILE%\\.community-captioner\\data (dictionary, profiles, the Python environment and model caches).',
            'The bundled speech server is one Python file. The relay installs it into its own environment, launches it, follows its status lines, and can replace an outdated copy.',
            'Everything the local brain does goes through Ollama\'s HTTP API with JSON-mode prompts: agenda extraction in chunks, the wizard\'s page reading and knowledge pass, translation, and the real-extraction test you see in the wizard.',
            <>Source, releases and the Windows build notes are on <a href={GITHUB_REPO_URL} target="_blank" rel="noopener" className="underline text-forest-dark">GitHub</a>; downloads on the <a href={RELEASES_URL} target="_blank" rel="noopener" className="underline text-forest-dark">releases page</a>.</>,
        ],
    },
];

const HelpGuide: React.FC = () => {
    const [open, setOpen] = useState<Record<string, boolean>>({ start: true, modes: true });
    const toggle = (id: string) => setOpen(o => ({ ...o, [id]: !o[id] }));
    return (
        <div className="space-y-3 animate-fade-in">
            <div className="mb-5">
                <h3 className="text-lg font-bold text-forest-dark">Help &amp; guide</h3>
                <p className="text-sm text-stone-500">How every part of Community Captioner works, what each mode sends where, and what to do when something is off. Click a section to expand it.</p>
                <div className="flex flex-wrap gap-1.5 mt-3">
                    {SECTIONS.map(sec => <button key={sec.id} onClick={() => { setOpen(o => ({ ...o, [sec.id]: true })); document.getElementById(`help-${sec.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }} className="text-[11px] font-bold px-2.5 py-1 rounded-full bg-stone-100 text-stone-600 hover:bg-sage-100 hover:text-forest-dark transition-colors">{sec.title}</button>)}
                </div>
            </div>
            {SECTIONS.map(sec => {
                const Icon = sec.icon;
                const isOpen = !!open[sec.id];
                return (
                    <div key={sec.id} id={`help-${sec.id}`} className="border border-stone-200 rounded-xl bg-white scroll-mt-4">
                        <button onClick={() => toggle(sec.id)} className="w-full flex items-center gap-3 px-4 py-3 text-left">
                            <span className="w-8 h-8 rounded-lg bg-sage-50 text-forest-dark flex items-center justify-center shrink-0"><Icon size={16} /></span>
                            <span className="flex-1 min-w-0">
                                <span className="block font-bold text-sm text-forest-dark">{sec.title}</span>
                                <span className="block text-xs text-stone-500 truncate">{sec.lead}</span>
                            </span>
                            {isOpen ? <ChevronDown size={16} className="text-stone-400 shrink-0" /> : <ChevronRight size={16} className="text-stone-400 shrink-0" />}
                        </button>
                        {isOpen && (
                            <div className="px-4 pb-4 pt-1 border-t border-stone-100">
                                <p className="text-sm text-stone-600 mb-3">{sec.lead}</p>
                                <ul className="space-y-2">
                                    {sec.bullets.map((b, i) => <li key={i} className="text-sm text-stone-700 leading-relaxed flex gap-2"><span className="text-sage-500 mt-[7px] w-1.5 h-1.5 rounded-full bg-current shrink-0" />{typeof b === 'string' ? <span>{b}</span> : <span>{b}</span>}</li>)}
                                </ul>
                                {sec.tech && (
                                    <div className="mt-3 bg-stone-50 border border-stone-200 rounded-lg p-3">
                                        <p className="text-[10px] font-bold uppercase tracking-wider text-stone-400 mb-1.5 flex items-center gap-1"><Cpu size={11} /> Under the hood</p>
                                        <ul className="space-y-1.5">{sec.tech.map((t, i) => <li key={i} className="text-xs text-stone-600 leading-relaxed">{t}</li>)}</ul>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                );
            })}
            <p className="text-[11px] text-stone-400 pt-2 flex items-center gap-1"><Globe size={11} /> A Community AI Project from Brookline Interactive Group and Weird Machine.</p>
        </div>
    );
};

export default HelpGuide;
