/**
 * Caption correction engine — shared by the browser (App.tsx) and the relay.
 *
 *   phoneticKey(word)                 Metaphone-style sound key ("Greene"/"green" → "KRN")
 *   buildCorrectionIndex(dictionary)  precompute exact + phonetic lookups
 *   applyCorrections(text, index, o)  exact pass, then phonetic pass over word windows
 *   diffForRules(oldText, newText)    propose dictionary rules from an operator's edit
 *
 * No Node or browser APIs are used here so the file bundles into both targets.
 */

// Words that must never be replaced on a phonetic match alone (a single
// common word that merely sounds like a surname would corrupt captions).
export const COMMON_WORDS = new Set(`the of and to in a is that for it as was with be by on not he i this are or his from at which but have an had they you were their one all we can her has there been if more when will would who so no she my them what up out about into than its time only could other these two may then do first any like now over such our man me even most made after also did many before must through back years where much your way well down should because each just those people mr how too little state good very make world still own see men work long get here between both life being under never day same another know while last might us great old year off come since against go came right used take three states himself few house use during without again place american around however home small found mrs thought went say part once general high upon school every does got united left number course war until always away something fact though water less public put think almost hand enough far took head yet government system better set told nothing night end why called eyes find going look asked later knew point next program city business give group toward young days let room president side social given present several order national possible rather second face per among form important often things looked early white case become large big need four within felt along children saw best church ever least power development light thing seemed family interest want members mind country area others turned although open god service problem certain kind began different door thus help means sense whole matter perhaps itself times human law line above name example action company hands local show whether five history gave either act today feet across taken anything past quite having seen death experience half really week words car field already themselves information tell college together shall held sure turn full moved mean necessary free control board street road park town hall center hill lake river north south east west new main third low green white black brown gray grey blue red gold silver rose bridge mill wood woods spring summer fall winter stone rock chief clerk director member officer chair vice mayor council committee commission department works fire police health library sewer planning budget meeting minutes agenda article warrant vote motion question item report update discussion approval approve approved review yes okay okay thank thanks please move moved seconded second aye nay abstain motion carries carried adjourn adjourned recess present absent roll call`.split(/\s+/));

const VOWELS = /[aeiou]/;

/** Metaphone-style phonetic key for a single word. Empty string when no letters. */
export function phoneticKey(word) {
    let w = String(word || '').toLowerCase().replace(/[^a-z]/g, '');
    if (!w) return '';
    // A lone letter is a spoken letter ("d p w", "Bernard W. Greene"): key it as
    // itself so spelled-out acronyms and initials never produce an empty key.
    if (w.length === 1) return w.toUpperCase();
    if (/^(kn|gn|pn|ae|wr)/.test(w)) w = w.slice(1);
    else if (w[0] === 'x') w = 's' + w.slice(1);
    else if (w.startsWith('wh')) w = 'w' + w.slice(2);

    let out = '';
    const len = w.length;
    for (let i = 0; i < len; i++) {
        const c = w[i], prev = w[i - 1] || '', next = w[i + 1] || '', next2 = w[i + 2] || '';
        if (c === prev && c !== 'c') continue;
        switch (c) {
            case 'a': case 'e': case 'i': case 'o': case 'u':
                if (i === 0) out += 'A';
                break;
            case 'b':
                if (!(prev === 'm' && i === len - 1)) out += 'B';
                break;
            case 'c':
                if (next === 'i' && next2 === 'a') out += 'X';
                else if (next === 'h') { out += prev === 's' ? 'K' : 'X'; i++; }
                else if (/[eiy]/.test(next)) { if (prev !== 's') out += 'S'; }
                else out += 'K';
                break;
            case 'd':
                if (next === 'g' && /[eiy]/.test(next2)) { out += 'J'; i += 2; }
                else out += 'T';
                break;
            case 'g':
                if (next === 'h') {
                    // "gh" is silent before a consonant or at the end (Moghtader, Hugh, light)
                    if (i + 2 >= len || !VOWELS.test(next2)) { i++; break; }
                    out += 'K'; i++; break;
                }
                if (next === 'n' && (i + 2 === len || (next2 === 'e' && w[i + 3] === 'd'))) break;
                if (/[eiy]/.test(next) && prev !== 'g') out += 'J';
                else out += 'K';
                break;
            case 'h':
                if (VOWELS.test(next) && !/[csptg]/.test(prev)) out += 'H';
                break;
            case 'k':
                if (prev !== 'c') out += 'K';
                break;
            case 'p':
                if (next === 'h') { out += 'F'; i++; } else out += 'P';
                break;
            case 'q': out += 'K'; break;
            case 's':
                if (next === 'h') { out += 'X'; i++; }
                else if (next === 'i' && /[oa]/.test(next2)) out += 'X';
                else out += 'S';
                break;
            case 't':
                if (next === 'i' && /[oa]/.test(next2)) out += 'X';
                else if (next === 'h') { out += '0'; i++; }
                else if (!(next === 'c' && next2 === 'h')) out += 'T';
                break;
            case 'v': out += 'F'; break;
            case 'w': case 'y':
                if (VOWELS.test(next)) out += c.toUpperCase();
                break;
            case 'x': out += 'KS'; break;
            case 'z': out += 'S'; break;
            default: out += c.toUpperCase(); // f j l m n r
        }
    }
    return out;
}

/** Phonetic key of a phrase: per-word keys concatenated (word splits don't matter). */
export function phraseKey(phrase) {
    return String(phrase || '').split(/\s+/).map(phoneticKey).join('');
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const stripPunct = (s) => s.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

/**
 * Precompute lookups for a dictionary. Call again whenever the dictionary changes.
 * Returns { exact: [{entry, regex}], phonetic: Map<key, entry[]>, maxWords }.
 */
export function buildCorrectionIndex(dictionary) {
    const entries = (dictionary || []).filter(e => e && e.original && e.replacement);
    const exact = [...entries]
        .sort((a, b) => b.original.length - a.original.length)
        .map(entry => ({ entry, regex: new RegExp(`\\b${escapeRegex(entry.original.trim())}\\b`, 'gi') }));

    const phonetic = new Map();
    let maxWords = 1;
    const add = (key, entry) => {
        if (!key) return;
        const list = phonetic.get(key);
        if (list) { if (!list.includes(entry)) list.push(entry); }
        else phonetic.set(key, [entry]);
    };
    for (const entry of entries) {
        const words = entry.original.trim().split(/\s+/).length;
        const rWords = entry.replacement.trim().split(/\s+/).length;
        maxWords = Math.max(maxWords, words, rWords);
        add(phraseKey(entry.original), entry);
        add(phraseKey(entry.replacement), entry);
    }
    return { exact, phonetic, maxWords: Math.min(maxWords + 1, 6), size: entries.length };
}

/**
 * Apply corrections to a caption.
 *   sensitivity 0–100 (ContextSettings.sensitivity):
 *     < 30  exact matches only
 *     30–69 + phonetic matches for multi-word rules
 *     ≥ 70  + phonetic matches for single-word proper nouns (never common words)
 * Returns { text, applied: [{ original, replacement, matched, mode }] }.
 */
export function applyCorrections(text, index, { sensitivity = 80 } = {}) {
    if (!text || !index || index.size === 0) return { text, applied: [] };
    const applied = [];
    let out = text;

    // 1. Exact (word-boundary, case-insensitive), longest originals first
    for (const { entry, regex } of index.exact) {
        regex.lastIndex = 0;
        if (regex.test(out)) {
            regex.lastIndex = 0;
            out = out.replace(regex, (m) => (m === entry.replacement ? m : entry.replacement));
            if (out !== text || applied.length === 0) applied.push({ original: entry.original, replacement: entry.replacement, matched: entry.original, mode: 'exact' });
        }
    }
    if (sensitivity < 30 || index.phonetic.size === 0) return { text: out, applied };

    // 2. Phonetic — slide windows of 1..maxWords words over the text
    const tokens = [];
    const re = /\S+/g;
    let m;
    while ((m = re.exec(out)) !== null) {
        const raw = m[0];
        const core = stripPunct(raw);
        tokens.push({ raw, core, start: m.index, end: m.index + raw.length, key: phoneticKey(core) });
    }
    const allowSingle = sensitivity >= 70;
    const replacements = []; // {start, end, text}
    for (let i = 0; i < tokens.length; i++) {
        if (!tokens[i].key) continue;
        let hit = null;
        for (let n = Math.min(index.maxWords, tokens.length - i); n >= 1; n--) {
            const window = tokens.slice(i, i + n);
            if (window.some(t => !t.core)) continue;
            const key = window.map(t => t.key).join('');
            const candidates = index.phonetic.get(key);
            if (!candidates) continue;
            const windowText = window.map(t => t.core).join(' ');
            for (const entry of candidates) {
                if (windowText.toLowerCase() === entry.replacement.toLowerCase()) { hit = { skip: n }; break; } // already correct
                const entryWords = entry.replacement.trim().split(/\s+/).length;
                if (n === 1 && entryWords === 1) {
                    if (!allowSingle) continue;
                    if (entry.type !== 'proper_noun' && entry.type !== 'place' && entry.type !== 'correction') continue;
                    if (window[0].core.length < 4 || COMMON_WORDS.has(window[0].core.toLowerCase())) continue;
                    if (entry.replacement.length < 4 || COMMON_WORDS.has(entry.replacement.toLowerCase())) continue;
                    if (/^[A-Z]{2,}$/.test(window[0].core)) continue; // leave acronyms alone
                } else if (Math.abs(entryWords - n) > 1) {
                    continue; // word-count too different to be the same phrase
                }
                hit = { n, entry, windowText };
                break;
            }
            if (hit) break;
        }
        if (hit && hit.entry) {
            const first = tokens[i], last = tokens[i + hit.n - 1];
            // keep leading/trailing punctuation of the window
            const lead = first.raw.slice(0, first.raw.indexOf(first.core));
            const trail = last.raw.slice(last.raw.indexOf(last.core) + last.core.length);
            replacements.push({ start: first.start, end: last.end, text: lead + hit.entry.replacement + trail });
            applied.push({ original: hit.entry.original, replacement: hit.entry.replacement, matched: hit.windowText, mode: 'phonetic' });
            i += hit.n - 1;
        } else if (hit && hit.skip) {
            i += hit.skip - 1;
        }
    }
    if (replacements.length) {
        let rebuilt = '';
        let pos = 0;
        for (const r of replacements) { rebuilt += out.slice(pos, r.start) + r.text; pos = r.end; }
        out = rebuilt + out.slice(pos);
    }
    return { text: out, applied };
}

/**
 * Compare an operator's edited caption with the original and propose rules.
 * Returns [{ original, replacement }] for replaced word spans (≤ 5 words each).
 */
export function diffForRules(oldText, newText) {
    const a = String(oldText || '').split(/\s+/).filter(Boolean);
    const b = String(newText || '').split(/\s+/).filter(Boolean);
    if (!a.length || !b.length) return [];
    const norm = (s) => stripPunct(s).toLowerCase();
    // LCS table on normalized tokens
    const n = a.length, m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = norm(a[i]) === norm(b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
    // Walk the LCS to collect replaced spans as index ranges [aStart,aEnd) / [bStart,bEnd)
    const hunks = [];
    let i = 0, j = 0, cur = null;
    const open = () => { if (!cur) cur = { aStart: i, aEnd: i, bStart: j, bEnd: j }; };
    const close = () => { if (cur) { cur.aEnd = i; cur.bEnd = j; hunks.push(cur); cur = null; } };
    while (i < n && j < m) {
        if (norm(a[i]) === norm(b[j])) { close(); i++; j++; }
        else if (dp[i + 1][j] >= dp[i][j + 1]) { open(); i++; }
        else { open(); j++; }
    }
    if (i < n || j < m) { open(); i = n; j = m; }
    close();

    const isCapitalized = (w) => /^[A-Z]/.test(stripPunct(w));
    const rules = [];
    for (const h of hunks) {
        let { aStart, aEnd, bStart, bEnd } = h;
        if (aEnd <= aStart || bEnd <= bStart) continue; // pure insert/delete, not a correction
        // A fixed surname is usually part of a name: pull in adjacent capitalized
        // words that the operator left unchanged ("Bernard" + "Greene").
        while (aStart > 0 && bStart > 0 && isCapitalized(b[bStart - 1]) && norm(a[aStart - 1]) === norm(b[bStart - 1]) && (bEnd - bStart) < 5) { aStart--; bStart--; }
        while (aEnd < n && bEnd < m && isCapitalized(b[bEnd]) && norm(a[aEnd]) === norm(b[bEnd]) && (bEnd - bStart) < 5) { aEnd++; bEnd++; }
        if (aEnd - aStart > 5 || bEnd - bStart > 5) continue;
        const original = a.slice(aStart, aEnd).map(w => stripPunct(w)).join(' ').toLowerCase().trim();
        const replacement = b.slice(bStart, bEnd).map(w => stripPunct(w)).join(' ').trim();
        if (!original || !replacement) continue;
        if (original === replacement) continue;
        if (aEnd - aStart === 1 && COMMON_WORDS.has(original)) continue;
        if (/^[\d.,$%]+$/.test(original)) continue;
        rules.push({ original, replacement });
    }
    return rules;
}
