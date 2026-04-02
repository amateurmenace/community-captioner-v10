/**
 * Context Auto-Learner
 *
 * Background worker that accumulates finalized caption text and periodically
 * asks Gemini to extract proper nouns, places, and acronyms. Runs completely
 * async — never blocks caption delivery.
 *
 * Flow:
 *   1. feedText(text) — called after each final caption (non-blocking push)
 *   2. Every 30s, accumulated text is sent to Gemini for extraction
 *   3. New entries land in suggestions[] for operator review
 *   4. Operator accepts/dismisses via API
 *   5. Accepted entries are added to the active dictionary
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// In pkg builds, __dirname is inside a read-only snapshot.
// Use the directory next to the executable for writable data.
const BASE_DIR = typeof process.pkg !== 'undefined'
  ? dirname(process.execPath)
  : join(__dirname, '..');
const DATA_DIR = join(BASE_DIR, '.data');
const DICTIONARY_FILE = join(DATA_DIR, 'dictionary.json');

let geminiApiKey = null;
let enabled = false;
let textBuffer = '';
let suggestions = [];  // Pending suggestions awaiting operator review
let activeDictionary = [];  // Server-side copy of the active dictionary
let extractionTimer = null;
let isExtracting = false;
let lastExtractionTime = null;
let extractionCount = 0;

const EXTRACTION_INTERVAL_MS = 30000; // 30 seconds
const MIN_BUFFER_LENGTH = 100; // Don't extract from tiny buffers

// --- Persistence ---

function loadDictionaryFromDisk() {
    try {
        if (existsSync(DICTIONARY_FILE)) {
            const data = JSON.parse(readFileSync(DICTIONARY_FILE, 'utf-8'));
            if (Array.isArray(data)) {
                activeDictionary = data;
                console.log(`[Learner] Loaded ${data.length} dictionary entries from disk`);
            }
        }
    } catch (e) {
        console.warn('[Learner] Failed to load dictionary from disk:', e.message);
    }
}

function saveDictionaryToDisk() {
    try {
        if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
        writeFileSync(DICTIONARY_FILE, JSON.stringify(activeDictionary, null, 2), 'utf-8');
    } catch (e) {
        console.warn('[Learner] Failed to save dictionary to disk:', e.message);
    }
}

// Load on module init
loadDictionaryFromDisk();

/**
 * Feed finalized caption text into the learner buffer.
 * This is a non-blocking push — returns immediately.
 */
export function feedText(text) {
    if (!enabled || !text) return;
    textBuffer += (textBuffer ? ' ' : '') + text.trim();
}

/**
 * Run extraction on the accumulated buffer.
 * Called by the timer — never blocks the caller.
 */
async function extractFromBuffer() {
    if (isExtracting || !geminiApiKey || textBuffer.length < MIN_BUFFER_LENGTH) return;
    isExtracting = true;

    const text = textBuffer;
    textBuffer = ''; // Clear buffer for next accumulation

    try {
        const { GoogleGenAI } = await import('@google/genai');
        const ai = new GoogleGenAI({ apiKey: geminiApiKey });

        const prompt = `Extract proper nouns, place names, organization names, and acronyms from this live meeting transcript. For each, suggest what a speech-to-text engine might mishear it as (the "original") and the correct form (the "replacement"). Only include words that STT commonly misspells.

Return ONLY a JSON array of objects: [{"original": "misheard form", "replacement": "correct form", "type": "proper_noun|place|acronym"}]

Transcript:
${text.slice(0, 15000)}`;

        const response = await Promise.race([
            ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: prompt,
                config: { maxOutputTokens: 512, temperature: 0.2 }
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
        ]);

        const rawText = response?.text?.trim();
        if (!rawText) { isExtracting = false; return; }

        let entries;
        try {
            entries = JSON.parse(rawText);
        } catch {
            let cleaned = rawText.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
            const start = cleaned.indexOf('[');
            const end = cleaned.lastIndexOf(']');
            if (start !== -1 && end > start) cleaned = cleaned.slice(start, end + 1);
            try { entries = JSON.parse(cleaned); } catch {
                console.warn('[Learner] Failed to parse Gemini JSON:', rawText.slice(0, 100));
                isExtracting = false;
                return;
            }
        }

        if (!Array.isArray(entries)) { isExtracting = false; return; }

        // Deduplicate against existing dictionary and suggestions
        const existingKeys = new Set([
            ...activeDictionary.map(e => `${e.original.toLowerCase()}→${e.replacement.toLowerCase()}`),
            ...suggestions.map(e => `${e.original.toLowerCase()}→${e.replacement.toLowerCase()}`),
        ]);

        let newCount = 0;
        for (const entry of entries) {
            if (!entry.original || !entry.replacement) continue;
            const key = `${entry.original.toLowerCase()}→${entry.replacement.toLowerCase()}`;
            if (existingKeys.has(key)) continue;
            if (entry.original.toLowerCase() === entry.replacement.toLowerCase()) continue;

            suggestions.push({
                id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                original: entry.original,
                replacement: entry.replacement,
                type: entry.type || 'proper_noun',
                source: 'auto_learned',
                timestamp: Date.now(),
            });
            existingKeys.add(key);
            newCount++;
        }

        lastExtractionTime = Date.now();
        extractionCount++;
        if (newCount > 0) {
            console.log(`[Learner] Extracted ${newCount} new suggestions (${suggestions.length} total pending)`);
        }
    } catch (e) {
        if (e.name === 'AbortError') {
            console.warn('[Learner] Gemini extraction timed out (2s)');
        } else {
            console.warn('[Learner] Extraction error:', e.message);
        }
        // Put text back
        textBuffer = text + (textBuffer ? ' ' + textBuffer : '');
    }

    isExtracting = false;
}

/**
 * Extract dictionary entries from arbitrary text (for scraping/paste).
 * Returns entries directly (used by scrape endpoint).
 */
export async function extractDictionary(text, apiKeyOverride) {
    const key = apiKeyOverride || geminiApiKey;
    console.log(`[Learner] extractDictionary called: text=${text?.length || 0} chars, keyOverride=${!!apiKeyOverride}, globalKey=${!!geminiApiKey}, effectiveKey=${!!key} (${key?.slice(0,8)}...)`);
    if (!key || !text) {
        console.warn(`[Learner] extractDictionary: BAILING - key=${!!key}, text=${!!text}`);
        return [];
    }

    try {
        // Use the @google/genai SDK — same as the frontend — to avoid REST API model availability issues
        const { GoogleGenAI } = await import('@google/genai');
        const ai = new GoogleGenAI({ apiKey: key });

        const prompt = `You are a caption accuracy assistant for live broadcast captioning. Extract all proper nouns, place names, organization names, people's names, titles, and acronyms from this document.

For each, provide a JSON object with:
- "original": how a speech-to-text engine might mishear this word (common phonetic misspellings)
- "replacement": the correct spelling
- "type": one of "proper_noun", "place", "acronym", "correction"

Return ONLY a JSON array of objects. Include ONLY entries where STT is likely to make errors.

Document:
${text.slice(0, 30000)}`;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
            config: {
                maxOutputTokens: 4096,
                temperature: 0.2,
                responseMimeType: 'application/json',
            }
        });

        const rawText = response?.text?.trim();
        if (!rawText) {
            console.warn('[Learner] extractDictionary: Gemini returned no text');
            return [];
        }

        console.log(`[Learner] extractDictionary: Got ${rawText.length} chars from Gemini`);

        let entries;
        try {
            entries = JSON.parse(rawText);
        } catch {
            // Find JSON array in response
            const start = rawText.indexOf('[');
            const end = rawText.lastIndexOf(']');
            if (start !== -1 && end > start) {
                try {
                    entries = JSON.parse(rawText.slice(start, end + 1));
                } catch (e2) {
                    console.warn('[Learner] extractDictionary: JSON parse failed. Length:', rawText.length);
                    return [];
                }
            } else {
                console.warn('[Learner] extractDictionary: No JSON array found in response');
                return [];
            }
        }
        return Array.isArray(entries) ? entries : [];
    } catch (e) {
        console.warn('[Learner] extractDictionary error:', e.message);
        return [];
    }
}

/**
 * Generate STT mishearing entries for a list of names/terms.
 * Uses Gemini to predict phonetic confusions; falls back to simple lowercase.
 */
export async function generateMishearings(names, apiKeyOverride) {
    const key = apiKeyOverride || geminiApiKey;
    const cleanNames = names.map(n => n.trim()).filter(n => n.length > 0);
    if (cleanNames.length === 0) return [];

    // Fallback: no API key — just generate lowercase → original case entries
    if (!key) {
        console.log(`[Learner] generateMishearings: no API key, using lowercase fallback for ${cleanNames.length} names`);
        return cleanNames.map(name => ({
            original: name.toLowerCase(),
            replacement: name,
            type: 'proper_noun',
        })).filter(e => e.original !== e.replacement);
    }

    try {
        const { GoogleGenAI } = await import('@google/genai');
        const ai = new GoogleGenAI({ apiKey: key });

        const nameList = cleanNames.map(n => `- ${n}`).join('\n');
        const prompt = `You are an expert on speech-to-text errors. For each name/term below, generate 1-3 ways a speech-to-text engine (Google, Whisper, WebSpeech) might mishear or misspell it.

Focus on:
- Phonetic confusions (Pham → "Fam" or "Pam", Greene → "Green", Smythe → "Smith")
- Dropped middle initials or titles (Bernard W. Greene → "Bernard Green")
- Foreign names commonly anglicized (Nguyen → "Win", Beauchamp → "Beecham")
- Acronyms that STT spells out or gets wrong

Return ONLY a JSON array: [{"original": "misheard form (lowercase)", "replacement": "correct form", "type": "proper_noun"}]
Include the simple lowercase version too if the name has unusual capitalization or punctuation.
Do NOT include entries where original equals replacement.

Names/Terms:
${nameList}`;

        const response = await Promise.race([
            ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: prompt,
                config: { maxOutputTokens: 2048, temperature: 0.3 }
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000))
        ]);

        const rawText = response?.text?.trim();
        if (!rawText) return cleanNames.map(n => ({ original: n.toLowerCase(), replacement: n, type: 'proper_noun' })).filter(e => e.original !== e.replacement);

        let entries;
        try {
            entries = JSON.parse(rawText);
        } catch {
            let cleaned = rawText.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
            const start = cleaned.indexOf('[');
            const end = cleaned.lastIndexOf(']');
            if (start !== -1 && end > start) cleaned = cleaned.slice(start, end + 1);
            try { entries = JSON.parse(cleaned); } catch {
                console.warn('[Learner] generateMishearings: failed to parse JSON, using fallback');
                return cleanNames.map(n => ({ original: n.toLowerCase(), replacement: n, type: 'proper_noun' })).filter(e => e.original !== e.replacement);
            }
        }

        if (!Array.isArray(entries)) return [];

        // Filter out self-referencing entries and ensure all have required fields
        return entries.filter(e =>
            e.original && e.replacement &&
            e.original.toLowerCase() !== e.replacement.toLowerCase()
        ).map(e => ({
            original: e.original,
            replacement: e.replacement,
            type: e.type || 'proper_noun',
        }));
    } catch (e) {
        console.warn('[Learner] generateMishearings error:', e.message);
        // Fallback to simple lowercase
        return cleanNames.map(n => ({ original: n.toLowerCase(), replacement: n, type: 'proper_noun' })).filter(e => e.original !== e.replacement);
    }
}

// --- Public API ---

export function setApiKey(key) {
    geminiApiKey = key || null;
}

export function setEnabled(val) {
    enabled = !!val;
    if (enabled && !extractionTimer) {
        extractionTimer = setInterval(extractFromBuffer, EXTRACTION_INTERVAL_MS);
        console.log('[Learner] Auto-learning started (30s interval)');
    } else if (!enabled && extractionTimer) {
        clearInterval(extractionTimer);
        extractionTimer = null;
        console.log('[Learner] Auto-learning stopped');
    }
}

export function getSuggestions() {
    return suggestions;
}

export function acceptSuggestion(id) {
    const idx = suggestions.findIndex(s => s.id === id);
    if (idx === -1) return null;
    const entry = suggestions.splice(idx, 1)[0];
    const dictEntry = {
        original: entry.original,
        replacement: entry.replacement,
        type: entry.type,
    };
    activeDictionary.push(dictEntry);
    saveDictionaryToDisk();
    return dictEntry;
}

export function dismissSuggestion(id) {
    const idx = suggestions.findIndex(s => s.id === id);
    if (idx !== -1) suggestions.splice(idx, 1);
}

export function setDictionary(dict) {
    activeDictionary = Array.isArray(dict) ? dict : [];
    saveDictionaryToDisk();
}

export function getDictionary() {
    return activeDictionary;
}

export function getStatus() {
    return {
        enabled,
        geminiKeySet: !!geminiApiKey,
        bufferLength: textBuffer.length,
        pendingSuggestions: suggestions.length,
        dictionarySize: activeDictionary.length,
        lastExtractionTime,
        extractionCount,
        isExtracting,
        minBufferLength: MIN_BUFFER_LENGTH,
        extractionIntervalMs: EXTRACTION_INTERVAL_MS,
    };
}
