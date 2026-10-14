/**
 * CEA-608 Encoder (roll-up, pop-on and paint-on)
 *
 * Converts caption text into CEA-608 byte pairs for closed captioning.
 * The encoder is drained once per video frame: `drainPairs()` returns the
 * pairs that go into that frame's CDP — normally ONE pair (the line-21 rate,
 * ~60 chars/sec at 29.97 fps), or several in "one-frame" mode (below).
 *
 * Styles (setStyle):
 *
 *   rollup      (default) every row of a caption goes out as
 *                   RUx RUx [PAC PAC once after start/clear] CR CR <text>
 *               i.e. roll-up command and carriage return precede the text,
 *               so the previous row scrolls up and the newest row lands on
 *               the base row (row 15).
 *   rollup_pac  the same, but the base-row PAC is sent with every row
 *               (RUx CR PAC <text>) — a decoder that lost the first PAC still
 *               positions the text.
 *   popon       the way broadcast encoders and libcaption (OBS) send captions:
 *                   RCL ENM PAC(row) <text> [PAC(row) <text>] EOC
 *               The text is loaded into the non-displayed memory and EOC
 *               flips it on screen in one go; the rows sit on rows 14/15
 *               (13–15 for three rows). A caption longer than the row count
 *               becomes consecutive pop-on captions.
 *   painton     RDC PAC(row) <text> DER … — text appears as it is typed,
 *               every row is rewritten in place and deleted to its end.
 *
 * Control codes are transmitted twice (setControlRepeat(2), the CEA-608
 * error-resilience rule) unless set to 1 (libcaption sends most codes once).
 *
 * One-frame mode (setOneFrame): the whole caption's pairs are packed into as
 * few frames as the CDP allows (19 pairs at 29.97 with the standard 20
 * triplets: field 1, field 2, then the rest as extra field-1 triplets), and
 * the frames are repeated `copies` times `copyGap` frames apart. A lossy
 * encoder then either forwards a caption whole or not at all; the next copy
 * repairs it. With pop-on the EOC is always in the last frame, so a lost
 * frame can only delay a caption, never show a partial one for long.
 *
 * Hold (setHoldFrames): after N frames without a new caption the display is
 * erased with EDM (0 = never, the default; broadcast practice is a few
 * seconds).
 *
 * Pacing (setPacing) for the one-pair-per-frame modes: `paceFrames` spreads
 * the stream out (one pair every N frames); `repeat` emits each pair on N
 * consecutive frames (diagnostic).
 *
 * Control codes per CEA-608 (channel 1, before parity):
 *   RU2 14 25 · RU3 14 26 · RU4 14 27 · CR 14 2D · EDM 14 2C · ENM 14 2E
 *   RCL 14 20 · EOC 14 2F · RDC 14 29 · DER 14 24
 *   PAC row 13 = 13 60, row 14 = 14 40, row 15 = 14 60 (white, no indent);
 *   the roll-up base-row PAC is 14 70 (row 15, indent 0, white).
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
export const CTRL = {
    RU2:  [0x14, 0x25],  // Roll-Up 2 rows
    RU3:  [0x14, 0x26],  // Roll-Up 3 rows
    RU4:  [0x14, 0x27],  // Roll-Up 4 rows
    PAC:  [0x14, 0x70],  // Preamble Address Code — Row 15, white, indent 0 (roll-up base row)
    CR:   [0x14, 0x2D],  // Carriage Return
    EDM:  [0x14, 0x2C],  // Erase Displayed Memory
    ENM:  [0x14, 0x2E],  // Erase Non-displayed Memory
    RCL:  [0x14, 0x20],  // Resume Caption Loading (pop-on)
    EOC:  [0x14, 0x2F],  // End Of Caption (flip memories)
    RDC:  [0x14, 0x29],  // Resume Direct Captioning (paint-on)
    DER:  [0x14, 0x24],  // Delete to End of Row
};

// PAC (white, no indent, no underline) for screen rows 11–15, channel 1
const ROW_PAC = {
    11: [0x10, 0x40],
    12: [0x13, 0x40],
    13: [0x13, 0x60],
    14: [0x14, 0x40],
    15: [0x14, 0x60],
};

const NULL_PAIR = Object.freeze({ cc1: 0x80, cc2: 0x80 });
export const STYLES = ['rollup', 'rollup_pac', 'popon', 'painton'];

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

/** Printable ASCII pairs for a row of text ('?' for anything else; odd length ends with a null byte). */
export function textPairs(text) {
    const chars = [];
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        chars.push(code >= 0x20 && code <= 0x7E ? code : 0x3F);
    }
    const pairs = [];
    for (let i = 0; i < chars.length; i += 2) {
        const cc1 = addParity(chars[i]);
        const cc2 = (i + 1 < chars.length) ? addParity(chars[i + 1]) : 0x80;
        pairs.push({ cc1, cc2 });
    }
    return pairs;
}

export class Cea608Encoder {
    constructor(options = {}) {
        /** @type {Array<Array<{cc1:number,cc2:number}>|null>} queue of frames: the pairs of one frame, null = idle frame */
        this.frames = [];
        this.initialized = false;
        this.rollupRows = 2;
        this.style = 'rollup';
        this.controlRepeat = 2;
        this.paceFrames = 1;     // emit one pair every N frames
        this.repeat = 1;         // emit each pair on N consecutive frames (diagnostic)
        this.oneFrame = false;   // pack whole captions into frames (see class comment)
        this.maxPairsPerFrame = 19;
        this.copies = 1;         // one-frame mode: copies of every caption
        this.copyGap = 3;        // idle frames between copies
        this.holdFrames = 0;     // erase the display after N idle frames (0 = never)
        this._frameCounter = 0;
        this._repeatLeft = 0;
        this._lastFrame = [NULL_PAIR];
        this._displayed = false; // something is on screen (for the hold/EDM logic)
        this._idleFrames = 0;    // frames drained with nothing to send since the last caption data
        this._liveCol = 0;       // live feed (appendText): column after the last character on the bottom row, 0 = next word starts a row
        this.setRollupRows(options.rollupRows ?? 2);
        this.setPacing(options.paceFrames ?? 1, options.repeat ?? 1);
        if (options.style) this.setStyle(options.style);
        if (options.controlRepeat) this.setControlRepeat(options.controlRepeat);
        if (options.oneFrame !== undefined) this.setOneFrame(options);
        if (options.holdFrames !== undefined) this.setHoldFrames(options.holdFrames);
    }

    /** 2, 3 or 4 displayed rows. Takes effect from the next caption. */
    setRollupRows(rows) {
        const n = rows === 3 ? 3 : rows === 4 ? 4 : 2;
        if (n !== this.rollupRows) {
            this.rollupRows = n;
            this.initialized = false;  // re-send PAC with the new mode
        }
    }

    /** 'rollup' | 'rollup_pac' | 'popon' | 'painton' */
    setStyle(style) {
        const s = STYLES.includes(style) ? style : 'rollup';
        if (s !== this.style) { this.style = s; this.initialized = false; }
    }

    /** Transmit every control code once (1) or twice (2, the CEA-608 rule). */
    setControlRepeat(n) {
        this.controlRepeat = n === 1 ? 1 : 2;
    }

    /** One pair every `paceFrames` frames, each pair on `repeat` consecutive frames. */
    setPacing(paceFrames = 1, repeat = 1) {
        this.paceFrames = Math.max(1, Math.min(8, Math.round(paceFrames) || 1));
        this.repeat = Math.max(1, Math.min(4, Math.round(repeat) || 1));
    }

    /**
     * One-frame mode: {enabled, maxPairs (pairs per frame the CDP can carry,
     * Cea708CdpBuilder.cea608Capacity), copies (1–8), copyGap (0–60 frames)}.
     */
    setOneFrame(opts = {}) {
        if (opts.enabled !== undefined) this.oneFrame = !!opts.enabled;
        else if (opts.oneFrame !== undefined) this.oneFrame = !!opts.oneFrame;
        if (opts.maxPairs !== undefined) this.maxPairsPerFrame = Math.max(1, Math.min(31, Math.round(opts.maxPairs) || 19));
        if (opts.copies !== undefined) this.copies = Math.max(1, Math.min(8, Math.round(opts.copies) || 1));
        if (opts.copyGap !== undefined) this.copyGap = Math.max(0, Math.min(60, Math.round(opts.copyGap) || 0));
    }

    /** Erase the display (EDM) after `frames` frames without a new caption; 0 = never. */
    setHoldFrames(frames) {
        this.holdFrames = Math.max(0, Math.min(3000, Math.round(frames) || 0));
    }

    get transport() {
        return { style: this.style, controlRepeat: this.controlRepeat, oneFrame: this.oneFrame, maxPairsPerFrame: this.maxPairsPerFrame,
                 copies: this.copies, copyGap: this.copyGap, holdFrames: this.holdFrames, paceFrames: this.paceFrames, repeat: this.repeat, rows: this.rollupRows };
    }

    _rollupCode() {
        return this.rollupRows === 4 ? CTRL.RU4 : this.rollupRows === 3 ? CTRL.RU3 : CTRL.RU2;
    }

    /** A control code with parity, repeated per setControlRepeat. */
    _control(ctrl) {
        const pair = { cc1: addParity(ctrl[0]), cc2: addParity(ctrl[1]) };
        const out = [pair];
        if (this.controlRepeat === 2) out.push({ ...pair });
        return out;
    }

    /** The pairs of one caption (rows already wrapped), by style. */
    _captionPairs(rows) {
        const out = [];
        if (this.style === 'popon') {
            out.push(...this._control(CTRL.RCL), ...this._control(CTRL.ENM));
            const base = 15 - (rows.length - 1);
            rows.forEach((row, i) => { out.push(...this._control(ROW_PAC[base + i] || ROW_PAC[15]), ...textPairs(row)); });
            out.push(...this._control(CTRL.EOC));
        } else if (this.style === 'painton') {
            out.push(...this._control(CTRL.RDC));
            // every displayed row is rewritten: PAC, text, delete to end of row (blank rows just PAC + DER)
            const n = this.rollupRows;
            const base = 15 - (n - 1);
            for (let i = 0; i < n; i++) {
                const row = rows[i - (n - rows.length)] || '';    // bottom-aligned
                out.push(...this._control(ROW_PAC[base + i] || ROW_PAC[15]));
                if (row) out.push(...textPairs(row));
                if (row.length < CEA608_COLUMNS) out.push(...this._control(CTRL.DER));
            }
        } else {
            for (const row of rows) {
                out.push(...this._control(this._rollupCode()));
                if (this.style === 'rollup_pac') {
                    out.push(...this._control(CTRL.CR), ...this._control(CTRL.PAC));
                } else {
                    if (!this.initialized) { this.initialized = true; out.push(...this._control(CTRL.PAC)); }
                    out.push(...this._control(CTRL.CR));
                }
                out.push(...textPairs(row));
            }
        }
        return out;
    }

    /** The control codes that start a roll-up row: RUx, then PAC once (rollup) or CR + PAC (rollup_pac), as _captionPairs sends them. */
    _rowPrefix() {
        const out = [...this._control(this._rollupCode())];
        if (this.style === 'rollup_pac') {
            out.push(...this._control(CTRL.CR), ...this._control(CTRL.PAC));
        } else {
            if (!this.initialized) { this.initialized = true; out.push(...this._control(CTRL.PAC)); }
            out.push(...this._control(CTRL.CR));
        }
        return out;
    }

    /**
     * Live feed: append words to the bottom row right away, without waiting for the
     * rest of the caption (server/live-feed.js decides which words are safe to send).
     * Roll-up styles only — pop-on and paint-on show whole captions, so there the words
     * go out as a caption of their own. The first word of a row is preceded by the
     * usual RUx [CR] [PAC] prefix, later words continue on the same row after a space,
     * and a word that would run past column 32 starts a new row (words longer than a
     * row are split). endLine() makes the next word start a new row.
     */
    appendText(text) {
        const words = String(text || '').trim().split(/\s+/).filter(Boolean);
        if (!words.length) return;
        if (this.style === 'popon' || this.style === 'painton') { this.enqueueText(words.join(' ')); return; }
        const out = [];
        for (const word of words) {
            const pieces = [];
            let rest = word;
            while (rest.length > CEA608_COLUMNS) { pieces.push(rest.slice(0, CEA608_COLUMNS)); rest = rest.slice(CEA608_COLUMNS); }
            pieces.push(rest);
            for (const piece of pieces) {
                const need = (this._liveCol > 0 ? 1 : 0) + piece.length;
                if (this._liveCol > 0 && this._liveCol + need > CEA608_COLUMNS) this._liveCol = 0;   // wrap to a new row
                if (this._liveCol === 0) {
                    out.push(...this._rowPrefix(), ...textPairs(piece));
                    this._liveCol = piece.length;
                } else {
                    out.push(...textPairs(' ' + piece));
                    this._liveCol += need;
                }
            }
        }
        this._queue(out);
        this._displayed = true;
        this._idleFrames = 0;
    }

    /** Live feed: the next appended word starts a new row. */
    endLine() { this._liveCol = 0; }

    /** Live feed: column of the next character on the bottom row (0 = a new row starts next). */
    get liveColumn() { return this._liveCol; }

    /** Queue the pairs of one caption as frames (one pair per frame, or packed with copies in one-frame mode). */
    _queue(pairs) {
        if (!pairs.length) return;
        if (!this.oneFrame) {
            for (const p of pairs) this.frames.push([p]);
            return;
        }
        const chunks = [];
        for (let i = 0; i < pairs.length; i += this.maxPairsPerFrame) chunks.push(pairs.slice(i, i + this.maxPairsPerFrame));
        for (let c = 0; c < this.copies; c++) {
            if (c > 0) for (let g = 0; g < this.copyGap; g++) this.frames.push(null);
            for (const chunk of chunks) this.frames.push(chunk.map(p => ({ ...p })));
        }
    }

    /**
     * Enqueue one caption. The text is wrapped into 32-column rows and sent in
     * the current style. The second argument is accepted for compatibility;
     * interim (non-final) text is encoded the same way, so callers should
     * only pass final captions.
     *
     * @param {string} text - The caption text
     * @param {boolean} [isFinal=true]
     */
    enqueueText(text, isFinal = true) { // eslint-disable-line no-unused-vars
        const rows = wrapRows(text);
        if (!rows.length) return;
        if (this.style === 'popon' || this.style === 'painton') {
            // a caption longer than the display becomes consecutive captions
            const n = this.rollupRows;
            for (let i = 0; i < rows.length; i += n) this._queue(this._captionPairs(rows.slice(i, i + n)));
        } else {
            this._queue(this._captionPairs(rows));
        }
        this._liveCol = 0;
        this._displayed = true;
        this._idleFrames = 0;
    }

    /**
     * Enqueue an Erase Displayed Memory command to clear the screen.
     * The next roll-up caption re-sends the base-row PAC.
     */
    enqueueClear() {
        this._queue(this._control(CTRL.EDM));
        this.initialized = false;
        this._displayed = false;
        this._liveCol = 0;
    }

    /**
     * Drain the pairs for one video frame, honouring pacing. Returns an array
     * with one null pair {0x80, 0x80} when nothing is due this frame.
     * Call once per video frame (e.g., 29.97 times/sec).
     *
     * @returns {Array<{cc1: number, cc2: number}>}
     */
    drainPairs() {
        if (this._repeatLeft > 0) {
            this._repeatLeft--;
            return this._lastFrame;
        }
        this._frameCounter++;
        if (!this.oneFrame && this._frameCounter % this.paceFrames !== 0) return [NULL_PAIR];
        if (this.frames.length === 0 && this.holdFrames > 0 && this._displayed) {
            // nothing queued: erase the display once the hold time has passed
            if (++this._idleFrames >= this.holdFrames) this.enqueueClear();
        }
        if (this.frames.length > 0) {
            const frame = this.frames.shift();
            if (!frame) return [NULL_PAIR];           // deliberate idle frame between copies
            this._lastFrame = frame;
            this._repeatLeft = this.oneFrame ? 0 : this.repeat - 1;
            this._idleFrames = 0;
            return frame;
        }
        // Null padding — no caption data this frame
        return [NULL_PAIR];
    }

    /**
     * Drain the next CC byte pair for one video frame (one-pair-per-frame modes).
     * @returns {{cc1: number, cc2: number}}
     */
    drainPair() {
        return this.drainPairs()[0];
    }

    /**
     * Number of pairs currently queued.
     * @returns {number}
     */
    get queueLength() {
        let n = 0;
        for (const f of this.frames) if (f) n += f.length;
        return n;
    }

    /** Frames currently queued (pairs and idle gaps). */
    get queuedFrames() { return this.frames.length; }

    /**
     * Reset encoder state (style, pacing and transport settings are kept).
     */
    reset() {
        this.frames = [];
        this.initialized = false;
        this._frameCounter = 0;
        this._repeatLeft = 0;
        this._lastFrame = [NULL_PAIR];
        this._displayed = false;
        this._idleFrames = 0;
        this._liveCol = 0;
    }
}
