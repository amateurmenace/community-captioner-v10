/**
 * Caption Text Polisher
 *
 * Two-layer text cleanup for broadcast-quality captions:
 *   Layer 1: Local rules (zero latency, always active)
 *   Layer 2: Gemini AI polish (optional, ~300ms, requires API key)
 */

// --- Layer 1: Local Rules ---

// Common STT split-contraction fixes
const CONTRACTION_FIXES = [
    [/\bdo n't\b/gi, "don't"],
    [/\bca n't\b/gi, "can't"],
    [/\bwo n't\b/gi, "won't"],
    [/\bsha n't\b/gi, "shan't"],
    [/\bi 'm\b/gi, "I'm"],
    [/\bi 've\b/gi, "I've"],
    [/\bi 'll\b/gi, "I'll"],
    [/\bi 'd\b/gi, "I'd"],
    [/\bwe 're\b/gi, "we're"],
    [/\bwe 've\b/gi, "we've"],
    [/\bwe 'll\b/gi, "we'll"],
    [/\bthey 're\b/gi, "they're"],
    [/\bthey 've\b/gi, "they've"],
    [/\bthey 'll\b/gi, "they'll"],
    [/\byou 're\b/gi, "you're"],
    [/\byou 've\b/gi, "you've"],
    [/\byou 'll\b/gi, "you'll"],
    [/\bit 's\b/gi, "it's"],
    [/\bthat 's\b/gi, "that's"],
    [/\bwhat 's\b/gi, "what's"],
    [/\bthere 's\b/gi, "there's"],
    [/\bhere 's\b/gi, "here's"],
    [/\blet 's\b/gi, "let's"],
    [/\bisn 't\b/gi, "isn't"],
    [/\baren 't\b/gi, "aren't"],
    [/\bwasn 't\b/gi, "wasn't"],
    [/\bweren 't\b/gi, "weren't"],
    [/\bhasn 't\b/gi, "hasn't"],
    [/\bhaven 't\b/gi, "haven't"],
    [/\bhadn 't\b/gi, "hadn't"],
    [/\bdoesn 't\b/gi, "doesn't"],
    [/\bdidn 't\b/gi, "didn't"],
    [/\bcouldn 't\b/gi, "couldn't"],
    [/\bwouldn 't\b/gi, "wouldn't"],
    [/\bshouldn 't\b/gi, "shouldn't"],
];

// Unicode → ASCII normalization for CEA-608 compatibility
const UNICODE_MAP = {
    '\u2018': "'", '\u2019': "'",   // Smart single quotes
    '\u201C': '"', '\u201D': '"',   // Smart double quotes
    '\u2013': '-', '\u2014': '-',   // En/em dashes
    '\u2026': '...',                // Ellipsis
    '\u00A0': ' ',                  // Non-breaking space
    '\u200B': '',                   // Zero-width space
    '\u00E9': 'e', '\u00E8': 'e',  // Accented e
    '\u00E0': 'a', '\u00E1': 'a',  // Accented a
    '\u00F1': 'n',                  // Tilde n
    '\u00FC': 'u', '\u00FA': 'u',  // Accented u
    '\u00ED': 'i', '\u00EC': 'i',  // Accented i
    '\u00F3': 'o', '\u00F2': 'o',  // Accented o
};

/**
 * Apply local text cleanup rules. Zero latency, always active.
 * @param {string} text - Raw STT output
 * @returns {string} Cleaned text
 */
export function localPolish(text) {
    if (!text || typeof text !== 'string') return '';

    let result = text;

    // 1. Trim and collapse whitespace
    result = result.trim().replace(/\s+/g, ' ');

    // 2. Fix split contractions from STT
    for (const [pattern, replacement] of CONTRACTION_FIXES) {
        result = result.replace(pattern, replacement);
    }

    // 3. Normalize unicode to ASCII (must run BEFORE capitalization so "…hello" becomes "...hello" first)
    for (const [unicode, ascii] of Object.entries(UNICODE_MAP)) {
        result = result.replaceAll(unicode, ascii);
    }

    // 3b. Handle combining diacritics not in the map (strip accents via NFD decomposition)
    result = result.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    // 4. Capitalize first letter of each sentence (after unicode normalization)
    result = result.replace(/(^|[.!?.]{1,3}\s+)([a-z])/g, (_, prefix, letter) => {
        return prefix + letter.toUpperCase();
    });

    // 5. Capitalize standalone "I"
    result = result.replace(/\bi\b/g, 'I');

    // 6. Add period at end if no terminal punctuation
    if (result.length > 0 && !/[.!?,;:\-]$/.test(result)) {
        result = result + '.';
    }

    return result;
}


// --- Layer 2: Gemini AI Polish ---

let geminiApiKey = process.env.GEMINI_API_KEY || null;
let geminiEnabled = true;  // Can be toggled via API

const POLISH_PROMPT = `Fix grammar, punctuation, and capitalization only. Do not change the meaning, add words, or remove words. Preserve the speaker's natural phrasing. Return ONLY the corrected text with no explanation or quotes.`;

/**
 * Polish text using Gemini Flash API.
 * Returns local-polished text if Gemini fails or times out.
 *
 * @param {string} text - Text to polish (already local-polished)
 * @returns {Promise<string>} Polished text
 */
async function geminiPolish(text) {
    if (!geminiApiKey || !geminiEnabled) return text;
    if (text.length < 5) return text;

    try {
        const { GoogleGenAI } = await import('@google/genai');
        const ai = new GoogleGenAI({ apiKey: geminiApiKey });

        // Race against 500ms timeout for real-time captioning
        const result = await Promise.race([
            ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: `${POLISH_PROMPT}\n\nText: ${text}`,
                config: { maxOutputTokens: 256, temperature: 0.1 }
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 500))
        ]);

        const polished = result?.text?.trim();
        if (!polished || polished.length === 0) return text;

        if (polished.length > text.length * 2 || polished.length < text.length * 0.3) {
            return text;
        }

        console.log(`[Polish] Gemini: "${text}" → "${polished}"`);
        return polished;
    } catch (e) {
        if (e.message === 'timeout') {
            console.warn('[Polish] Gemini timed out (500ms), using local result');
        } else {
            console.warn('[Polish] Gemini error:', e.message);
        }
        return text;
    }
}

/**
 * Summarize/condense text using Gemini Flash API.
 * Used when caption strategy is 'summarize' to fit speech into CEA-608 bandwidth.
 * Falls back to truncation if Gemini fails or times out.
 *
 * @param {string} text - Text to condense
 * @param {number} maxChars - Target character limit
 * @returns {Promise<string>} Condensed text
 */
async function geminiSummarize(text, maxChars) {
    if (!geminiApiKey || !geminiEnabled) return truncateAtWord(text, maxChars);
    if (text.length <= maxChars) return text;

    try {
        const { GoogleGenAI } = await import('@google/genai');
        const ai = new GoogleGenAI({ apiKey: geminiApiKey });

        const result = await Promise.race([
            ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: `Condense this speech excerpt to under ${maxChars} characters. Keep the key meaning and important words. Do not add interpretation. Return ONLY the condensed text.\n\nText: ${text}`,
                config: { maxOutputTokens: 128, temperature: 0.1 }
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 800))
        ]);

        const summary = result?.text?.trim();
        if (!summary || summary.length === 0) return truncateAtWord(text, maxChars);
        if (summary.length > maxChars) return truncateAtWord(summary, maxChars);

        console.log(`[Polish] Summarize: "${text.slice(0,40)}..." → "${summary}"`);
        return summary;
    } catch (e) {
        if (e.message === 'timeout') {
            console.warn('[Polish] Summarize timed out (800ms), truncating');
        } else {
            console.warn('[Polish] Summarize error:', e.message);
        }
        return truncateAtWord(text, maxChars);
    }
}

/**
 * Truncate text at a word boundary.
 */
function truncateAtWord(text, maxChars) {
    if (text.length <= maxChars) return text;
    let truncated = text.slice(0, maxChars);
    const lastSpace = truncated.lastIndexOf(' ');
    if (lastSpace > maxChars * 0.5) {
        truncated = truncated.slice(0, lastSpace);
    }
    return truncated;
}


// --- Public API ---

/**
 * Polish caption text through both layers.
 * Layer 1 (local) always runs. Layer 2 (Gemini) is optional.
 *
 * @param {string} text - Raw caption text
 * @returns {Promise<string>} Polished text
 */
export async function polish(text) {
    // Layer 1: Local rules (always)
    let result = localPolish(text);

    // Layer 2: Gemini (optional)
    if (geminiApiKey && geminiEnabled) {
        result = await geminiPolish(result);
    }

    return result;
}

/**
 * Set the Gemini API key at runtime.
 */
export function setApiKey(key) {
    geminiApiKey = key || null;
}

/**
 * Enable/disable Gemini polishing.
 * @returns {boolean} New enabled state
 */
export function toggleGemini() {
    geminiEnabled = !geminiEnabled;
    console.log(`[Polish] Gemini ${geminiEnabled ? 'enabled' : 'disabled'}`);
    return geminiEnabled;
}

/**
 * Get polisher status.
 */
export function getStatus() {
    return {
        localEnabled: true,
        geminiEnabled: geminiEnabled,
        geminiKeySet: !!geminiApiKey,
    };
}

/**
 * Summarize caption text to fit within character limit.
 * Uses Gemini if available, falls back to truncation.
 *
 * @param {string} text - Raw caption text
 * @param {number} maxChars - Target character limit
 * @returns {Promise<string>} Condensed text
 */
export async function summarize(text, maxChars = 64) {
    // Always apply local polish first
    let result = localPolish(text);
    // Then summarize/condense
    result = await geminiSummarize(result, maxChars);
    return result;
}

export { truncateAtWord };
