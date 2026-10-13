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
import { itemsToEntries, mapLimit, GEMINI_TEXT_MODEL, textModelConfig } from './context-sources.js';
import { brainActive, getBrainConfig, extractItemsWithOllama } from './local-llm.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// In pkg builds, __dirname is inside a read-only snapshot and the executable
// lives inside a code-signed .app bundle — writing next to it would break the
// signature (Gatekeeper then reports the app as damaged). Packaged builds keep
// their data in ~/.community-captioner/data (same folder cloudflared uses);
// dev keeps using <repo>/.data.
import { homedir } from 'os';
export const DATA_DIR = typeof process.pkg !== 'undefined'
  ? join(homedir(), '.community-captioner', 'data')
  : join(__dirname, '..', '.data');
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

// Auto-Learn (5 s budget) and Quick Names (8 s budget) need a model that answers
// fast without thinking. Measured 2026-10-13: gemini-3.5-flash-lite 1.8 s for a
// 30 s transcript (18 entries, parseable) and 2.6 s for six names (18 entries);
// gemini-2.5-flash spent its whole 512-token output budget on thinking
// (finish=MAX_TOKENS, nothing parseable) and took 3–10 s; gemini-3.8-flash with
// low thinking took 3.9 s / 8.5 s — over the Quick Names budget and it rewrote
// "Pearlman" as "Perlman". Lite models do not think and reject thinkingBudget.
const LEARNER_MODEL = process.env.GEMINI_LEARNER_MODEL || 'gemini-3.5-flash-lite';

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
    const useBrain = brainActive();
    if (isExtracting || (!geminiApiKey && !useBrain) || textBuffer.length < MIN_BUFFER_LENGTH) return;
    isExtracting = true;

    const text = textBuffer;
    textBuffer = ''; // Clear buffer for next accumulation

    // Fully Local mode: the Ollama brain extracts from the live transcript instead of Gemini
    if (useBrain) {
        try {
            const b = getBrainConfig();
            const r = await extractItemsWithOllama(text.slice(0, 6000), { url: b.url, model: b.model, domainHint: 'a live public meeting transcript' });
            const entries = itemsToEntries(r.items);
            const existingKeys = new Set([
                ...activeDictionary.map(e => `${e.original.toLowerCase()}→${e.replacement.toLowerCase()}`),
                ...suggestions.map(e => `${e.original.toLowerCase()}→${e.replacement.toLowerCase()}`),
            ]);
            let newCount = 0;
            for (const entry of entries) {
                const key = `${entry.original.toLowerCase()}→${entry.replacement.toLowerCase()}`;
                if (existingKeys.has(key) || entry.original.toLowerCase() === entry.replacement.toLowerCase()) continue;
                suggestions.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, original: entry.original, replacement: entry.replacement, type: entry.type || 'proper_noun', note: entry.note, source: 'auto_learned', timestamp: Date.now() });
                existingKeys.add(key);
                newCount++;
            }
            lastExtractionTime = Date.now();
            extractionCount++;
            if (newCount > 0) console.log(`[Learner] (${b.model}) Extracted ${newCount} new suggestions (${suggestions.length} total pending)`);
        } catch (e) {
            console.warn('[Learner] Ollama extraction error:', e.message);
            textBuffer = text + (textBuffer ? ' ' + textBuffer : '');
        }
        isExtracting = false;
        return;
    }

    try {
        const { GoogleGenAI } = await import('@google/genai');
        const ai = new GoogleGenAI({ apiKey: geminiApiKey });

        const prompt = `Extract proper nouns, place names, organization names, and acronyms from this live meeting transcript. For each, suggest what a speech-to-text engine might mishear it as (the "original") and the correct form (the "replacement"). Only include words that STT commonly misspells.

Return ONLY a JSON array of objects: [{"original": "misheard form", "replacement": "correct form", "type": "proper_noun|place|acronym"}]

Transcript:
${text.slice(0, 15000)}`;

        const response = await Promise.race([
            ai.models.generateContent({
                model: LEARNER_MODEL,
                contents: prompt,
                // JSON mode so the array is never wrapped in ``` fences; 1024 tokens (was 512)
                // because a pretty-printed array of 15–20 suggestions is ~600 tokens and the
                // old cap cut it mid-object (finish=MAX_TOKENS → parse failure).
                config: { maxOutputTokens: 1024, temperature: 0.2, responseMimeType: 'application/json' }
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
const EXTRACT_CHUNK_CHARS = 24000;   // ~6k tokens per request keeps latency low
const EXTRACT_MAX_CHUNKS = 6;        // ~144k chars of document text (very long agendas)
const EXTRACT_MAX_ENTRIES = 400;

/** Split text on paragraph/line boundaries into chunks of roughly `size` chars. */
function splitTextIntoChunks(text, size) {
    const chunks = [];
    let rest = text;
    while (rest.length > size) {
        let cut = rest.lastIndexOf('\n\n', size);
        if (cut < size * 0.5) cut = rest.lastIndexOf('\n', size);
        if (cut < size * 0.5) cut = rest.lastIndexOf('. ', size);
        if (cut < size * 0.5) cut = size;
        chunks.push(rest.slice(0, cut));
        rest = rest.slice(cut).trim();
    }
    if (rest) chunks.push(rest);
    return chunks;
}

function parseItemsArray(raw) {
    if (!raw) return [];
    let s = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    let v = null;
    try { v = JSON.parse(s); } catch {
        const start = s.indexOf('['), end = s.lastIndexOf(']');
        if (start !== -1 && end > start) { try { v = JSON.parse(s.slice(start, end + 1)); } catch {} }
    }
    if (v && !Array.isArray(v) && Array.isArray(v.entries)) v = v.entries;
    return Array.isArray(v) ? v : [];
}

/**
 * Extract dictionary entries from document text (agenda, minutes, roster,
 * scraped web page). Long documents are chunked and processed in parallel.
 *
 * Returns dictionary entries: [{ original, replacement, type, note? }].
 * The `original` forms are the lowercase spelling plus plausible speech-to-text
 * mishearings, so the live caption regex substitution catches both.
 */
export async function extractDictionary(text, apiKeyOverride, { domainHint = '' } = {}) {
    const key = apiKeyOverride || geminiApiKey;
    if (!key || !text || !text.trim()) {
        if (!key) console.warn('[Learner] extractDictionary: no Gemini API key available');
        return [];
    }

    const cleaned = text.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    const chunks = splitTextIntoChunks(cleaned, EXTRACT_CHUNK_CHARS).slice(0, EXTRACT_MAX_CHUNKS);
    console.log(`[Learner] extractDictionary: ${cleaned.length} chars → ${chunks.length} chunk(s), model=${GEMINI_TEXT_MODEL}`);

    let ai;
    try {
        const { GoogleGenAI } = await import('@google/genai');
        ai = new GoogleGenAI({ apiKey: key });
    } catch (e) {
        console.warn('[Learner] Gemini SDK unavailable:', e.message);
        return [];
    }

    const started = Date.now();
    const perChunk = await mapLimit(chunks, 3, async (chunk, i) => {
        const prompt = `You are preparing a correction dictionary for live closed captions of ${domainHint || 'a public meeting'}.
From the document text below, extract every proper noun a speech-to-text engine could get wrong:
- people's full names (put their title/role in "detail")
- boards, committees, commissions, departments and organizations
- places: streets, squares, neighborhoods, parks, buildings, schools, neighboring towns
- project, program and plan names; ordinances and warrant articles by name
- acronyms and abbreviations (put the expansion in "detail")
Skip generic words, lone first names, dates, dollar amounts, URLs, domain names, email addresses, website navigation labels and other page furniture.

Return ONLY a JSON array of objects:
{"name": "<exact spelling as written in the document>", "category": "<elected_official|staff|board_or_committee|department|organization|place|school|acronym|term>", "detail": "<role, expansion or short context>", "misheard": ["<1-3 plausible lowercase speech-to-text errors; empty if it sounds like it is spelled>"]}

Document${chunks.length > 1 ? ` (part ${i + 1} of ${chunks.length})` : ''}:
${chunk}`;
        try {
            const response = await Promise.race([
                ai.models.generateContent({
                    model: GEMINI_TEXT_MODEL,
                    contents: prompt,
                    config: textModelConfig({ maxOutputTokens: 8192, temperature: 0.1, responseMimeType: 'application/json' }),
                }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout after 60s')), 60000)),
            ]);
            return parseItemsArray(response?.text);
        } catch (e) {
            console.warn(`[Learner] extractDictionary chunk ${i + 1} failed:`, e.message);
            return [];
        }
    });

    // Merge items across chunks (first occurrence wins, but keep the richer detail)
    const byName = new Map();
    for (const items of perChunk) {
        if (!Array.isArray(items)) continue;
        for (const it of items) {
            if (!it || typeof it.name !== 'string') continue;
            const name = it.name.trim().replace(/\s+/g, ' ');
            if (name.length < 2) continue;
            const k = name.toLowerCase();
            const existing = byName.get(k);
            const item = {
                name,
                category: typeof it.category === 'string' ? it.category : 'proper_noun',
                detail: typeof it.detail === 'string' ? it.detail.trim().slice(0, 140) : '',
                misheard: Array.isArray(it.misheard) ? it.misheard.filter(m => typeof m === 'string').map(m => m.trim().toLowerCase()).filter(Boolean).slice(0, 3) : [],
            };
            if (!existing) byName.set(k, item);
            else {
                if (!existing.detail && item.detail) existing.detail = item.detail;
                for (const m of item.misheard) if (!existing.misheard.includes(m) && existing.misheard.length < 3) existing.misheard.push(m);
            }
        }
    }

    const entries = itemsToEntries([...byName.values()]).slice(0, EXTRACT_MAX_ENTRIES);
    console.log(`[Learner] extractDictionary: ${byName.size} names → ${entries.length} entries in ${Date.now() - started}ms`);
    return entries;
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
                model: LEARNER_MODEL,
                contents: prompt,
                config: { maxOutputTokens: 2048, temperature: 0.3, responseMimeType: 'application/json' }
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
        geminiKeySet: !!geminiApiKey || brainActive(),
        engine: brainActive() ? `ollama:${getBrainConfig().model}` : geminiApiKey ? 'gemini' : 'none',
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
