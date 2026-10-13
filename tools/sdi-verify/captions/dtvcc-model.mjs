// dtvcc-model.mjs — a small CEA-708 (DTVCC) service-1 decoder model.
//
// Used to score what a decoder would DISPLAY from a stream of per-frame DTVCC packets:
// the app's own encoder output (simulations) or the packets found in a Web Presenter /
// YouTube capture (sei-cc.mjs → dtvcc column). It implements the window/pen semantics
// that matter for roll-up and redraw captions: DefineWindow, SetCurrentWindow, ClearWindows,
// DeleteWindows, Display/Hide/ToggleWindows, SetPenLocation, CR, HCR, FF, BS, ETX and G0/G1
// text. Pen attributes, colours and window attributes are parsed and ignored.
//
// Options:
//   clearOnRedefine  (default true) — treat DefineWindow of an existing window as a clear.
//                    Per CEA-708 a redefinition keeps the text; YouTube's converter clears.

const C0_LEN = { 0x10: 2, 0x11: 2, 0x12: 2, 0x13: 2, 0x14: 2, 0x15: 2, 0x16: 2, 0x17: 2, 0x18: 3, 0x19: 3, 0x1A: 3, 0x1B: 3, 0x1C: 3, 0x1D: 3, 0x1E: 3, 0x1F: 3 };
const C1_LEN = { 0x88: 2, 0x89: 2, 0x8A: 2, 0x8B: 2, 0x8C: 2, 0x8D: 2, 0x8E: 1, 0x8F: 1, 0x90: 3, 0x91: 4, 0x92: 3, 0x97: 5 };

export class DtvccWindow {
    constructor(id) { this.id = id; this.defined = false; this.visible = false; this.rowCount = 0; this.colCount = 0; this.anchor = {}; this.grid = []; this.penRow = 0; this.penCol = 0; this.defineCount = 0; }
    clear() { this.grid = Array.from({ length: this.rowCount }, () => ' '.repeat(this.colCount)); this.penRow = 0; this.penCol = 0; }
    rows() { return this.grid.map(r => r.replace(/\s+$/, '')); }
}

export class DtvccDecoder {
    constructor(opts = {}) {
        this.clearOnRedefine = opts.clearOnRedefine !== false;
        this.windows = Array.from({ length: 8 }, (_, i) => new DtvccWindow(i));
        this.current = 0;
        this.etxCount = 0;
        this.packetCount = 0;
        this.badPackets = 0;
        this.events = [];      // {frame, kind, detail}
        this.frame = -1;
        this._pending = [];     // service-1 bytes not yet consumed (a command split across packets)
    }

    /** Feed the DTVCC packet bytes of one frame (header byte first), or null/empty for an idle frame. */
    feedFrame(bytes) {
        this.frame++;
        if (!bytes || bytes.length === 0) return;
        this.packetCount++;
        const b = Array.from(bytes);
        const sizeCode = b[0] & 0x3F;
        const packetSize = sizeCode === 0 ? 128 : sizeCode * 2;
        // the SEI/CDP carries whole cc_data words, so the packet may be followed by padding; use the declared size
        let p = 1;
        const end = Math.min(b.length, packetSize);
        while (p < end) {
            const hdr = b[p++];
            if (hdr === 0) break;                       // null service block (padding)
            let svc = hdr >> 5;
            const size = hdr & 0x1F;
            if (svc === 7) { svc = b[p++] & 0x3F; }     // extended header
            const data = b.slice(p, p + size);
            p += size;
            if (data.length < size) this.badPackets++;
            if (svc === 1) this._service1(data);
        }
    }

    _service1(data) {
        const d = this._pending.concat(data);
        this._pending = [];
        let i = 0;
        while (i < d.length) {
            const c = d[i];
            if (c < 0x20) {
                if (c === 0x03) { this.etxCount++; this._event('etx'); i++; continue; }
                if (c === 0x08) { const w = this._cw(); if (w) { if (w.penCol > 0) w.penCol--; this._put(w, ' ', false); } i++; continue; }
                if (c === 0x0C) { const w = this._cw(); if (w) { w.clear(); this._event('ff'); } i++; continue; }
                if (c === 0x0D) { this._cr(); i++; continue; }
                if (c === 0x0E) { const w = this._cw(); if (w) { w.grid[w.penRow] = ' '.repeat(w.colCount); w.penCol = 0; this._event('hcr'); } i++; continue; }
                const len = C0_LEN[c] || 1;
                if (i + len > d.length) { this._pending = d.slice(i); return; }
                i += len; continue;
            }
            if (c <= 0x7F) { const w = this._cw(); if (w) this._put(w, c === 0x7F ? '♪' : String.fromCharCode(c)); i++; continue; }
            if (c >= 0x80 && c <= 0x87) { this.current = c & 7; i++; continue; }
            if (c >= 0x98 && c <= 0x9F) {
                if (i + 7 > d.length) { this._pending = d.slice(i); return; }
                this._defineWindow(c & 7, d.slice(i + 1, i + 7)); i += 7; continue;
            }
            if (c >= 0x88 && c <= 0x8C) {
                if (i + 2 > d.length) { this._pending = d.slice(i); return; }
                const mask = d[i + 1];
                for (let w = 0; w < 8; w++) {
                    if (!(mask & (1 << w))) continue;
                    const win = this.windows[w];
                    if (c === 0x88) { if (win.defined) { win.clear(); this._event('clw', w); } }
                    else if (c === 0x89) { win.visible = win.defined; }
                    else if (c === 0x8A) { win.visible = false; }
                    else if (c === 0x8B) { if (win.defined) win.visible = !win.visible; }
                    else if (c === 0x8C) { win.defined = false; win.visible = false; win.grid = []; this._event('dlw', w); }
                }
                i += 2; continue;
            }
            if (c === 0x8F) { for (const w of this.windows) { w.defined = false; w.visible = false; w.grid = []; } this._event('reset'); i++; continue; }
            if (c === 0x92) {
                if (i + 3 > d.length) { this._pending = d.slice(i); return; }
                const w = this._cw();
                if (w) { w.penRow = Math.min(d[i + 1] & 0x0F, Math.max(0, w.rowCount - 1)); w.penCol = Math.min(d[i + 2] & 0x3F, Math.max(0, w.colCount - 1)); }
                i += 3; continue;
            }
            if (C1_LEN[c]) { const len = C1_LEN[c]; if (i + len > d.length) { this._pending = d.slice(i); return; } i += len; continue; }
            if (c >= 0xA0) { const w = this._cw(); if (w) this._put(w, c === 0xA0 ? ' ' : String.fromCharCode(c)); i++; continue; }
            i++;   // 0x93–0x96 reserved: 1 byte
        }
    }

    _cw() { const w = this.windows[this.current]; return w.defined ? w : null; }

    _put(w, ch, advance = true) {
        if (w.penRow >= w.rowCount || w.penCol >= w.colCount) return;
        const row = w.grid[w.penRow];
        w.grid[w.penRow] = row.slice(0, w.penCol) + ch + row.slice(w.penCol + 1);
        if (advance) w.penCol = Math.min(w.penCol + 1, w.colCount);   // sticks at the right edge; further text is dropped
    }

    _cr() {
        const w = this._cw();
        if (!w) return;
        if (w.penRow < w.rowCount - 1) { w.penRow++; }
        else { w.grid.shift(); w.grid.push(' '.repeat(w.colCount)); }
        w.penCol = 0;
        this._event('cr');
    }

    _defineWindow(id, p) {
        const w = this.windows[id];
        const rows = (p[3] & 0x0F) + 1, cols = (p[4] & 0x3F) + 1;
        const anchor = { relative: !!(p[1] & 0x80), v: p[1] & 0x7F, h: p[2], point: p[3] >> 4 };
        const existed = w.defined;
        const same = existed && w.rowCount === rows && w.colCount === cols;
        w.defined = true; w.visible = !!(p[0] & 0x20); w.anchor = anchor; w.defineCount++;
        if (!same || this.clearOnRedefine) { w.rowCount = rows; w.colCount = cols; w.clear(); }
        this.current = id;
        this._event(existed ? 'redefine' : 'define', id);
    }

    _event(kind, detail) { this.events.push({ frame: this.frame, kind, detail }); }

    /** Rows of every visible window, top to bottom, trailing spaces removed. */
    display() {
        const out = [];
        for (const w of this.windows) if (w.defined && w.visible) out.push(...w.rows());
        return out;
    }

    /** The window's placement, for checks of what a player would receive. */
    anchorOf(id = 0) { return this.windows[id].anchor; }
}

/** Parse the `dtvcc` hex column of sei-cc.mjs into packet bytes (null when empty). */
export function hexPacket(hex) {
    if (!hex) return null;
    const b = Buffer.from(hex, 'hex');
    return b.length ? b : null;
}

/** The DTVCC packet bytes carried by one CDP (header byte first), or null. */
export function dtvccFromCdp(cdp) {
    if (cdp[7] !== 0x72) return null;
    const n = cdp[8] & 0x1F;
    const out = [];
    for (let i = 0; i < n; i++) {
        const o = 9 + i * 3;
        const t = cdp[o];
        if ((t & 0x04) && (t & 0x03) >= 2) out.push(cdp[o + 1], cdp[o + 2]);
    }
    return out.length ? out : null;
}
