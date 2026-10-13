// cea608-model.mjs — a small CEA-608 (CC1) decoder model.
//
// Used to score what a decoder would DISPLAY from a stream of field-1 pairs: the app's own
// encoder output (clean streams, simulations) or the pairs found in a Web Presenter / OBS /
// YouTube capture (sei-cc.mjs → f1all). It implements the memory and cursor semantics that
// matter for roll-up, pop-on and paint-on captions: RCL, ENM, EOC, EDM, RUx, CR, RDC, DER, BS,
// PAC (row + indent), tab offsets, mid-row codes (one space), special/extended characters
// ('?'), and the rule that a control code repeated immediately is ignored once.
// Channel 2 (CC2) codes and XDS are ignored.

const ROW_BY_CODE = {      // first byte → { second byte & 0x60 → row }
    0x11: { 0x40: 1, 0x60: 2 },  0x12: { 0x40: 3, 0x60: 4 },  0x15: { 0x40: 5, 0x60: 6 },
    0x16: { 0x40: 7, 0x60: 8 },  0x17: { 0x40: 9, 0x60: 10 }, 0x10: { 0x40: 11 },
    0x13: { 0x40: 12, 0x60: 13 }, 0x14: { 0x40: 14, 0x60: 15 },
};
const ROWS = 15, COLS = 32;
const blank = () => Array.from({ length: ROWS }, () => ' '.repeat(COLS));

export class Cea608Decoder {
    constructor() {
        this.disp = blank();      // displayed memory
        this.nondisp = blank();   // non-displayed memory (pop-on)
        this.mode = 'rollup';     // 'rollup' | 'popon' | 'painton'
        this.rollupRows = 2;
        this.baseRow = 15;
        this.row = 15;
        this.col = 0;
        this.lastCtrl = null;
        this.frame = -1;
        this.events = [];         // {frame, kind, detail}
        this.pairCount = 0;
        this.ctrlCount = 0;
    }

    /** Feed the field-1 pairs of one frame ([[cc1, cc2], …] or null for an idle frame). */
    feedFrame(pairs) {
        this.frame++;
        for (const p of pairs || []) this.feedPair(p[0], p[1]);
    }

    feedPair(c1, c2) {
        const a = c1 & 0x7F, b = c2 & 0x7F;
        if (a === 0 && b === 0) return;                 // null pair (padding)
        this.pairCount++;
        if (a >= 0x10 && a <= 0x1F) {
            const key = (a << 8) | b;
            if (this.lastCtrl === key) { this.lastCtrl = null; return; }   // doubled control code: second copy ignored
            this.lastCtrl = key;
            this.ctrlCount++;
            this._control(a, b);
            return;
        }
        this.lastCtrl = null;
        if (a >= 0x20) this._char(String.fromCharCode(a));
        if (b >= 0x20) this._char(String.fromCharCode(b));
    }

    _target() { return this.mode === 'popon' ? this.nondisp : this.disp; }

    _event(kind, detail) { this.events.push({ frame: this.frame, kind, detail }); }

    _char(ch) {
        const mem = this._target();
        if (this.row < 1 || this.row > ROWS || this.col >= COLS) return;
        const r = mem[this.row - 1];
        mem[this.row - 1] = r.slice(0, this.col) + ch + r.slice(this.col + 1);
        this.col = Math.min(this.col + 1, COLS);
    }

    _control(a, b) {
        if (a === 0x14 && b >= 0x20 && b <= 0x2F) {            // misc control, channel 1
            switch (b) {
                case 0x20: this.mode = 'popon'; this._event('rcl'); break;                           // RCL
                case 0x21: if (this.col > 0) { this.col--; this._char(' '); this.col--; } break;   // BS
                case 0x24: { const mem = this._target(); const r = mem[this.row - 1]; mem[this.row - 1] = r.slice(0, this.col) + ' '.repeat(COLS - this.col); break; } // DER
                case 0x25: case 0x26: case 0x27: {                                                  // RU2/3/4
                    const n = b - 0x23;
                    if (this.mode !== 'rollup') { this.disp = blank(); this.nondisp = blank(); }
                    this.mode = 'rollup'; this.rollupRows = n; this.row = this.baseRow; this.col = 0;
                    this._event('rollup', n); break;
                }
                case 0x29: this.mode = 'painton'; this._event('rdc'); break;                         // RDC
                case 0x2C: this.disp = blank(); this._event('edm'); break;                           // EDM
                case 0x2D: if (this.mode === 'rollup') { this._cr(); } this._event('cr'); break;     // CR
                case 0x2E: this.nondisp = blank(); this._event('enm'); break;                        // ENM
                case 0x2F: {                                                                         // EOC
                    const t = this.disp; this.disp = this.nondisp; this.nondisp = t;
                    this.mode = 'popon'; this._event('eoc', this.shown()); break;
                }
                default: break;                                                                      // AOF/AON/FON/TR/RTD
            }
            return;
        }
        if (a >= 0x10 && a <= 0x17 && b >= 0x40) {              // PAC
            const row = (ROW_BY_CODE[a] || {})[b & 0x60];
            if (!row) return;
            const indent = (b & 0x10) ? ((b & 0x0E) >> 1) * 4 : 0;
            if (this.mode === 'rollup') {
                if (row !== this.baseRow) this._moveBase(row);
                this.row = this.baseRow;
            } else {
                this.row = row;
            }
            this.col = indent;
            this._event('pac', { row, indent });
            return;
        }
        if (a === 0x11 && b >= 0x20 && b <= 0x2F) { this._char(' '); return; }                      // mid-row code = one space
        if (a === 0x11 && b >= 0x30 && b <= 0x3F) { this._char('?'); return; }                      // special character
        if ((a === 0x12 || a === 0x13) && b >= 0x20 && b <= 0x3F) { if (this.col > 0) this.col--; this._char('?'); return; } // extended char
        if (a === 0x17 && b >= 0x21 && b <= 0x23) { this.col = Math.min(COLS, this.col + b - 0x20); return; }  // tab offset
    }

    _cr() {
        const top = this.baseRow - this.rollupRows + 1;
        for (let r = top; r < this.baseRow; r++) this.disp[r - 1] = this.disp[r];
        this.disp[this.baseRow - 1] = ' '.repeat(COLS);
        this.row = this.baseRow; this.col = 0;
    }

    _moveBase(row) {
        // the displayed roll-up rows move with the base row
        const top = this.baseRow - this.rollupRows + 1;
        const rows = [];
        for (let r = top; r <= this.baseRow; r++) { rows.push(this.disp[r - 1] || ' '.repeat(COLS)); if (r >= 1) this.disp[r - 1] = ' '.repeat(COLS); }
        this.baseRow = row;
        const newTop = row - this.rollupRows + 1;
        rows.forEach((text, i) => { const r = newTop + i; if (r >= 1 && r <= ROWS) this.disp[r - 1] = text; });
    }

    /** Displayed rows, trailing spaces trimmed, as 15 strings (row 1 first). */
    display() { return this.disp.map(r => r.replace(/\s+$/, '')); }

    /** The non-empty displayed rows joined with newlines (what a viewer reads). */
    shown() { return this.display().filter(Boolean).join('\n'); }
}

/** The field-1 pairs of a CDP (from the app's Cea708CdpBuilder) as [[cc1, cc2], …], nulls dropped. */
export function pairsFromCdp(cdp) {
    if (!cdp || cdp[7] !== 0x72) return [];
    const count = cdp[8] & 0x1F;
    const out = [];
    for (let k = 0; k < count; k++) {
        const o = 9 + k * 3;
        const h = cdp[o];
        if (!(h & 0x04) || (h & 0x03) !== 0) continue;
        const a = cdp[o + 1], b = cdp[o + 2];
        if ((a & 0x7F) === 0 && (b & 0x7F) === 0) continue;
        out.push([a, b]);
    }
    return out;
}
