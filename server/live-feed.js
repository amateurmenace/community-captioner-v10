/**
 * live-feed.js — words that are safe to send to a roll-up caption encoder before the
 * recognizer has finished the sentence.
 *
 * Broadcast captions (CART writers, EEG/Lexi, YouTube's own) stream text as it is
 * recognized, a few words behind the speaker; this app used to encode only final
 * captions, so viewers saw nothing for the length of each sentence and then a block.
 * The relay feeds every interim transcript of the current utterance into a LiveFeed;
 * a word is committed once
 *   - it has sat at the same position in the last `stable` interims,
 *   - it first appeared at that position at least `minAgeMs` ago (the recognizer flips
 *     between readings for a while: "we'll accept" / "well except"), and
 *   - it is not among the last `holdLastWords` of the interim (the words still being
 *     spoken are often fragments: "bui" → "building", "Town w" → "Town wide").
 * Committed words are appended to the roll-up encoder at once. When the final transcript
 * arrives, it is aligned to the committed words by content (not by position): a committed
 * word that turned out to be the start of a longer word is completed on air (the rest of
 * the word is appended without a space), words the final dropped or changed are skipped,
 * and only the words beyond the aligned point are sent. A committed word can never be
 * taken back, so a reading the final revised stays as spoken on screen (the Dashboard,
 * the audience view and the transcript keep the corrected final).
 */

export function tokenize(text) {
    return String(text || '').trim().split(/\s+/).filter(Boolean);
}

/** Lower-case letters, digits and apostrophes only — punctuation and case changes do not count as revisions. */
export function norm(word) {
    return String(word).toLowerCase().replace(/[^a-z0-9']/g, '');
}

export class LiveFeed {
    constructor({ stable = 4, holdLastWords = 2, minAgeMs = 1200, maxIdleMs = 8000 } = {}) {
        this.stable = Math.max(1, Math.round(stable) || 1);
        this.holdLastWords = Math.max(0, Math.round(holdLastWords) || 0);
        this.minAgeMs = Math.max(0, minAgeMs || 0);
        this.maxIdleMs = maxIdleMs;
        this.stats = { interims: 0, chunks: 0, words: 0, finals: 0, finalTailWords: 0, completed: 0, skipped: 0, mismatches: 0 };
        this._newUtterance();
        this.lastAt = 0;
    }

    _newUtterance() {
        this.history = [];     // the last `stable` interims, as normalized word arrays
        this.committed = [];   // normalized words already sent for this utterance
        this.firstSeen = [];   // per position: {word, at} — when the current word first appeared there
    }

    /** Words committed so far in the current utterance. */
    get committedCount() { return this.committed.length; }

    /**
     * Feed one interim transcript of the current utterance (the recognizer's running
     * text, not cumulative across finals). Returns the words that became stable now,
     * in their original spelling, or an empty array.
     */
    interim(text, now = Date.now()) {
        if (this.lastAt && now - this.lastAt > this.maxIdleMs) this._newUtterance();
        this.lastAt = now;
        const words = tokenize(text);
        const normed = words.map(norm);
        this.stats.interims++;
        for (let i = 0; i < normed.length; i++) {
            if (!this.firstSeen[i] || this.firstSeen[i].word !== normed[i]) this.firstSeen[i] = { word: normed[i], at: now };
        }
        this.firstSeen.length = normed.length;
        this.history.push(normed);
        if (this.history.length > this.stable) this.history.shift();
        if (this.history.length < this.stable) return [];
        // the longest prefix shared by the last `stable` interims
        let n = Math.min(...this.history.map(h => h.length));
        for (let i = 0; i < n; i++) {
            const w = normed[i];
            if (this.history.some(h => h[i] !== w)) { n = i; break; }
        }
        n = Math.min(n, words.length - this.holdLastWords);
        // and nothing younger than minAgeMs at its position
        for (let i = this.committed.length; i < n; i++) {
            if (now - this.firstSeen[i].at < this.minAgeMs) { n = i; break; }
        }
        if (n <= this.committed.length) return [];
        const out = words.slice(this.committed.length, n);
        this.committed.push(...out.map(norm));
        this.stats.chunks++;
        this.stats.words += out.length;
        return out;
    }

    /**
     * Feed the final transcript of the utterance (polished or not). Aligns it to the
     * committed words and returns
     *   { words: [...]            the words not sent yet, in order,
     *     completeLastWord: 'uld' the rest of the last committed word when it was a fragment
     *                             of the final's word at that place ("co" → "could"), else null }
     * and starts the next utterance.
     */
    final(text) {
        const words = tokenize(text);
        const normed = words.map(norm);
        const c = this.committed.length;
        let j = 0, matched = 0, completeLastWord = null;
        for (let i = 0; i < c; i++) {
            const w = this.committed[i];
            let hit = -1;
            for (let k = j; k < Math.min(normed.length, j + 3); k++) {
                if (normed[k] === w) { hit = k; break; }
                // the last committed word may be a fragment of a longer word ("co" of "could")
                if (i === c - 1 && w.length >= 2 && normed[k].length > w.length && normed[k].startsWith(w)) { hit = k; break; }
            }
            if (hit < 0) { this.stats.skipped++; continue; }   // the final dropped or changed this word: it stays on air as it was
            matched++;
            if (i === c - 1 && normed[hit] !== w) {
                const original = words[hit];
                const prefix = original.slice(0, w.length);
                if (norm(prefix) === w) { completeLastWord = original.slice(w.length); this.stats.completed++; }
            }
            j = hit + 1;
        }
        const tail = words.slice(j);
        if (c && matched < c * 0.6) this.stats.mismatches++;
        this.stats.finals++;
        this.stats.finalTailWords += tail.length;
        this._newUtterance();
        this.lastAt = 0;
        return { words: tail, completeLastWord };
    }

    /** Forget the current utterance (e.g. the encoder was cleared or the session ended). */
    reset() { this._newUtterance(); this.lastAt = 0; }
}
