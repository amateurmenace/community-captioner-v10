
// Service for interacting with Local LLMs (Ollama / LM Studio-compatible)

export const DEFAULT_OLLAMA_MODEL = 'gemma4:e2b';

export const checkOllamaConnection = async (url: string = 'http://localhost:11434'): Promise<boolean> => {
    try {
        const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(3000) });
        return res.ok;
    } catch (e) {
        return false;
    }
};

export const listOllamaModels = async (url: string = 'http://localhost:11434'): Promise<string[]> => {
    try {
        const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(3000) });
        if (!res.ok) return [];
        const data = await res.json();
        return (data.models || []).map((m: any) => m.name as string);
    } catch {
        return [];
    }
};

const stripThinking = (s: string) => s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

const parseJsonLoose = (raw: string): any => {
    const s = stripThinking(raw);
    try { return JSON.parse(s); } catch {}
    const a = s.indexOf('['), b = s.lastIndexOf(']');
    if (a !== -1 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch {} }
    const c = s.indexOf('{'), d = s.lastIndexOf('}');
    if (c !== -1 && d > c) { try { return JSON.parse(s.slice(c, d + 1)); } catch {} }
    return null;
};

export const generateLocalContextDictionary = async (text: string, baseUrl: string = 'http://localhost:11434', model: string = DEFAULT_OLLAMA_MODEL): Promise<any[]> => {
    try {
        const prompt = `You prepare a correction dictionary for live closed captions. From the text below, list proper nouns a speech-to-text engine could get wrong: people's full names, boards/committees/departments, organizations, places and streets, and acronyms (with expansions).
Return ONLY a JSON object: {"entries":[{"original":"<lowercase spoken form>","replacement":"<correct spelling>","type":"proper_noun|place|acronym|correction"}]}
Text:
${text.substring(0, 10000)}`;

        const res = await fetch(`${baseUrl}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, prompt, stream: false, format: 'json', options: { temperature: 0.1, num_predict: 2048 } }),
        });
        const data = await res.json();
        const parsed = parseJsonLoose(data.response || '');
        const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.entries) ? parsed.entries : [];
        return list.filter((e: any) => e && e.original && e.replacement);
    } catch (e) {
        console.error("Local LLM Error", e);
        return [];
    }
};

export const generateLocalHighlightAnalysis = async (captions: any[], baseUrl: string = 'http://localhost:11434', model: string = DEFAULT_OLLAMA_MODEL) => {
    const fullText = captions.map(c => c.text).join(' ');

    try {
        const prompt = `Analyze this meeting transcript. Return ONLY a JSON object with "summary" (3-5 sentences) and "highlights" (array of up to 5 objects with "quote" (a direct quote), "context" (why it matters), "timestamp" (approximate, or "")). Transcript: ${fullText.substring(0, 15000)}`;

        const res = await fetch(`${baseUrl}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, prompt, stream: false, format: 'json', options: { temperature: 0.2, num_predict: 1500 } }),
        });

        const data = await res.json();
        const parsed = parseJsonLoose(data.response || '');
        if (!parsed || typeof parsed !== 'object') throw new Error('Local LLM returned no JSON');
        return { summary: parsed.summary || '', highlights: Array.isArray(parsed.highlights) ? parsed.highlights : [] };
    } catch (e) {
        throw new Error("Local LLM generation failed");
    }
};
