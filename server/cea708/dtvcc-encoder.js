/**
 * CEA-708 DTVCC Service 1 Encoder
 *
 * Produces DTVCC caption service data for embedding in CDP packets.
 * Much higher throughput than CEA-608: uses multiple DTVCC triplets per
 * frame for ~200+ chars/sec at 29.97fps (vs CEA-608's ~60 chars/sec).
 *
 * DTVCC service block structure (CEA-708-E Section 7):
 *   - Service blocks contain caption commands and text
 *   - Each block starts with a service header (service number + block size)
 *   - Commands: DefineWindow, SetPenLocation, SetPenAttributes, etc.
 *   - Text: direct UTF-8/G0/G1 character codes
 *
 * Two transport styles, both on window 0 (bottom-centre, 2–3 rows):
 *
 *   classic (setRepaint(0)): roll-up — text rows followed by CR, as a byte
 *   stream split across frames. Compact, but a decoder behind a lossy
 *   encoder (the Blackmagic Web Presenter 4K drops 13–60 % of caption
 *   frames, mostly one or two at a time) loses characters and merges rows.
 *
 *   redraw (setRepaint(N), the default): every frame carries ONE
 *   self-contained packet — SetPenLocation(row, col) + the row's text padded
 *   to the chunk width + ETX — so a lost frame can only leave one stale
 *   chunk behind, never text on the wrong row. Each caption is sent as a
 *   DefineWindow packet (also the "clear" for YouTube's converter, which
 *   treats DefineWindow as clear) followed by one packet per row chunk,
 *   then the row packets again `repeat` times with `repeatGap` idle frames
 *   between copies (losses come in short bursts, so spaced copies survive
 *   independently), and the whole window is re-sent every N frames while
 *   anything is displayed. All writes are idempotent for the decoder.
 *   N = 1 is "continuous": the rows alternate on every frame. Measured through
 *   a Web Presenter 4K losing 35–40 % of caption frames (2026-10-12): keep-alive
 *   1 s → 75 % of frames correct, ½ s → 92 %, 5 frames → 99 %, continuous →
 *   100 % with every caption complete within 12 frames; never a garbled row.
 */

import { wrapRows, CEA608_COLUMNS } from './cea608-encoder.js';

// DTVCC command codes
const CMD = {
    // Window commands (C1 codes, 0x80-0x9F)
    CW0: 0x80,       // SetCurrentWindow 0
    CLW: 0x88,       // ClearWindows (bitmap)
    DFW: 0x98,       // DefineWindow (0-7)
    CR:  0x0D,       // Carriage Return (moves to next row)
    HCR: 0x0E,       // Horizontal Carriage Return (clears row, moves to start)
    FF:  0x0C,       // Form Feed (clears window, moves to 0,0)
    ETX: 0x03,       // End of Text (flush display)

    // Pen commands
    SPA: 0x90,       // SetPenAttributes
    SPC: 0x91,       // SetPenColor
    SPL: 0x92,       // SetPenLocation

    // Window attribute
    SWA: 0x97,       // SetWindowAttributes
};

const MAX_BLOCK = 31;           // service block payload limit (5-bit size)
const DEFAULT_CAPACITY = 34;    // service data bytes per frame at 29.97 (see Cea708CdpBuilder.dtvccCapacity)

export class DtvccEncoder {
    constructor() {
        /** @type {Array<number[]>} Classic mode: queue of service blocks (byte arrays) */
        this.blockQueue = [];
        /** @type {Array<number[]|null>} Redraw mode: one packet (service-block bytes) per frame, null = idle frame */
        this._packets = [];
        this._windowDefined = false;
        this._lastEnqueuedText = '';
        this._lastEnqueuedTime = 0;
        this._rows = 2;
        this._lines = [];
        // Redraw mode settings (see class comment). repaintFrames 0 = classic roll-up.
        this._repaintFrames = 1;    // continuous (default since 6.13.1)
        this._repeat = 1;           // copies of every row packet per caption / keep-alive
        this._repeatGap = 3;        // idle frames between copies
        this._keepAlive = true;     // false = burst only: the rows go out `repeat` times after a caption and never again
        this._style = 'rollup';     // 'rollup' = one visible window 0 rewritten in place; 'popon' = two windows, the new
                                    // caption is written into the hidden one and shown with DisplayWindow + HideWindow;
                                    // 'youtube' = window 0, every copy starts with HideWindow + DefineWindow (YouTube's
                                    // converter emits the pending cue on HideWindow, restarts it on DefineWindow or
                                    // DisplayWindow, and ignores text re-writes that follow a few idle frames)
        this._win = 1;              // pop-on: window of the caption on screen (the next caption uses the other one)
        this._maxBlocks = 1;        // service blocks per packet (2 = 29-column rows at 29.97, needs decoder support)
        this._rowErase = 'pad';     // 'pad' = rows padded with spaces, 'hcr' = HCR then text (no padding)
        this._defineOnChange = true;
        this._columns = 0;          // 0 = one packet per row (27 columns at 29.97), else a fixed width sent in chunks
        this._capacity = DEFAULT_CAPACITY;
        this._framesSinceRepaint = 0;
        this._blankRedrawsLeft = 0;
        this._repaintCount = 0;
        this._classicRowsWritten = 0;
    }

    /** Re-send the full window every `frames` frames (0 = classic roll-up, no redraws). */
    setRepaint(frames) {
        this._repaintFrames = Math.max(0, Math.min(300, Math.round(frames) || 0));
        this._framesSinceRepaint = 0;
    }

    get repaintFrames() { return this._repaintFrames; }

    /**
     * Redraw-mode transport options (all optional):
     *   repeat     1–6 copies of every row packet (default 2)
     *   repeatGap  idle frames between copies (default 3)
     *   keepAlive  re-send the window every repaintFrames frames (default true); false = burst only,
     *              for destinations whose caption converter restarts the caption on every write
     *              (YouTube keeps only the last identical cue of each 5 s segment, so a window that
     *              is re-sent every second is shown for one second in five)
     *   maxBlocks  1 or 2 service blocks per packet (default 1)
     *   rowErase   'pad' | 'hcr' (default 'pad')
     *   defineOnChange  send DefineWindow with every new caption (default true)
     */
    setRedraw(opts = {}) {
        if (opts.repeat !== undefined) this._repeat = Math.max(1, Math.min(6, Math.round(opts.repeat) || 1));
        if (opts.keepAlive !== undefined) this._keepAlive = !!opts.keepAlive;
        if (opts.style !== undefined) { this._style = ['popon', 'youtube'].includes(opts.style) ? opts.style : 'rollup'; this._windowDefined = false; }
        if (opts.repeatGap !== undefined) this._repeatGap = Math.max(0, Math.min(15, Math.round(opts.repeatGap) || 0));
        if (opts.maxBlocks !== undefined) this._maxBlocks = opts.maxBlocks === 2 ? 2 : 1;
        if (opts.rowErase !== undefined) this._rowErase = opts.rowErase === 'hcr' ? 'hcr' : 'pad';
        if (opts.defineOnChange !== undefined) this._defineOnChange = !!opts.defineOnChange;
        if (opts.columns !== undefined) this._columns = opts.columns ? Math.max(16, Math.min(CEA608_COLUMNS, Math.round(opts.columns))) : 0;
    }

    get redrawOptions() {
        return { style: this._style, repeat: this._repeat, repeatGap: this._repeatGap, keepAlive: this._keepAlive, maxBlocks: this._maxBlocks, rowErase: this._rowErase, defineOnChange: this._defineOnChange, columns: this.columns };
    }

    /** Service-data bytes available per frame (from Cea708CdpBuilder.dtvccCapacity(frameRate)). */
    setFrameCapacity(bytes) {
        const c = Math.max(8, Math.min(128, Math.round(bytes) || DEFAULT_CAPACITY));
        if (c !== this._capacity) {
            this._capacity = c;
            // the chunk layout depends on the capacity: re-send what is pending in the new layout
            if (this._packets.length) this._queueRedraw(true);
        }
    }

    /** Characters of text one self-contained row packet can carry at the current capacity. */
    get chunkChars() {
        const blocks = this._maxBlocks;
        const data = Math.min(blocks * MAX_BLOCK, this._capacity - blocks);  // minus one header byte per block
        return Math.max(1, data - 3 - 1 - (this._style === 'popon' ? 1 : 0)); // SPL(3) + ETX(1) [+ SetCurrentWindow(1)]
    }

    /**
     * Row width in redraw mode. Default: one packet per row when that gives at least 24
     * columns (27 at 29.97 with one service block), else 32 columns sent in several chunks.
     * A fixed width (setRedraw({columns})) is always sent in as many chunks as needed.
     */
    get columns() {
        if (this._repaintFrames === 0) return CEA608_COLUMNS;
        if (this._columns) return this._columns;
        const c = this.chunkChars;
        return c >= 24 ? Math.min(CEA608_COLUMNS, c) : CEA608_COLUMNS;
    }

    /**
     * Set number of visible rows (2 or 3).
     */
    setRows(rows) {
        this._rows = (rows === 3) ? 3 : 2;
        this._windowDefined = false; // Force redefine on next text
    }

    /**
     * Build a DefineWindow command for Window 0.
     * Bottom of screen, full width, configured rows.
     */
    _buildDefineWindow(id = 0, visible = true) {
        // DefineWindow (CEA-708 §8.4.5), six parameter bytes:
        //   1: reserved(2) visible(1) row_lock(1) column_lock(1) priority(3)
        //   2: relative_positioning(1) anchor_vertical(7)
        //   3: anchor_horizontal(8)
        //   4: anchor_point(4) row_count(4)        — row_count is rows − 1
        //   5: reserved(2) column_count(6)         — column_count is columns − 1
        //   6: reserved(2) window_style(3) pen_style(3)
        // An earlier version put the row count in the anchor-point nibble, so decoders
        // saw "anchor 1 (top-centre), 1 row" at the left edge: the window was centred on
        // the screen's left edge (half of it offscreen) and showed one row.
        const block = [];
        block.push(CMD.DFW | (id & 7));                  // DefineWindow id
        block.push((visible ? 1 : 0) << 5);              // visible flag, no locks, priority 0
        block.push(0x80 | 90);                           // relative positioning, 90 % down
        block.push(50);                                  // 50 % across
        block.push((7 << 4) | ((this._rows - 1) & 0x0F)); // anchor 7 = bottom-centre; rows − 1
        block.push((this.columns - 1) & 0x3F);           // columns − 1
        block.push((1 << 3) | 1);                        // window style 1 (608 pop-up), pen style 1
        return block;
    }

    // ---------------------------------------------------------------- redraw mode

    /** Wrap one service-data byte array into service blocks (service 1). Returns the packet bytes. */
    _blocks(data) {
        const out = [];
        let i = 0;
        while (i < data.length) {
            const n = Math.min(MAX_BLOCK, data.length - i);
            out.push((1 << 5) | n, ...data.slice(i, i + n));
            i += n;
        }
        return out;
    }

    /** Packets that draw every row (and chunk) of the window, top to bottom. */
    _rowPackets(win = 0) {
        const packets = [];
        const width = this.columns;
        const chunk = this.chunkChars;
        for (let r = 0; r < this._rows; r++) {
            const text = (this._lines[r] || '');
            const useHcr = this._rowErase === 'hcr' && chunk >= width;
            for (let col = 0; col < width; col += chunk) {
                const piece = text.slice(col, col + chunk);
                const data = this._style === 'popon' ? [CMD.CW0 | (win & 7)] : [];
                data.push(CMD.SPL, r & 0x0F, col & 0x3F);
                if (useHcr) data.push(CMD.HCR);
                const padded = useHcr ? piece : piece.padEnd(Math.min(chunk, width - col), ' ');
                for (let i = 0; i < padded.length; i++) {
                    const code = padded.charCodeAt(i);
                    data.push(code >= 0x20 && code <= 0x7E ? code : 0x20);
                }
                data.push(CMD.ETX);
                packets.push(this._blocks(data));
            }
        }
        return packets;
    }

    /** Queue a full redraw: [DefineWindow] + rows, then `repeat − 1` more copies of the rows after `repeatGap` idle frames. */
    _queueRedraw(withDefine, newCaption = false) {
        this._packets = [];
        if (this._style === 'popon') return this._queuePopon(withDefine, newCaption);
        if (this._style === 'youtube') return this._queueYoutube(newCaption);
        if (withDefine) {
            this._packets.push(this._blocks(this._buildDefineWindow()));
            this._windowDefined = true;
            this._repaintCount++;
        }
        const rows = this._rowPackets();
        // extra copies only pay off when there is no keep-alive or it is slower than the copy gap
        const copies = (this._keepAlive && this._repaintFrames <= this._repeatGap + rows.length) ? 1 : this._repeat;
        for (let copy = 0; copy < copies; copy++) {
            if (copy > 0) for (let g = 0; g < this._repeatGap; g++) this._packets.push(null);
            this._packets.push(...rows);
        }
        this._framesSinceRepaint = 0;
    }

    /**
     * Pop-on style: a new caption goes into the hidden window (the other of 0/1), every row
     * packet names its window (SetCurrentWindow) so a lost DefineWindow cannot send text into
     * the visible one, and a "show" packet (DisplayWindow new + HideWindow old + ETX) swaps
     * them; copies and keep-alives repeat rows + show, all idempotent. Caption converters
     * that key cues on window visibility (YouTube) get one cue per caption, from the first
     * show to the next caption's swap.
     */
    _queuePopon(withDefine, newCaption) {
        const prev = this._win;
        const win = newCaption ? 1 - prev : prev;
        if (newCaption) this._win = win;
        const showPacket = this._blocks([0x89, 1 << win, 0x8A, 1 << (1 - win), CMD.ETX]);   // DSW new, HDW old
        const rows = this._rowPackets(win);
        const copies = (this._keepAlive && this._repaintFrames <= this._repeatGap + rows.length + 1) ? 1 : this._repeat;
        if (newCaption) {
            // Front-loaded redundancy, all into the still-hidden window: `copies` DefineWindows
            // one frame apart, then the rows `copies` times back to back, then the show packet
            // `copies` times `repeatGap` frames apart. YouTube's converter freezes a cue's text at
            // the first DisplayWindow it receives (later ones only restart the cue), so the rows
            // must be complete before any show command can arrive; on a decoder nothing is
            // visible until the first show, so the extra copies cost no blink.
            for (let c = 0; c < copies; c++) { if (c > 0) this._packets.push(null); this._packets.push(this._blocks(this._buildDefineWindow(win, false))); }
            for (let c = 0; c < copies; c++) this._packets.push(...rows);
            for (let c = 0; c < copies; c++) { if (c > 0) for (let g = 0; g < this._repeatGap; g++) this._packets.push(null); this._packets.push(showPacket); }
            this._windowDefined = true;
            this._repaintCount++;
        } else {
            // keep-alive: rows again (+ show, idempotent) for the window on screen
            if (withDefine) this._packets.push(this._blocks(this._buildDefineWindow(win, false)));
            for (let copy = 0; copy < copies; copy++) {
                if (copy > 0) for (let g = 0; g < this._repeatGap; g++) this._packets.push(null);
                this._packets.push(...rows, showPacket);
            }
        }
        this._framesSinceRepaint = 0;
    }

    /**
     * YouTube style: for a new caption, `repeat` copies of [HideWindow 0 + DefineWindow 0
     * (visible)] + the rows, `repeatGap` idle frames apart. The HideWindow closes the previous
     * caption's cue, the DefineWindow opens the new one; a repeated pair just closes and
     * reopens an identical cue, so the caption starts with the first copy that arrives and
     * ends with the next caption's first HideWindow. Keep-alives (if enabled) send rows only.
     */
    _queueYoutube(newCaption) {
        // rows, then the first row once more: YouTube's pending cue holds the window as it was
        // before the last write, so a cue cut at a segment boundary would miss the last row
        const rows = this._rowPackets();
        if (rows.length > 1) rows.push(rows[0]);
        const head = this._blocks([0x8A, 0x01, ...this._buildDefineWindow(0, true)]);
        const copies = newCaption ? this._repeat : 1;
        for (let copy = 0; copy < copies; copy++) {
            if (copy > 0) for (let g = 0; g < this._repeatGap; g++) this._packets.push(null);
            if (newCaption) this._packets.push(head);
            this._packets.push(...rows);
        }
        this._windowDefined = true;
        if (newCaption) this._repaintCount++;
        this._framesSinceRepaint = 0;
    }

    // ---------------------------------------------------------------- public API

    /**
     * Enqueue caption text as DTVCC service blocks.
     */
    enqueueText(text) {
        const trimmed = text.trim();
        if (!trimmed) return;

        // Deduplication
        const now = Date.now();
        if (trimmed === this._lastEnqueuedText && (now - this._lastEnqueuedTime) < 2000) {
            return;
        }
        this._lastEnqueuedText = trimmed;
        this._lastEnqueuedTime = now;

        if (this._repaintFrames > 0) {
            // Redraw mode: new rows scroll in at the bottom (roll-up) or replace the window
            // (pop-on: each caption stands alone), then the whole window is re-sent.
            const rows = wrapRows(trimmed, this.columns);
            if (this._style === 'popon') this._lines = rows.slice(-this._rows);
            else for (const row of rows) {
                this._lines.push(row);
                while (this._lines.length > this._rows) this._lines.shift();
            }
            this._blankRedrawsLeft = 0;
            this._queueRedraw(this._defineOnChange || !this._windowDefined, true);
            return;
        }

        const block = [];

        // Define window on first use or after config change
        if (!this._windowDefined) {
            block.push(...this._buildDefineWindow());
            this._windowDefined = true;
        }

        // Set current window 0
        block.push(CMD.CW0);

        // Encode text as G0 characters (basic ASCII 0x20-0x7E), one 32-column row at a
        // time. Like the CEA-608 encoder, the carriage return comes BEFORE each row
        // (except the very first row after start/clear): the previous rows scroll up and
        // the new row lands on the bottom row. A CR after the last row would scroll that
        // row off as well and leave a blank bottom row.
        const rows = wrapRows(trimmed, CEA608_COLUMNS);
        rows.forEach((row) => {
            if (this._classicRowsWritten > 0) block.push(CMD.CR);
            this._classicRowsWritten++;
            for (let i = 0; i < row.length; i++) {
                const code = row.charCodeAt(i);
                block.push(code >= 0x20 && code <= 0x7E ? code : 0x20);
            }
        });

        // End of text - flush to display
        block.push(CMD.ETX);

        this.blockQueue.push(block);
    }

    /**
     * Enqueue a clear command.
     */
    enqueueClear() {
        this._lines = [];
        if (this._repaintFrames > 0) {
            if (this._style === 'popon' || this._style === 'youtube') {
                // hide the window(s), repeated for the copies
                this._packets = [];
                for (let copy = 0; copy < this._repeat; copy++) {
                    if (copy > 0) for (let g = 0; g < this._repeatGap; g++) this._packets.push(null);
                    this._packets.push(this._blocks([0x8A, 0x03, CMD.ETX]));
                }
                this._windowDefined = false;
                return;
            }
            // Blank rows, re-sent for a few keep-alive cycles so a lossy path still clears.
            this._blankRedrawsLeft = 3;
            this._queueRedraw(false);
            return;
        }
        const block = [];
        block.push(CMD.CLW);
        block.push(0x01); // Clear window 0 (bitmap: bit 0)
        this.blockQueue.push(block);
        this._classicRowsWritten = 0;
    }

    /**
     * Drain DTVCC data for one frame.
     * Returns an array of bytes to fill DTVCC triplets in the CDP,
     * or null if no data is queued.
     *
     * DTVCC data is packed into service blocks:
     *   Header: service_number(3bits) | block_size(5bits)
     *   Then block_size bytes of service data
     *
     * @param {number} maxBytes - Maximum bytes available for DTVCC data this frame
     * @returns {number[]|null} DTVCC bytes or null if idle
     */
    drainFrame(maxBytes = DEFAULT_CAPACITY) {
        if (this._repaintFrames > 0) {
            this.setFrameCapacity(maxBytes);
            if (this._packets.length === 0 && this._keepAlive) {
                const showing = this._lines.some(Boolean) || this._blankRedrawsLeft > 0;
                if (++this._framesSinceRepaint >= this._repaintFrames && showing) {
                    if (this._blankRedrawsLeft > 0) this._blankRedrawsLeft--;
                    this._queueRedraw(false);
                }
            }
            if (this._packets.length === 0) return null;
            const pkt = this._packets.shift();
            if (!pkt) return null;                 // deliberate idle frame between copies
            if (pkt.length > maxBytes) {           // capacity shrank: rebuild with the new layout
                this._queueRedraw(true);
                return null;
            }
            return pkt.length % 2 ? [...pkt, 0x00] : pkt;
        }

        if (this.blockQueue.length === 0) return null;

        const output = [];
        let remaining = maxBytes;

        while (this.blockQueue.length > 0 && remaining > 2) {
            const block = this.blockQueue[0];

            // Service block header: 3-bit service number + 5-bit size
            // Service 1 = 0x01, shifted left 5 = 0x20
            // Max block size per header = 31 bytes
            const chunkSize = Math.min(block.length, MAX_BLOCK, remaining - 1);
            if (chunkSize <= 0) break;

            // Service header byte: service_number=1 (bits 7-5), block_size (bits 4-0)
            output.push((1 << 5) | chunkSize);

            // Service data
            for (let i = 0; i < chunkSize; i++) {
                output.push(block.shift());
            }

            remaining -= (1 + chunkSize);

            // Remove empty blocks
            if (block.length === 0) {
                this.blockQueue.shift();
            }
        }

        // If we have data, pad to even number of bytes (DTVCC requirement)
        if (output.length > 0 && output.length % 2 !== 0) {
            // Null service block header (service 0, size 0)
            output.push(0x00);
        }

        return output.length > 0 ? output : null;
    }

    /** Bytes still to be sent (packets in redraw mode, service-block bytes in classic mode). */
    get queueLength() {
        if (this._repaintFrames > 0) return this._packets.reduce((sum, p) => sum + (p ? p.length : 0), 0);
        return this.blockQueue.reduce((sum, b) => sum + b.length, 0);
    }

    get isBacklogged() {
        return this.queueLength > 200;
    }

    /** The rows currently meant to be on screen (redraw mode). */
    get lines() { return this._lines.slice(); }

    reset() {
        this.blockQueue = [];
        this._packets = [];
        this._windowDefined = false;
        this._lastEnqueuedText = '';
        this._lastEnqueuedTime = 0;
        this._lines = [];
        this._framesSinceRepaint = 0;
        this._blankRedrawsLeft = 0;
        this._repaintCount = 0;
        this._classicRowsWritten = 0;
        this._win = 1;
    }
}
