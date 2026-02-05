
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
 * Simulates a scraping of municipal websites.
 */
export const searchMunicipalitySources = async (municipality: string, apiKey?: string) => {
    try {
        const ai = getClient(apiKey);
        const response = await ai.models.generateContent({
            model: "gemini-3-flash-preview",
            contents: `The user wants to find public documents for ${municipality} to build a speech-to-text context engine.
            Act as a web scraper. Generate a list of realistic URLs and Document Titles that would exist on the ${municipality} municipal website.
            
            CRITICAL: For each item, include a 'snippet' field containing 2-3 sentences of realistic text content that might be found in that document (containing proper nouns, names, or local places).

            Include 3 PDFs (agendas/minutes), 1 HTML page (About Us/Elected Officials), and 1 Video link.
            
            Return a JSON array.`,
            config: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.ARRAY,
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            title: { type: Type.STRING },
                            url: { type: Type.STRING },
                            type: { type: Type.STRING, enum: ['PDF', 'Video', 'Web', 'Scraped Data'] },
                            date: { type: Type.STRING },
                            snippet: { type: Type.STRING, description: "A preview of the text content found at this source" }
                        }
                    }
                }
            }
        });
        return response.text ? JSON.parse(response.text) : [];
    } catch (e) {
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
