
import { GoogleGenAI, Type, ThinkingLevel } from "@google/genai";
import { DictionaryEntry, Caption } from "../types";
import { languageName } from "../utils/languages";

// Browser-side Gemini calls (measured 2026-10-13, see CLAUDE.md "Gemini models").
// gemini-3.8-flash is the current stable Flash: it keeps JSON response schemas,
// inline audio with timestamps and Google Search grounding working. Its default
// thinking level roughly doubles latency, so the interactive paths cap it at LOW;
// the one-off session analysis and file transcription keep the default for quality.
const TEXT_MODEL = "gemini-3.8-flash";
const LOW_THINKING = { thinkingLevel: ThinkingLevel.LOW };

// Helper to get client with dynamic key
const getClient = (apiKey?: string) => {
    const key = apiKey || localStorage.getItem('cc_api_key') || process.env.API_KEY;
    if (!key) throw new Error("API Key required");
    return new GoogleGenAI({ apiKey: key });
};

export const hasApiKey = (): boolean => !!(localStorage.getItem('cc_api_key') || process.env.API_KEY);

export const translateText = async (text: string, targetLang: string, apiKey?: string): Promise<string> => {
  if (targetLang === 'en') return text;
  try {
    const ai = getClient(apiKey);
    // Fallback used only when the relay is unreachable; same model as the relay's
    // translation-service.js so the Dashboard reads the same quality (≈1.2 s).
    const response = await ai.models.generateContent({
        model: TEXT_MODEL,
        contents: `Translate the following live caption to ${languageName(targetLang)}. Return ONLY the translated text, no quotes or explanation.\n\nText: "${text}"`,
        config: { temperature: 0.1, thinkingConfig: LOW_THINKING },
    });
    return response.text?.trim() || text;
  } catch (e) { 
    console.error("Translation Error:", e);
    return text; 
  }
};

export const transcribeFile = async (base64Data: string, mimeType: string, apiKey?: string): Promise<Caption[]> => {
    const ai = getClient(apiKey);
    
    try {
        // gemini-3.8-flash: a 12.6 s two-utterance test clip came back as two segments at
        // 0 ms and 8500 ms (true start ≈ 8.3 s) with "Coolidge Corner" spelled right;
        // 2.5-flash returned 819 / 8507 ms and "Koolage Corner". gemini-3.5-transcribe
        // (batch) is more accurate still but returns no timestamps, so it is not used here.
        const response = await ai.models.generateContent({
            model: TEXT_MODEL,
            contents: {
                parts: [
                    { inlineData: { mimeType, data: base64Data } },
                    { text: "Transcribe this audio. Return a JSON array of caption objects with 'text' (string) and 'timestamp' (ms number) fields. Keep segments under 10 seconds. Ensure high accuracy." }
                ]
            },
            config: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.ARRAY,
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            text: { type: Type.STRING },
                            timestamp: { type: Type.NUMBER, description: "Start time in milliseconds" },
                        }
                    }
                }
            }
        });

        const raw = response.text ? JSON.parse(response.text) : [];
        return raw.map((item: any, idx: number) => ({
            id: `file-${idx}-${Date.now()}`,
            text: item.text,
            timestamp: item.timestamp || idx * 5000,
            confidence: 1.0,
            isFinal: true
        }));
    } catch (e) {
        console.error("Transcription error", e);
        throw e;
    }
};

/**
 * Uses Gemini + Google Search grounding to find REAL, verified URLs for a municipality.
 * Google Search grounding means Gemini actually searches the web and returns real results.
 */
export const searchMunicipalitySources = async (municipality: string, apiKey?: string) => {
    try {
        const ai = getClient(apiKey);

        // Use Google Search grounding to find real URLs
        const response = await ai.models.generateContent({
            model: TEXT_MODEL,
            contents: `Find the official municipal website for "${municipality}" and list the most useful pages for learning proper nouns (elected officials, department staff, boards/commissions, meeting agendas/minutes).

For each page found, provide the title, full URL, a category, and why it's useful for live captioning.`,
            config: {
                tools: [{ googleSearch: {} }],
                thinkingConfig: LOW_THINKING,
            },
        });

        const text = response.text || '';

        // Extract grounding sources from the response metadata — these are verified real URLs
        const groundingChunks = (response as any).candidates?.[0]?.groundingMetadata?.groundingChunks || [];
        const groundedUrls: {title: string, url: string, type: string, why: string}[] = [];
        const seenUrls = new Set<string>();

        for (const chunk of groundingChunks) {
            const url = chunk?.web?.uri;
            const title = chunk?.web?.title;
            if (url && title && !seenUrls.has(url)) {
                seenUrls.add(url);
                // Categorize by URL/title patterns
                const lower = (url + ' ' + title).toLowerCase();
                let type = 'General';
                if (/official|elected|mayor|council|select.*board|government|board.*alderm/i.test(lower)) type = 'Officials';
                else if (/meeting|agenda|minute|calendar/i.test(lower)) type = 'Meetings';
                else if (/department|staff|directory|contact/i.test(lower)) type = 'Departments';
                else if (/commission|committee|board|advisory/i.test(lower)) type = 'Committees';

                groundedUrls.push({ title, url, type, why: `Found via Google Search for ${municipality}` });
            }
        }

        // If grounding returned URLs, use those (they're verified real) — cap at 8
        if (groundedUrls.length > 0) {
            return groundedUrls.slice(0, 8);
        }

        // Fallback: try to parse URLs from the response text
        const urlRegex = /https?:\/\/[^\s)<>"]+/g;
        const matches = text.match(urlRegex) || [];
        const fallbackUrls: {title: string, url: string, type: string, why: string}[] = [];
        for (const url of matches) {
            const cleanUrl = url.replace(/[.,;:!?)]+$/, ''); // strip trailing punctuation
            if (!seenUrls.has(cleanUrl)) {
                seenUrls.add(cleanUrl);
                fallbackUrls.push({
                    title: cleanUrl.split('/').pop()?.replace(/-/g, ' ') || 'Web Page',
                    url: cleanUrl,
                    type: 'General',
                    why: 'Extracted from search results',
                });
            }
        }

        return fallbackUrls.slice(0, 8);
    } catch (e) {
        console.error('[Wizard] Search failed:', e);
        return [];
    }
};

export const generateContextDictionary = async (text: string, apiKey?: string): Promise<DictionaryEntry[]> => {
  try {
    const ai = getClient(apiKey);
    const response = await ai.models.generateContent({
      model: TEXT_MODEL,
      contents: `Analyze text for proper nouns/places/terminology/acronyms.
      Create a correction map: 'original' (likely phonetic error or raw acronym) -> 'replacement' (correct term).
      Input: ${text.substring(0, 30000)}`,
      config: {
        thinkingConfig: LOW_THINKING,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              original: { type: Type.STRING },
              replacement: { type: Type.STRING },
              type: { type: Type.STRING, enum: ["proper_noun", "place", "correction", "acronym"] },
              sensitivity: { type: Type.NUMBER, description: "Confidence threshold 0-100" }
            },
            required: ["original", "replacement", "type"]
          }
        }
      }
    });
    return response.text ? JSON.parse(response.text) : [];
  } catch (error) {
    return [];
  }
};

export const generateSessionAnalysis = async (captions: Caption[], apiKey?: string) => {
  try {
    const ai = getClient(apiKey);
    const fullTranscript = captions.map(c => c.text).join(' ');
    
    const response = await ai.models.generateContent({
      model: TEXT_MODEL,
      contents: `Analyze the following transcript.
      1. Provide a concise summary (3-5 sentences) capturing the main topics and outcomes.
      2. Extract up to 10 highlights. MUST use direct quotes from the text.
      
      Transcript: ${fullTranscript.substring(0, 50000)}`,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            summary: { type: Type.STRING },
            highlights: { 
                type: Type.ARRAY, 
                items: { 
                    type: Type.OBJECT,
                    properties: {
                        quote: { type: Type.STRING, description: "Direct quote from transcript" },
                        context: { type: Type.STRING, description: "Brief context about why this is important" },
                        timestamp: { type: Type.STRING, description: "Approximate time if available" }
                    }
                } 
            }
          }
        }
      }
    });
    return response.text ? JSON.parse(response.text) : { summary: "Analysis failed", highlights: [] };
  } catch (error) {
    console.error(error);
    throw error;
  }
};
