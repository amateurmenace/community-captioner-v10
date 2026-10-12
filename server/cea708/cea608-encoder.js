/**
 * CEA-608 Roll-Up Encoder
 *
 * Converts caption text into CEA-608 byte pairs for closed captioning.
 * Outputs one {cc1, cc2} pair per video frame. Characters are queued
 * and drained at frame rate (~60 chars/sec at 29.97fps, 1 pair per frame).
 *
 * Each caption is wrapped into rows of at most 32 columns (the CEA-608 row
 * width — anything longer piles up in column 32 on real decoders) and every
 * row is sent as
 *
 *   RUx RUx  CR CR  <text pairs>
 *
 * i.e. the roll-up command and a carriage return precede the text, so the
 * previous row scrolls up and the newest row is always on the base row.
 * The first row after (re)start also carries the PAC that sets the base
 * row (row 15). Control codes are transmitted twice, as CEA-608 requires.
 *
 * Control codes per CEA-608 spec:
 *   RU2  (0x14, 0x25) — Roll-Up 2 rows     RU3 (0x14, 0x26) — 3 rows
 *   PAC  (0x14, 0x70) — Position cursor at row 15 (bottom)
 *   CR   (0x14, 0x2D) — Carriage Return (rolls text up)
 *   EDM  (0x14, 0x2C) — Erase Displayed Memory
 *
 * Pacing: some downstream encoders cannot keep up with a pair on every frame
 * (the Blackmagic Web Presenter 4K keeps only a fraction of them). `paceFrames`
 * spreads the stream out — one pair every N frames with null pairs in
 * between. `repeat` emits each pair on N consecutive frames (diagnostic:
 * a decoder that does not de-duplicate prints every character twice).
 */

export const CEA608_COLUMNS = 32;

// CEA-608 odd parity lookup: bit 7 is set so total 1-bits in the byte is odd
function addParity(byte) {
    let val = byte & 0x7F;
    let ones = 0;
    let tmp = val;
    while (tmp) {
        ones += tmp & 1;
        tmp >>= 1;
    }
    // If count of 1-bits is even, set parity bit (bit 7) to make it odd
    return (ones % 2 === 0) ? (val | 0x80) : val;
}

// Control code constants (before parity)
const CTRL = {
    RU2:  [0x14, 0x25],  // Roll-Up 2 rows
    RU3:  [0x14, 0x26],  // Roll-Up 3 rows
    RU4:  [0x14, 0x27],  // Roll-Up 4 rows
    PAC:  [0x14, 0x70],  // Preamble Address Code — Row 15, white, indent 0
    CR:   [0x14, 0x2D],  // Carriage Return
    EDM:  [0x14, 0x2C],  // Erase Displayed Memory
};

const NULL_PAIR = Object.freeze({ cc1: 0x80, cc2: 0x80 });

/**
 * Wrap text into rows of at most `columns` characters, breaking at spaces
 * where possible (a single word longer than a row is split hard).
 */
export function wrapRows(text, columns = CEA608_COLUMNS) {
    const rows = [];
    for (const paragraph of String(text).split(/\r?\n/)) {
        let row = '';
        for (const word of paragraph.split(/\s+/).filter(Boolean)) {
            let w = word;
            while (w.length > columns) {
                if (row) { rows.push(row); row = ''; }
                rows.push(w.slice(0, columns));
                w = w.slice(columns);
            }
            if (!row) row = w;
            else if (row.length + 1 + w.length <= columns) row += ' ' + w;
            else { rows.push(row); row = w; }
        }
        if (row) rows.push(row);
    }
    return rows;
}

export class Cea608Encoder {
    constructor(options = {}) {
        /** @type {Array<{cc1: number, cc2: number}>} */
        this.pairQueue = [];
        this.initialized = false;
        this.rollupRows = 2;
        this.paceFrames = 1;     // emit one pair every N frames
        this.repeat = 1;         // emit each pair on N consecutive frames (diagnostic)
        this._frameCounter = 0;
        this._repeatLeft = 0;
        this._lastPair = NULL_PAIR;
        this.setRollupRows(options.rollupRows ?? 2);
        this.setPacing(options.paceFrames ?? 1, options.repeat ?? 1);
    }

    /** 2, 3 or 4 displayed rows. Takes effect from the next caption. */
    setRollupRows(rows) {
        const n = rows === 3 ? 3 : rows === 4 ? 4 : 2;
        if (n !== this.rollupRows) {
            this.rollupRows = n;
            this.initialized = false;  // re-send PAC with the new mode
        }
    }

    /** One pair every `paceFrames` frames, each pair on `repeat` consecutive frames. */
    setPacing(paceFrames = 1, repeat = 1) {
        this.paceFrames = Math.max(1, Math.min(8, Math.round(paceFrames) || 1));
        this.repeat = Math.max(1, Math.min(4, Math.round(repeat) || 1));
    }

    _rollupCode() {
        return this.rollupRows === 4 ? CTRL.RU4 : this.rollupRows === 3 ? CTRL.RU3 : CTRL.RU2;
    }

    /**
     * Enqueue a control code pair with parity bits applied (twice, per the
     * CEA-608 error-resilience rule).
     */
    _enqueueControl(ctrl) {
        const pair = { cc1: addParity(ctrl[0]), cc2: addParity(ctrl[1]) };
        this.pairQueue.push(pair, { ...pair });
    }

    /**
     * Start of a row: roll-up mode (+ base-row PAC once after start/clear),
     * then a carriage return so the previous row scrolls up.
     */
    _enqueueRowStart() {
        this._enqueueControl(this._rollupCode());
        if (!this.initialized) {
            this.initialized = true;
            this._enqueueControl(CTRL.PAC);
        }
        this._enqueueControl(CTRL.CR);
    }

    /**
     * Enqueue printable ASCII text as character pairs.
     * Characters are paired two at a time. Odd-length text gets
     * the last char paired with a null (0x80).
     */
    _enqueueChars(text) {
        // Filter to printable ASCII only (0x20-0x7E)
        const chars = [];
        for (let i = 0; i < text.length; i++) {
            const code = text.charCodeAt(i);
            if (code >= 0x20 && code <= 0x7E) {
                chars.push(code);
            } else {
                chars.push(0x3F); // '?' for non-ASCII
            }
        }

        // Pair characters two at a time
        for (let i = 0; i < chars.length; i += 2) {
            const cc1 = addParity(chars[i]);
            const cc2 = (i + 1 < chars.length) ? addParity(chars[i + 1]) : 0x80;
            this.pairQueue.push({ cc1, cc2 });
        }
    }

    /**
     * Enqueue one caption. The text is wrapped into 32-column rows and each
     * row goes out as RUx RUx CR CR <text>. The second argument is accepted
     * for compatibility; interim (non-final) text is encoded the same way,
     * so callers should only pass final captions.
     *
     * @param {string} text - The caption text
     * @param {boolean} [isFinal=true]
     */
    enqueueText(text, isFinal = true) { // eslint-disable-line no-unused-vars
        for (const row of wrapRows(text)) {
            this._enqueueRowStart();
            this._enqueueChars(row);
        }
    }

    /**
     * Enqueue an Erase Displayed Memory command to clear the screen.
     * The next caption re-sends the base-row PAC.
     */
    enqueueClear() {
        this._enqueueControl(CTRL.EDM);
        this.initialized = false;
    }

    /**
     * Drain the next CC byte pair for one video frame, honouring pacing.
     * Returns null padding {0x80, 0x80} when nothing is due this frame.
     *
     * Call this once per video frame (e.g., 29.97 times/sec).
     *
     * @returns {{cc1: number, cc2: number}}
     */
    drainPair() {
        if (this._repeatLeft > 0) {
            this._repeatLeft--;
            return this._lastPair;
        }
        this._frameCounter++;
        if (this._frameCounter % this.paceFrames !== 0) return NULL_PAIR;
        if (this.pairQueue.length > 0) {
            const pair = this.pairQueue.shift();
            this._lastPair = pair;
            this._repeatLeft = this.repeat - 1;
            return pair;
        }
        // Null padding — no caption data this frame
        return NULL_PAIR;
    }

    /**
     * Number of pairs currently queued.
     * @returns {number}
     */
    get queueLength() {
        return this.pairQueue.length;
    }

    /**
     * Reset encoder state (pacing settings are kept).
     */
    reset() {
        this.pairQueue = [];
        this.initialized = false;
        this._frameCounter = 0;
        this._repeatLeft = 0;
        this._lastPair = NULL_PAIR;
    }
}
