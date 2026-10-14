/**
 * live-feed.js — words that are safe to send to a roll-up caption encoder before the
 * recognizer has finished the sentence.
 *
 * Broadcast captions (CART writers, EEG/Lexi, YouTube's own) stream text as it is
 * recognized, a few words behind the speaker; this app used to encode only final
 * captions, so viewers saw nothing for the length of each sentence and then a block.
 * The relay feeds every interim transcript of the current utterance into a LiveFeed;
 * a word is committed once it has sat at the same position in the last `stable`
 * interims (the recognizer has stopped revising it) and it is not among the last
 * `holdLastWords` of the interim (the word being spoken is often still growing:
 * "Bro" → "Brookline"). Committed words are appended to the roll-up encoder at once.
 * When the final transcript arrives, the words beyond the committed prefix are sent
 * and the utterance is closed; a committed word can never be taken back, so a final
 * that was revised earlier in the sentence stays as it was spoken on screen (the
 * Dashboard, the audience view and the transcript keep the corrected final).
 */

export function tokenize(text) {
    return String(text || '').trim().split(/\s+/).filter(Boolean);
}

/** Lower-case letters, digits and apostrophes only — punctuation and case changes do not count as revisions. */
export function norm(word) {
    return String(word).toLowerCase().replace(/[^a-z0-9']/g, '');
}

export class LiveFeed {
    constructor({ stable = 3, holdLastWords = 1, maxIdleMs = 8000 } = {}) {
        this.stable = Math.max(1, Math.round(stable) || 1);
        this.holdLastWords = Math.max(0, Math.round(holdLastWords) || 0);
        this.maxIdleMs = maxIdleMs;
        this.stats = { interims: 0, chunks: 0, words: 0, finals: 0, finalTailWords: 0, mismatches: 0 };
        this._newUtterance();
        this.lastAt = 0;
    }

    _newUtterance() {
        this.history = [];     // the last `stable` interims, as normalized word arrays
        this.committed = [];   // normalized words already sent for this utterance
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
        this.stats.interims++;
        this.history.push(words.map(norm));
        if (this.history.length > this.stable) this.history.shift();
        if (this.history.length < this.stable) return [];
        // the longest prefix shared by the last `stable` interims
        let n = Math.min(...this.history.map(h => h.length));
        for (let i = 0; i < n; i++) {
            const w = this.history[this.history.length - 1][i];
            if (this.history.some(h => h[i] !== w)) { n = i; break; }
        }
        n = Math.min(n, words.length - this.holdLastWords);
        if (n <= this.committed.length) return [];
        const out = words.slice(this.committed.length, n);
        this.committed.push(...out.map(norm));
        this.stats.chunks++;
        this.stats.words += out.length;
        return out;
    }

    /**
     * Feed the final transcript of the utterance (polished or not). Returns the words
     * that have not been sent yet, in order, and starts the next utterance.
     */
    final(text) {
        const words = tokenize(text);
        const c = this.committed.length;
        if (c) {
            let match = 0;
            for (let i = 0; i < Math.min(c, words.length); i++) if (norm(words[i]) === this.committed[i]) match++;
            if (match < c * 0.6) this.stats.mismatches++;
        }
        const tail = words.slice(c);
        this.stats.finals++;
        this.stats.finalTailWords += tail.length;
        this._newUtterance();
        this.lastAt = 0;
        return tail;
    }

    /** Forget the current utterance (e.g. the encoder was cleared or the session ended). */
    reset() { this._newUtterance(); this.lastAt = 0; }
}
