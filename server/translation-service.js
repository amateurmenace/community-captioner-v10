/**
 * Translation Service — Server-side Gemini translation with LRU cache.
 * Each unique (text, lang) pair is translated once and cached.
 * Multiple audience viewers requesting the same language share one Gemini call.
 */

let geminiApiKey = null;

// Quality path: the audience reads nothing but this text. gemini-3.8-flash with
// thinkingLevel LOW measured 1.1–2.2 s per caption from the studio PC (es/zh/ht all
// sane), inside the 4 s audience budget and the 10 s Dashboard budget; languages are
// translated in parallel and each caption is cached per language. Thinking must be
// capped: at the default level the model spent ~240 thought tokens against the
// 256-token output cap and returned truncated translations (finish=MAX_TOKENS).
// The faster models (2.5-flash-lite 0.4 s, 3.5-flash-lite 1.0 s) are a fallback via
// GEMINI_TRANSLATE_MODEL when latency matters more than quality.
const TRANSLATE_MODEL = process.env.GEMINI_TRANSLATE_MODEL || 'gemini-3.8-flash';
const TRANSLATE_THINKING = /gemini-2\.5/.test(TRANSLATE_MODEL) ? { thinkingBudget: 0 }
    : /flash-lite/.test(TRANSLATE_MODEL) ? undefined   // lite models do not think; thinkingBudget is rejected by 3.5-flash-lite
    : { thinkingLevel: 'LOW' };

// LRU Cache: key = "lang:text", value = {translated, ts}
const cache = new Map();
const CACHE_MAX = 500;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let stats = { hits: 0, misses: 0, errors: 0 };

// In-flight dedup: if a translation is already in progress for (text, lang), wait for it
const inFlight = new Map();

const SUPPORTED_LANGUAGES = {
    en: 'English',
    es: 'Spanish',
    zh: 'Chinese (Simplified)',
    fr: 'French',
    pt: 'Portuguese',
    ht: 'Haitian Creole',
    ru: 'Russian',
    ar: 'Arabic',
    vi: 'Vietnamese',
    ko: 'Korean',
    ja: 'Japanese',
    de: 'German',
    it: 'Italian',
    pl: 'Polish',
    tl: 'Tagalog',
};

export function setApiKey(key) {
    geminiApiKey = key || null;
}

// Local AI brain (Ollama) translates captions when it is enabled — nothing
// leaves the machine. Loaded lazily to keep module start-up cheap.
let _localLlm = null;
async function localLlm() {
    if (!_localLlm) _localLlm = await import('./local-llm.js');
    return _localLlm;
}
export async function translationAvailable() {
    if (geminiApiKey) return true;
    try { return (await localLlm()).brainActive(); } catch { return false; }
}

async function translateWithLocalBrain(text, targetLang) {
    const { getBrainConfig, ollamaText } = await localLlm();
    const b = getBrainConfig();
    const langName = SUPPORTED_LANGUAGES[targetLang] || targetLang;
    const r = await ollamaText({
        url: b.url, model: b.model, maxTokens: 300, timeoutMs: 12000,
        prompt: `Translate the following live caption from English into ${langName}. Output only the translation, no quotes, no notes.\n\n${text}`,
    });
    return r.text.replace(/^["“]|["”]$/g, '').trim();
}

export function getSupportedLanguages() {
    return Object.entries(SUPPORTED_LANGUAGES).map(([code, name]) => ({ code, name }));
}

export function getCacheStats() {
    // Clean expired entries
    const now = Date.now();
    for (const [key, val] of cache) {
        if (now - val.ts > CACHE_TTL_MS) cache.delete(key);
    }
    return {
        ...stats,
        cacheSize: cache.size,
        inFlightCount: inFlight.size,
    };
}

/**
 * Translate caption text to target language.
 * Returns translated string, or original text on failure.
 */
export async function translateCaption(text, targetLang, { timeoutMs = 4000 } = {}) {
    if (!text || targetLang === 'en') return text;
    if (!geminiApiKey && !(await translationAvailable())) {
        console.warn('[Translation] No translation engine (no Gemini key, local brain off) — returning original text');
        return text;
    }

    const langName = SUPPORTED_LANGUAGES[targetLang];
    if (!langName) {
        console.warn(`[Translation] Unsupported language: ${targetLang}`);
        return text;
    }

    const cacheKey = `${targetLang}:${text}`;

    // Check cache
    const cached = cache.get(cacheKey);
    if (cached && (Date.now() - cached.ts < CACHE_TTL_MS)) {
        stats.hits++;
        return cached.translated;
    }

    // Check if translation already in flight (dedup concurrent requests)
    if (inFlight.has(cacheKey)) {
        stats.hits++;
        return inFlight.get(cacheKey);
    }

    stats.misses++;

    // Create the translation promise
    const translationPromise = doTranslate(text, targetLang, langName, cacheKey, timeoutMs);
    inFlight.set(cacheKey, translationPromise);

    try {
        return await translationPromise;
    } finally {
        inFlight.delete(cacheKey);
    }
}

async function doTranslate(text, targetLang, langName, cacheKey, timeoutMs = 4000) {
    // Local AI brain first (Fully Local mode): the caption never leaves the machine
    let useLocal = false;
    try { useLocal = (await localLlm()).brainActive(); } catch {}
    if (useLocal) {
        try {
            const translated = await translateWithLocalBrain(text, targetLang);
            if (translated) {
                cache.set(cacheKey, { translated, ts: Date.now() });
                if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
                console.log(`[Translation] local ${targetLang}: "${text.slice(0, 40)}" → "${translated.slice(0, 40)}"`);
                stats.local = (stats.local || 0) + 1;
                return translated;
            }
        } catch (e) {
            console.warn(`[Translation] Local brain failed (${e.message})${geminiApiKey ? ' — falling back to Gemini' : ''}`);
            if (!geminiApiKey) { stats.errors++; return text; }
        }
    }
    try {
        const { GoogleGenAI } = await import('@google/genai');
        const ai = new GoogleGenAI({ apiKey: geminiApiKey });

        // Race against a timeout — the Gemini SDK doesn't support AbortController, so
        // Promise.race enforces it. 4 s for the audience path (a caption that arrives
        // 3 s late is still useful; one in English is not), 10 s for the Dashboard.
        const response = await Promise.race([
            ai.models.generateContent({
                model: TRANSLATE_MODEL,
                contents: `Translate the following live caption text to ${langName}. Return ONLY the translated text, nothing else. Do not add quotes or explanations.\n\n${text}`,
                config: {
                    // 512 (was 256): LOW thinking occasionally spends ~120 tokens, and CJK/Arabic
                    // renderings of a two-row caption run longer than the English.
                    maxOutputTokens: 512,
                    temperature: 0.1,
                    ...(TRANSLATE_THINKING ? { thinkingConfig: TRANSLATE_THINKING } : {}),
                },
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs))
        ]);

        const translated = response?.text?.trim();
        if (!translated) {
            console.warn(`[Translation] Empty response for ${targetLang}`);
            stats.errors++;
            return text;
        }

        // Store in cache (evict oldest if full)
        if (cache.size >= CACHE_MAX) {
            const oldest = cache.keys().next().value;
            cache.delete(oldest);
        }
        cache.set(cacheKey, { translated, ts: Date.now() });

        console.log(`[Translation] ${targetLang}: "${text.slice(0, 40)}..." → "${translated.slice(0, 40)}..."`);
        return translated;
    } catch (e) {
        stats.errors++;
        if (e.message === 'timeout') {
            console.warn(`[Translation] Timeout (${timeoutMs}ms) for ${targetLang}: "${text.slice(0, 30)}..." — returning the original`);
        } else {
            console.warn(`[Translation] Error for ${targetLang}: ${e.message}`);
        }
        return text; // Graceful fallback
    }
}
