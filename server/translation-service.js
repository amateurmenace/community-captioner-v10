/**
 * Translation Service — Server-side Gemini translation with LRU cache.
 * Each unique (text, lang) pair is translated once and cached.
 * Multiple audience viewers requesting the same language share one Gemini call.
 */

let geminiApiKey = null;

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
export async function translateCaption(text, targetLang) {
    if (!text || targetLang === 'en') return text;
    if (!geminiApiKey) {
        console.warn('[Translation] No API key set — returning original text');
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
    const translationPromise = doTranslate(text, targetLang, langName, cacheKey);
    inFlight.set(cacheKey, translationPromise);

    try {
        return await translationPromise;
    } finally {
        inFlight.delete(cacheKey);
    }
}

async function doTranslate(text, targetLang, langName, cacheKey) {
    try {
        const { GoogleGenAI } = await import('@google/genai');
        const ai = new GoogleGenAI({ apiKey: geminiApiKey });

        // Race against 1500ms timeout — Gemini SDK doesn't support AbortController,
        // so we use Promise.race to enforce the timeout
        const response = await Promise.race([
            ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: `Translate the following live caption text to ${langName}. Return ONLY the translated text, nothing else. Do not add quotes or explanations.\n\n${text}`,
                config: {
                    maxOutputTokens: 256,
                    temperature: 0.1,
                },
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500))
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
            console.warn(`[Translation] Timeout (1500ms) for ${targetLang}: "${text.slice(0, 30)}..."`);
        } else {
            console.warn(`[Translation] Error for ${targetLang}: ${e.message}`);
        }
        return text; // Graceful fallback
    }
}
