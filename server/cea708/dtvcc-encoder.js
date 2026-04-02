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
 * We use a simple rolling window approach:
 *   Window 0: bottom of screen, 2-3 rows, full width
 *   New text appended with CR for line breaks
 */

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

export class DtvccEncoder {
    constructor() {
        /** @type {Array<number[]>} Queue of service blocks (byte arrays) */
        this.blockQueue = [];
        this._windowDefined = false;
        this._lastEnqueuedText = '';
        this._lastEnqueuedTime = 0;
        this._rows = 2;
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
    _buildDefineWindow() {
        // DefineWindow0: DFW + 0 (window ID)
        // 6 bytes follow the command:
        //   byte 1: priority(3) | col_lock(1) | row_lock(1) | visible(1) | window_style(2-bit partial)
        //   byte 2: anchor_v (row position, 0-74 for 1080)
        //   byte 3: anchor_h (col position, 0-209 for 1080)
        //   byte 4: row_count(4) | col_count_hi(4)  — row_count is actual-1
        //   byte 5: col_count_lo(8) — total col_count is 10 bits
        //   byte 6: pen_style(3) | window_style(3)
        const block = [];
        block.push(CMD.DFW | 0); // DefineWindow 0

        // Byte 1: visible=1, priority=0, col_lock=0, row_lock=0
        // Bits: 0(priority) 0(col_lock) 0(row_lock) 1(visible) 0 0(anchor_id) 0 0
        block.push(0x00 | (1 << 5) | (0 << 0)); // visible=1, anchor_point=0 (bottom-left)

        // Anchor vertical: bottom of screen (~85% for safe area)
        block.push(70); // anchor_v

        // Anchor horizontal: left margin
        block.push(0);  // anchor_h

        // Row count (actual - 1) and column count high bits
        const rowCount = this._rows - 1;
        const colCount = 31; // 32 columns (0-indexed)
        block.push((rowCount << 4) | ((colCount >> 8) & 0x0F));

        // Column count low 8 bits
        block.push(colCount & 0xFF);

        // Pen style 1 (default), Window style 1 (roll-up)
        block.push((1 << 3) | 1);

        return block;
    }

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

        const block = [];

        // Define window on first use or after config change
        if (!this._windowDefined) {
            block.push(...this._buildDefineWindow());
            this._windowDefined = true;
        }

        // Set current window 0
        block.push(CMD.CW0);

        // Encode text as G0 characters (basic ASCII 0x20-0x7E)
        for (let i = 0; i < trimmed.length; i++) {
            const code = trimmed.charCodeAt(i);
            if (code >= 0x20 && code <= 0x7E) {
                block.push(code);
            } else {
                block.push(0x20); // Space for non-ASCII
            }
        }

        // Carriage return to roll up
        block.push(CMD.CR);

        // End of text - flush to display
        block.push(CMD.ETX);

        this.blockQueue.push(block);
    }

    /**
     * Enqueue a clear command.
     */
    enqueueClear() {
        const block = [];
        block.push(CMD.CLW);
        block.push(0x01); // Clear window 0 (bitmap: bit 0)
        this.blockQueue.push(block);
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
     * Multiple blocks can fit per frame depending on available triplets.
     *
     * @param {number} maxBytes - Maximum bytes available for DTVCC data this frame
     * @returns {number[]|null} DTVCC bytes or null if idle
     */
    drainFrame(maxBytes = 36) {
        if (this.blockQueue.length === 0) return null;

        const output = [];
        let remaining = maxBytes;

        while (this.blockQueue.length > 0 && remaining > 2) {
            const block = this.blockQueue[0];

            // Service block header: 3-bit service number + 5-bit size
            // Service 1 = 0x01, shifted left 5 = 0x20
            // Max block size per header = 31 bytes
            const chunkSize = Math.min(block.length, 31, remaining - 1);
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

    get queueLength() {
        return this.blockQueue.reduce((sum, b) => sum + b.length, 0);
    }

    get isBacklogged() {
        return this.queueLength > 200;
    }

    reset() {
        this.blockQueue = [];
        this._windowDefined = false;
        this._lastEnqueuedText = '';
        this._lastEnqueuedTime = 0;
    }
}
