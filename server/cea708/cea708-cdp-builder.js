/**
 * CEA-708 Caption Distribution Packet (CDP) Builder
 *
 * Wraps CEA-608 CC byte pairs into a SMPTE 334 CDP packet
 * suitable for embedding as VANC ancillary data on SDI output.
 *
 * CDP structure (per CAPTION_INTEGRATION.md):
 *   Bytes 0-1:   0x96 0x69         CDP identifier
 *   Byte 2:      length            Total CDP length
 *   Byte 3:      frame_rate|0x04   Frame rate code + cc_data_present flag
 *   Byte 4:      0xFF              Flags (caption_service_active)
 *   Bytes 5-6:   seq_hi seq_lo     Sequence counter
 *   Byte 7:      0x72              cc_data_section marker
 *   Byte 8:      0xE0|cc_count     cc_count with marker bits
 *   Bytes 9-11:  0xFC cc1 cc2      Field 1 CEA-608 data
 *   Bytes 12-14: 0xFD 0x80 0x80    Field 2 null
 *   Bytes 15+:   DTVCC null triplets (count depends on frame rate)
 *   Last 4:      0x74 seq_hi seq_lo CRC
 */

// Frame rate codes per CEA-708 Table 3
const FRAME_RATE_CODES = {
    '23.98': 0x01,
    '24':    0x02,
    '25':    0x03,
    '29.97': 0x04,
    '30':    0x05,
    '50':    0x06,
    '59.94': 0x07,
    '60':    0x08,
};

// Number of CC triplets per frame for each rate (per CEA-708 Table 2)
// This determines DTVCC service block padding
const CC_COUNT_BY_RATE = {
    '23.98': 4,
    '24':    4,
    '25':    4,
    '29.97': 3,
    '30':    3,
    '50':    2,
    '59.94': 2,
    '60':    2,
};

export class Cea708CdpBuilder {
    constructor() {
        this.sequence = 0;
    }

    /**
     * Build a complete CDP packet.
     *
     * @param {number} cc1 - First CEA-608 byte (with parity)
     * @param {number} cc2 - Second CEA-608 byte (with parity)
     * @param {string} [frameRate='29.97'] - Frame rate string
     * @returns {Uint8Array} The complete CDP packet
     */
    buildCDP(cc1, cc2, frameRate = '29.97') {
        const frCode = FRAME_RATE_CODES[frameRate] || 0x04;
        const ccCount = CC_COUNT_BY_RATE[frameRate] || 3;

        // Total triplets: field1 + field2 + DTVCC null padding
        // Field 1 = 1 triplet, Field 2 = 1 triplet, DTVCC = (ccCount - 2) triplets
        // But ccCount IS the total number of triplets
        const totalTriplets = ccCount;

        // CDP layout:
        //   2 (header) + 1 (length) + 1 (frame_rate) + 1 (flags)
        //   + 2 (seq) + 1 (cc_data marker) + 1 (cc_count)
        //   + totalTriplets * 3 (cc data)
        //   + 4 (footer: marker + seq + CRC)
        const cdpLength = 2 + 1 + 1 + 1 + 2 + 1 + 1 + (totalTriplets * 3) + 4;

        const cdp = new Uint8Array(cdpLength);
        let pos = 0;

        // Header
        cdp[pos++] = 0x96;  // CDP identifier byte 1
        cdp[pos++] = 0x69;  // CDP identifier byte 2

        // Length
        cdp[pos++] = cdpLength;

        // Frame rate (high nibble) + cc_data_present flag (0x04) + reserved bits
        cdp[pos++] = (frCode << 4) | 0x0F;

        // Flags: caption_service_active = all set
        cdp[pos++] = 0xFF;

        // Sequence counter (16-bit, big-endian)
        const seq = this.sequence & 0xFFFF;
        cdp[pos++] = (seq >> 8) & 0xFF;
        cdp[pos++] = seq & 0xFF;

        // cc_data_section marker
        cdp[pos++] = 0x72;

        // cc_count with marker bits (0xE0 | count)
        cdp[pos++] = 0xE0 | totalTriplets;

        // Triplet 1: Field 1 CEA-608 (the actual caption data)
        cdp[pos++] = 0xFC;  // cc_valid=1, cc_type=0 (field 1 NTSC)
        cdp[pos++] = cc1;
        cdp[pos++] = cc2;

        // Triplet 2: Field 2 null
        cdp[pos++] = 0xFD;  // cc_valid=1, cc_type=1 (field 2 NTSC)
        cdp[pos++] = 0x80;
        cdp[pos++] = 0x80;

        // Remaining DTVCC null triplets
        for (let i = 2; i < totalTriplets; i++) {
            cdp[pos++] = 0xFE;  // cc_valid=1, cc_type=2 or 3 (DTVCC)
            cdp[pos++] = 0x00;
            cdp[pos++] = 0x00;
        }

        // Footer
        cdp[pos++] = 0x74;  // cdp_footer_section marker

        // Sequence counter again in footer
        cdp[pos++] = (seq >> 8) & 0xFF;
        cdp[pos++] = seq & 0xFF;

        // CRC: sum of all bytes from position 0 to here, then 256 - (sum % 256)
        let sum = 0;
        for (let i = 0; i < pos; i++) {
            sum += cdp[i];
        }
        cdp[pos++] = (256 - (sum % 256)) % 256;

        // Increment sequence for next frame
        this.sequence = (this.sequence + 1) & 0xFFFF;

        return cdp;
    }

    /**
     * Reset the sequence counter.
     */
    reset() {
        this.sequence = 0;
    }
}
