
import { GoogleGenAI, Type } from "@google/genai";
import { DictionaryEntry, Caption } from "../types";

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
    const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `Translate the following text to ${targetLang}. Return ONLY the translated text.\n\nText: "${text}"`,
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
        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash-latest", // Updated to 2.5 Flash for better multimedia handling
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
            model: "gemini-2.5-flash",
            contents: `Find the official municipal website for "${municipality}" and list the most useful pages for learning proper nouns (elected officials, department staff, boards/commissions, meeting agendas/minutes).

For each page found, provide the title, full URL, a category, and why it's useful for live captioning.`,
            config: {
                tools: [{ googleSearch: {} }],
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
      model: "gemini-3-flash-preview",
      contents: `Analyze text for proper nouns/places/terminology/acronyms. 
      Create a correction map: 'original' (likely phonetic error or raw acronym) -> 'replacement' (correct term).
      Input: ${text.substring(0, 30000)}`,
      config: {
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
      model: "gemini-3-flash-preview",
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
