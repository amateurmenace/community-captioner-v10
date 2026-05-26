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

// Number of CC triplets per frame for the CEA-608-only buildCDP path.
// Kept small here (Field 1 + Field 2 + 1 null DTVCC) because the original
// CEA-608 use case doesn't need DTVCC bandwidth and many older decoders
// expect the minimum count.
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

// Full SMPTE 334 / CEA-708 cc_count values. Used by buildCDP_DTVCC so we
// have enough triplets to carry both CEA-608 Field 1 + Field 2 AND a
// useful DTVCC service-block payload every frame (~600 triplets/sec total
// throughput across rates — the CEA-708 spec target).
const FULL_CC_COUNT_BY_RATE = {
    '23.98': 25,
    '24':    25,
    '25':    24,
    '29.97': 20,
    '30':    20,
    '50':    12,
    '59.94': 10,
    '60':    10,
};

export class Cea708CdpBuilder {
    constructor() {
        this.sequence = 0;
        this.dtvccSequence = 0; // 2-bit rolling counter for DTVCC packet headers
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
        const totalTriplets = ccCount;

        // CDP layout matches the Blackmagic SDK reference encoder:
        //   2 (header 0x9669)
        //   1 (cdp_length)
        //   1 (frame_rate + reserved)
        //   1 (flags: which sections are present)
        //   2 (cdp_header_sequence_counter)
        //   --- ccdata_section ---
        //   1 (0x72)
        //   1 (0xE0 | cc_count)
        //   3 * totalTriplets  (cc_data triplets)
        //   --- ccsvcinfo_section (REQUIRED — many decoders ignore CDPs without it) ---
        //   2 (header: 0x73 + flags)
        //   7 (one service descriptor)
        //   --- cdp_footer_section ---
        //   4 (0x74 + seq + CRC)
        const ccDataSectionLen = 2 + totalTriplets * 3;
        const svcInfoSectionLen = 9;
        const footerLen = 4;
        const cdpLength = 7 /* header */ + ccDataSectionLen + svcInfoSectionLen + footerLen;

        const cdp = new Uint8Array(cdpLength);
        let pos = 0;

        // --- CDP header ---
        cdp[pos++] = 0x96;                              // identifier hi
        cdp[pos++] = 0x69;                              // identifier lo
        cdp[pos++] = cdpLength;                          // cdp_length
        cdp[pos++] = (frCode << 4) | 0x0F;               // cdp_frame_rate + reserved nibble
        // flags: ccdata_present | svcinfo_present | svc_info_start | svc_info_complete | caption_service_active | reserved
        //       (0x40)         | (0x20)          | (0x10)         | (0x04)            | (0x02)                | (0x01)
        cdp[pos++] = 0x40 | 0x20 | 0x10 | 0x04 | 0x02 | 0x01;  // = 0x77
        const seq = this.sequence & 0xFFFF;
        cdp[pos++] = (seq >> 8) & 0xFF;
        cdp[pos++] = seq & 0xFF;

        // --- ccdata_section ---
        cdp[pos++] = 0x72;                               // ccdata_id
        cdp[pos++] = 0xE0 | totalTriplets;               // marker bits | cc_count

        // Triplet 1: Field 1 CEA-608 (the actual caption byte pair)
        cdp[pos++] = 0xFC;                               // cc_valid=1, cc_type=0 (field 1 NTSC)
        cdp[pos++] = cc1;
        cdp[pos++] = cc2;

        // Triplet 2: Field 2 null
        cdp[pos++] = 0xFD;                               // cc_valid=1, cc_type=1 (field 2 NTSC)
        cdp[pos++] = 0x80;
        cdp[pos++] = 0x80;

        // Remaining DTVCC null triplets (cc_valid=0)
        for (let i = 2; i < totalTriplets; i++) {
            cdp[pos++] = (0x1F << 3) | 0x02;             // marker | cc_type 708 data, cc_valid=0
            cdp[pos++] = 0x00;
            cdp[pos++] = 0x00;
        }

        // --- ccsvcinfo_section (CEA-708 §4.5, ATSC A/65 Table 6.26) ---
        // Advertises one service: Primary Caption Service, English, digital_cc, 16:9.
        // Without this block, common CC-aware decoders treat the CDP as "no caption services" and ignore it.
        cdp[pos++] = 0x73;                               // ccsvcinfo_id
        cdp[pos++] = 0x80 | (1 << 6) | (1 << 4) | 1;     // reserved | svc_info_start | svc_info_complete | svc_count=1  = 0xD1
        cdp[pos++] = 0x80 | (1 & 0x3F);                  // reserved | csn_size=0 | caption_service_number=1
        cdp[pos++] = 0x65;                               // 'e'
        cdp[pos++] = 0x6E;                               // 'n'
        cdp[pos++] = 0x67;                               // 'g'
        cdp[pos++] = 0x80 | 1;                           // digital_cc=1 | caption_service_number=1  = 0x81
        cdp[pos++] = 0x7F;                               // !easy_reader, 16:9 aspect, reserved
        cdp[pos++] = 0xFF;                               // reserved

        // --- footer ---
        cdp[pos++] = 0x74;                               // cdp_footer_id
        cdp[pos++] = (seq >> 8) & 0xFF;
        cdp[pos++] = seq & 0xFF;

        // CRC: byte that makes the sum of the whole CDP (mod 256) equal zero
        let sum = 0;
        for (let i = 0; i < pos; i++) sum += cdp[i];
        cdp[pos++] = (256 - (sum & 0xFF)) & 0xFF;

        this.sequence = (this.sequence + 1) & 0xFFFF;
        return cdp;
    }

    /**
     * Build a CDP carrying both CEA-608 (Field 1) AND a DTVCC packet of
     * service block data. Decoders that read Field 1 (most "web presenter"
     * boxes) still see the CEA-608 byte pair; modern decoders that parse
     * DTVCC service blocks get real Service 1 data too.
     *
     * Layout per SMPTE 334-2 / CEA-708:
     *   - CDP header (7 bytes)
     *   - ccdata_section header (2 bytes: 0x72 + 0xE0|cc_count)
     *   - Triplet 0: F1 CEA-608 (0xFC, cc1, cc2)
     *   - Triplet 1: F2 CEA-608 null (0xFD, 0x80, 0x80)
     *   - Triplet 2: DTVCC packet start (0xFF, header, data[0])
     *   - Triplets 3..N-1: DTVCC packet continuation (0xFE, data[i], data[i+1])
     *   - ccsvcinfo_section (9 bytes, advertises Service 1 / digital_cc / English)
     *   - footer (4 bytes: 0x74 + seq + CRC)
     *
     * If dtvccData is empty, the DTVCC triplets are padded with cc_valid=0
     * markers (still spec-compliant; decoders skip them).
     *
     * @param {number[]|Uint8Array|null} dtvccData - service block bytes from DtvccEncoder.drainFrame()
     * @param {string} frameRate
     * @param {number} cc1 - CEA-608 byte 1 (parity bit set)
     * @param {number} cc2 - CEA-608 byte 2 (parity bit set)
     */
    buildCDP_DTVCC(dtvccData, frameRate = '29.97', cc1 = 0x80, cc2 = 0x80) {
        const frCode = FRAME_RATE_CODES[frameRate] || 0x04;
        const totalTriplets = FULL_CC_COUNT_BY_RATE[frameRate] || 20;
        const dtvccTriplets = totalTriplets - 2; // F1 + F2 fixed; remainder is DTVCC

        // Build the DTVCC packet (header byte + service-block payload, padded
        // to fit a whole number of cc_data words). The packet's bytes get
        // spread across the DTVCC triplets two per triplet.
        let packetBytes = null;
        if (dtvccData && dtvccData.length > 0) {
            // The packet payload (after the 1-byte DTVCC header) must be an
            // even number of bytes. Pad if needed.
            let payload = Array.from(dtvccData);
            if (payload.length % 2 !== 0) payload.push(0x00);
            const payloadWords = payload.length / 2;
            if (payloadWords >= 1 && payloadWords <= 63) {
                const dtvccHeader = (payloadWords << 2) | (this.dtvccSequence & 0x03);
                this.dtvccSequence = (this.dtvccSequence + 1) & 0x03;
                packetBytes = [dtvccHeader, ...payload];
                // If the packet doesn't fill all DTVCC triplets, that's OK —
                // we'll pad with cc_valid=0 markers below.
                // If it OVERFLOWS, truncate to fit (drainFrame should have
                // sized it correctly upstream).
                const maxBytes = dtvccTriplets * 2;
                if (packetBytes.length > maxBytes) packetBytes = packetBytes.slice(0, maxBytes);
                while (packetBytes.length % 2 !== 0) packetBytes.push(0x00);
            }
        }

        const ccDataSectionLen = 2 + totalTriplets * 3;
        const svcInfoSectionLen = 9;
        const footerLen = 4;
        const cdpLength = 7 + ccDataSectionLen + svcInfoSectionLen + footerLen;

        const cdp = new Uint8Array(cdpLength);
        let pos = 0;

        // --- CDP header ---
        cdp[pos++] = 0x96;
        cdp[pos++] = 0x69;
        cdp[pos++] = cdpLength;
        cdp[pos++] = (frCode << 4) | 0x0F;
        cdp[pos++] = 0x40 | 0x20 | 0x10 | 0x04 | 0x02 | 0x01; // = 0x77, same flags as buildCDP
        const seq = this.sequence & 0xFFFF;
        cdp[pos++] = (seq >> 8) & 0xFF;
        cdp[pos++] = seq & 0xFF;

        // --- ccdata_section ---
        cdp[pos++] = 0x72;
        cdp[pos++] = 0xE0 | totalTriplets;

        // Triplet 0: Field 1 CEA-608
        cdp[pos++] = 0xFC; // marker | cc_valid=1 | cc_type=00
        cdp[pos++] = cc1;
        cdp[pos++] = cc2;

        // Triplet 1: Field 2 null
        cdp[pos++] = 0xFD; // marker | cc_valid=1 | cc_type=01
        cdp[pos++] = 0x80;
        cdp[pos++] = 0x80;

        // Triplets 2..N: DTVCC packet (start + continuations) or padding
        if (packetBytes && packetBytes.length > 0) {
            let idx = 0;
            // First triplet: cc_type=11 (DTVCC_PACKET_START)
            cdp[pos++] = 0xFF;
            cdp[pos++] = idx < packetBytes.length ? packetBytes[idx++] : 0;
            cdp[pos++] = idx < packetBytes.length ? packetBytes[idx++] : 0;
            // Continuations: cc_type=10 (DTVCC_PACKET_DATA)
            for (let t = 1; t < dtvccTriplets; t++) {
                if (idx < packetBytes.length) {
                    cdp[pos++] = 0xFE;
                    cdp[pos++] = packetBytes[idx++];
                    cdp[pos++] = idx < packetBytes.length ? packetBytes[idx++] : 0;
                } else {
                    // pad with cc_valid=0
                    cdp[pos++] = (0x1F << 3) | 0x02; // 0xFA
                    cdp[pos++] = 0x00;
                    cdp[pos++] = 0x00;
                }
            }
        } else {
            // No DTVCC data this frame — pad all DTVCC slots with cc_valid=0.
            for (let t = 0; t < dtvccTriplets; t++) {
                cdp[pos++] = (0x1F << 3) | 0x02; // 0xFA
                cdp[pos++] = 0x00;
                cdp[pos++] = 0x00;
            }
        }

        // --- ccsvcinfo_section (advertises Service 1 / English / digital_cc) ---
        cdp[pos++] = 0x73;
        cdp[pos++] = 0x80 | (1 << 6) | (1 << 4) | 1; // 0xD1
        cdp[pos++] = 0x80 | (1 & 0x3F);              // 0x81
        cdp[pos++] = 0x65; // 'e'
        cdp[pos++] = 0x6E; // 'n'
        cdp[pos++] = 0x67; // 'g'
        cdp[pos++] = 0x80 | 1; // digital_cc | service_number=1
        cdp[pos++] = 0x7F;
        cdp[pos++] = 0xFF;

        // --- footer ---
        cdp[pos++] = 0x74;
        cdp[pos++] = (seq >> 8) & 0xFF;
        cdp[pos++] = seq & 0xFF;

        let sum = 0;
        for (let i = 0; i < pos; i++) sum += cdp[i];
        cdp[pos++] = (256 - (sum & 0xFF)) & 0xFF;

        this.sequence = (this.sequence + 1) & 0xFFFF;
        return cdp;
    }

    /**
     * Reset the sequence counter.
     */
    reset() {
        this.sequence = 0;
        this.dtvccSequence = 0;
    }
}
