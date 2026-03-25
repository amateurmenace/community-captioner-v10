/**
 * CEA-608 Roll-Up 2 Encoder
 *
 * Converts text strings into CEA-608 byte pairs for closed captioning.
 * Outputs one {cc1, cc2} pair per video frame. Characters are queued
 * and drained at frame rate (~60 chars/sec at 29.97fps).
 *
 * Control codes per CEA-608 spec:
 *   RU2  (0x14, 0x25) — Roll-Up 2 rows mode
 *   PAC  (0x14, 0x70) — Position cursor at row 15 (bottom)
 *   CR   (0x14, 0x2D) — Carriage Return (rolls text up)
 *   EDM  (0x14, 0x2C) — Erase Displayed Memory
 *
 * All control codes are transmitted twice for error resilience.
 */

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
    PAC:  [0x14, 0x70],  // Preamble Address Code — Row 15, white
    CR:   [0x14, 0x2D],  // Carriage Return
    EDM:  [0x14, 0x2C],  // Erase Displayed Memory
};

export class Cea608Encoder {
    constructor() {
        /** @type {Array<{cc1: number, cc2: number}>} */
        this.pairQueue = [];
        this.initialized = false;
        this.lastInterimText = '';
    }

    /**
     * Enqueue initialization sequence (RU2 + PAC).
     * Sent twice each per CEA-608 error resilience spec.
     */
    _enqueueInit() {
        if (this.initialized) return;
        this.initialized = true;
        // RU2 — sent twice
        this._enqueueControl(CTRL.RU2);
        this._enqueueControl(CTRL.RU2);
        // PAC Row 15 — sent twice
        this._enqueueControl(CTRL.PAC);
        this._enqueueControl(CTRL.PAC);
    }

    /**
     * Enqueue a control code pair with parity bits applied.
     */
    _enqueueControl(ctrl) {
        this.pairQueue.push({
            cc1: addParity(ctrl[0]),
            cc2: addParity(ctrl[1])
        });
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
     * Enqueue caption text. Uses delta encoding — only new characters
     * since the last interim are queued (Option A from the integration spec).
     *
     * @param {string} text - The caption text
     * @param {boolean} isFinal - If true, appends a Carriage Return
     */
    enqueueText(text, isFinal = false) {
        this._enqueueInit();

        // Delta computation: only send new characters since last interim
        let newText;
        if (this.lastInterimText && text.startsWith(this.lastInterimText)) {
            newText = text.slice(this.lastInterimText.length);
        } else {
            newText = text;
        }

        if (newText.length > 0) {
            this._enqueueChars(newText);
        }

        if (isFinal) {
            // CR — sent twice for error resilience
            this._enqueueControl(CTRL.CR);
            this._enqueueControl(CTRL.CR);
            this.lastInterimText = '';
        } else {
            this.lastInterimText = text;
        }
    }

    /**
     * Enqueue an Erase Displayed Memory command to clear the screen.
     */
    enqueueClear() {
        this._enqueueInit();
        // EDM — sent twice
        this._enqueueControl(CTRL.EDM);
        this._enqueueControl(CTRL.EDM);
        this.lastInterimText = '';
    }

    /**
     * Drain the next CC byte pair for one video frame.
     * Returns null padding {0x80, 0x80} if the queue is empty.
     *
     * Call this once per video frame (e.g., 29.97 times/sec).
     *
     * @returns {{cc1: number, cc2: number}}
     */
    drainPair() {
        if (this.pairQueue.length > 0) {
            return this.pairQueue.shift();
        }
        // Null padding — no caption data this frame
        return { cc1: 0x80, cc2: 0x80 };
    }

    /**
     * Number of pairs currently queued.
     * @returns {number}
     */
    get queueLength() {
        return this.pairQueue.length;
    }

    /**
     * Reset encoder state.
     */
    reset() {
        this.pairQueue = [];
        this.initialized = false;
        this.lastInterimText = '';
    }
}
