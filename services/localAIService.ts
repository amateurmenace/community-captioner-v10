
// Service for interacting with Local LLMs (Ollama/LM Studio)

export const checkOllamaConnection = async (url: string = 'http://localhost:11434'): Promise<boolean> => {
    try {
        // Ollama usually has a root endpoint or /api/tags
        const res = await fetch(`${url}/api/tags`);
        return res.ok;
    } catch (e) {
        return false;
    }
};

export const generateLocalContextDictionary = async (text: string, baseUrl: string = 'http://localhost:11434'): Promise<any[]> => {
    try {
        const prompt = `Analyze this text for proper nouns, places, and acronyms. Return ONLY a JSON array of objects with "original" (string), "replacement" (string), and "type" (string enum: proper_noun, place, acronym). Text: ${text.substring(0, 10000)}`;
        
        const res = await fetch(`${baseUrl}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'llama3', // User can configure this, default for now
                prompt: prompt,
                stream: false,
                format: "json"
            })
        });
        
        const data = await res.json();
        // Ollama returns { response: string }
        try {
            return JSON.parse(data.response);
        } catch (e) {
            console.error("Failed to parse local LLM JSON", e);
            return [];
        }
    } catch (e) {
        console.error("Local LLM Error", e);
        return [];
    }
};

export const generateLocalHighlightAnalysis = async (captions: any[], baseUrl: string = 'http://localhost:11434') => {
    const fullText = captions.map(c => c.text).join(' ');
    
    try {
        const prompt = `Analyze this transcript. Provide a JSON object with "summary" (string) and "highlights" (array of objects with "quote", "context", "timestamp"). Keep highlights to the top 5 most impactful quotes. Transcript: ${fullText.substring(0, 15000)}`;

        const res = await fetch(`${baseUrl}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'llama3',
                prompt: prompt,
                stream: false,
                format: "json"
            })
        });

        const data = await res.json();
        return JSON.parse(data.response);
    } catch (e) {
        throw new Error("Local LLM generation failed");
    }
};
