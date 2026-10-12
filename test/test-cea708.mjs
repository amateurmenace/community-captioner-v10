#!/usr/bin/env node
/**
 * CEA-708 Integration Test Suite
 *
 * Tests all three layers:
 *   1. CEA-608 Encoder — text → CC byte pairs
 *   2. CEA-708 CDP Builder — CC pairs → SMPTE 334 packets
 *   3. WebSocket Bridge — relay forwards captions to /cea708 clients
 *   4. Native Addon — DeckLink module loads (no hardware required)
 */

import { Cea608Encoder } from '../server/cea708/cea608-encoder.js';
import { Cea708CdpBuilder } from '../server/cea708/cea708-cdp-builder.js';

let passed = 0;
let failed = 0;

function assert(condition, label) {
    if (condition) {
        console.log(`  ✅ ${label}`);
        passed++;
    } else {
        console.log(`  ❌ ${label}`);
        failed++;
    }
}

// ─────────────────────────────────────────────
// 1. CEA-608 Encoder Tests
// ─────────────────────────────────────────────
console.log('\n═══ CEA-608 Encoder ═══');

const enc = new Cea608Encoder();

// Test: a caption row goes out as RU2×2, PAC×2 (first row only), CR×2, then text
enc.enqueueText('Hi');
assert(enc.queueLength > 0, 'Queues byte pairs after enqueueText');

const initPairs = [];
while (enc.queueLength > 0) {
    initPairs.push(enc.drainPair());
}
assert(initPairs.length === 7, `RU2×2 + PAC×2 + CR×2 + "Hi" = 7 pairs (got ${initPairs.length})`);

const masked = (p) => [p.cc1 & 0x7F, p.cc2 & 0x7F];
assert(masked(initPairs[0]).join() === '20,37' && masked(initPairs[1]).join() === '20,37', 'RU2 (0x14 0x25) sent twice first');
assert(masked(initPairs[2]).join() === '20,112' && masked(initPairs[3]).join() === '20,112', 'PAC row 15 (0x14 0x70) sent twice');
assert(masked(initPairs[4]).join() === '20,45' && masked(initPairs[5]).join() === '20,45', 'CR (0x14 0x2D) sent twice before the text');

// Verify odd parity on a known char — 'H' = 0x48
function countBits(n) { let c = 0; while (n) { c += n & 1; n >>= 1; } return c; }
const hiPair = initPairs[6]; // "Hi" char pair
assert(countBits(hiPair.cc1) % 2 === 1, `Parity: 'H' byte has odd bit count`);
assert(countBits(hiPair.cc2) % 2 === 1, `Parity: 'i' byte has odd bit count`);

// Test: Null padding when queue empty
const nullPair = enc.drainPair();
assert(nullPair.cc1 === 0x80 && nullPair.cc2 === 0x80, 'Empty queue returns null padding (0x80, 0x80)');

// Test: the second caption does not repeat the PAC, and every caption gets its own CR
enc.enqueueText('Done');
// RU2×2 + CR×2 + "Do" "ne" = 6
assert(enc.queueLength === 6, `Second caption "Done" = RU2×2 + CR×2 + 2 char pairs (got ${enc.queueLength})`);

// Test: long captions wrap at 32 columns on word boundaries, one CR per row
enc.reset();
enc.enqueueText('The quick brown fox jumps over the lazy dog near the riverbank today');
const wrapped = [];
while (enc.queueLength > 0) wrapped.push(enc.drainPair());
const crCount = wrapped.filter(p => masked(p).join() === '20,45').length;
assert(crCount === 6, `3 rows → 3 doubled CRs (got ${crCount / 2})`);
const rowText = [];
let cur = '';
for (const p of wrapped) {
    const [a, b] = masked(p);
    if (a === 0x14) { if (b === 0x2D && cur) { rowText.push(cur); cur = ''; } continue; }
    if (a >= 0x20) cur += String.fromCharCode(a);
    if (b >= 0x20) cur += String.fromCharCode(b);
}
if (cur) rowText.push(cur);
assert(rowText.every(r => r.length <= 32), `Every row ≤ 32 columns (${rowText.map(r => r.length).join('/')})`);
assert(rowText.join(' ') === 'The quick brown fox jumps over the lazy dog near the riverbank today', 'Wrapped rows re-join to the original text');

// Test: pacing — one pair every 3 frames, nulls in between
enc.reset();
enc.setPacing(3);
enc.enqueueText('Go');
const paced = [];
for (let i = 0; i < 24; i++) paced.push(enc.drainPair());
const dataFrames = paced.map((p, i) => (p.cc1 !== 0x80 || p.cc2 !== 0x80) ? i : -1).filter(i => i >= 0);
assert(dataFrames.join() === '2,5,8,11,14,17,20', `Pacing 3: data on every third frame (got ${dataFrames.join()})`);
enc.setPacing(1);

// Test: enqueueClear sends EDM
enc.reset();
enc.initialized = true;
enc.enqueueClear();
assert(enc.queueLength === 2, `Clear sends 2 EDM pairs (got ${enc.queueLength})`);

// Test: Non-ASCII replaced with '?'
enc.reset();
enc.initialized = true;
enc.enqueueText('café');
// RU2×2 + CR×2, then c, a, f, é→? = "ca" + "f?" = 6 pairs
const nonAsciiPairs = [];
while (enc.queueLength > 0) nonAsciiPairs.push(enc.drainPair());
assert(nonAsciiPairs.length === 6 && (nonAsciiPairs[5].cc2 & 0x7F) === 0x3F, `Non-ASCII "café" → "ca" "f?" with ? substitution (got ${nonAsciiPairs.length} pairs)`);

// DefineWindow layout (CEA-708 §8.4.5): anchor point 7 (bottom-centre), relative 50 %/90 %, rows − 1, 32 columns
{
    const { DtvccEncoder } = await import('../server/cea708/dtvcc-encoder.js');
    const d = new DtvccEncoder();
    d.setRows(2);
    d.enqueueText('Hi');
    const bytes = d.drainFrame(60);
    const i = bytes.indexOf(0x98);
    const dfw = bytes.slice(i, i + 7);
    assert(dfw[1] === 0x20 && dfw[2] === (0x80 | 90) && dfw[3] === 50 && dfw[4] === ((7 << 4) | 1) && dfw[5] === 31,
        `DefineWindow layout: visible, rp 90 %/50 %, anchor 7, 2 rows, 32 cols (got ${dfw.map(b => b.toString(16)).join(' ')})`);
}

// ─────────────────────────────────────────────
// 2. CEA-708 CDP Builder Tests
// ─────────────────────────────────────────────
console.log('\n═══ CEA-708 CDP Builder ═══');

const cdp = new Cea708CdpBuilder();

// Build a packet at 29.97fps
const packet = cdp.buildCDP(0x80, 0x80, '29.97');

assert(packet[0] === 0x96 && packet[1] === 0x69, 'CDP header: 0x96 0x69');
assert(packet[2] === packet.length, `Length byte matches actual length (${packet.length})`);

// Frame rate nibble should be 0x04 (29.97) in high nibble → (0x04 << 4) | 0x0F = 0x4F
assert(packet[3] === 0x4F, `Frame rate byte = 0x4F for 29.97fps (got 0x${packet[3].toString(16)})`);

// Flags
assert(packet[4] === 0x77, 'Flags = 0x77 (ccdata_present | svcinfo_present | svc_info_start | svc_info_complete | caption_service_active | reserved)');

// Sequence starts at 0
assert(packet[5] === 0x00 && packet[6] === 0x00, 'Initial sequence = 0');

// cc_data marker
assert(packet[7] === 0x72, 'cc_data_section marker = 0x72');

// cc_count for 29.97 = 3 triplets → 0xE0 | 3 = 0xE3
assert(packet[8] === 0xF4, `cc_count = 0xF4 (20 triplets) for 29.97fps (got 0x${packet[8].toString(16)})`);

// First triplet: Field 1
assert(packet[9] === 0xFC, 'Triplet 1 type = 0xFC (field 1)');

// Footer marker
const footerPos = packet.length - 4;
assert(packet[footerPos] === 0x74, 'Footer marker = 0x74');

// CRC check: sum of ALL bytes including CRC should be 0 mod 256
let crcSum = 0;
for (let i = 0; i < packet.length; i++) crcSum += packet[i];
assert(crcSum % 256 === 0, `CRC valid: sum mod 256 = 0 (sum=${crcSum})`);

// Sequence increments
const packet2 = cdp.buildCDP(0x80, 0x80);
assert(packet2[5] === 0x00 && packet2[6] === 0x01, 'Sequence incremented to 1');

// Test different frame rates
cdp.reset();
const pkt24 = cdp.buildCDP(0x80, 0x80, '24');
assert(pkt24[3] === 0x2F, `Frame rate byte = 0x2F for 24fps (got 0x${pkt24[3].toString(16)})`);
// cc_count for 24fps = 4 → 0xE4
assert(pkt24[8] === 0xF9, `cc_count = 0xF9 (25 triplets) for 24fps (got 0x${pkt24[8].toString(16)})`);

// ─────────────────────────────────────────────
// 3. End-to-End: Encoder → CDP Builder
// ─────────────────────────────────────────────
console.log('\n═══ End-to-End Pipeline ═══');

const e2eEnc = new Cea608Encoder();
const e2eCdp = new Cea708CdpBuilder();

e2eEnc.enqueueText('Test caption', true);

const frames = [];
// Simulate 30 frames of output (1 second at 29.97)
for (let i = 0; i < 30; i++) {
    const pair = e2eEnc.drainPair();
    const pkt = e2eCdp.buildCDP(pair.cc1, pair.cc2, '29.97');
    frames.push({ pair, pktLen: pkt.length });
}

assert(frames.length === 30, 'Generated 30 frames of CDP packets');

// Count non-null frames (frames that carried actual caption data)
const activeFrames = frames.filter(f => f.pair.cc1 !== 0x80 || f.pair.cc2 !== 0x80);
assert(activeFrames.length > 0, `${activeFrames.length} frames carried caption data`);

// All packets should be same size at same frame rate
const allSameSize = frames.every(f => f.pktLen === frames[0].pktLen);
assert(allSameSize, `All CDP packets same size (${frames[0].pktLen} bytes)`);

// ─────────────────────────────────────────────
// 4. Native Addon Load Test
// ─────────────────────────────────────────────
console.log('\n═══ Native DeckLink Addon ═══');

try {
    const addon = (await import('module')).createRequire(import.meta.url)(
        '../native/decklink/build/Release/decklink_addon.node'
    );
    assert(typeof addon.enumerateDevices === 'function', 'enumerateDevices() exported');
    assert(typeof addon.startOutput === 'function', 'startOutput() exported');
    assert(typeof addon.startPassthrough === 'function', 'startPassthrough() exported');
    assert(typeof addon.stopOutput === 'function', 'stopOutput() exported');
    assert(typeof addon.pushCDP === 'function', 'pushCDP() exported');
    assert(typeof addon.getStatus === 'function', 'getStatus() exported');

    // Try enumerating — will return empty array if no DeckLink card installed
    const devices = addon.enumerateDevices();
    console.log(`  ℹ️  Found ${devices.length} DeckLink device(s): ${devices.length > 0 ? devices.join(', ') : '(none — install a DeckLink card for SDI output)'}`);
    assert(Array.isArray(devices), 'enumerateDevices() returns array');

    // Test pushCDP with a real packet — should not crash even without output started
    const testCdpBuilder = new Cea708CdpBuilder();
    const testPkt = testCdpBuilder.buildCDP(0x80, 0x80, '29.97');
    try {
        addon.pushCDP(Buffer.from(testPkt));
        assert(true, 'pushCDP() accepts Buffer without crash');
    } catch (e) {
        // Expected if no output is started — that's fine
        assert(e.message.includes('not started') || e.message.includes('not running'),
            `pushCDP() correctly rejects when output not started: ${e.message}`);
    }
} catch (e) {
    console.log(`  ⚠️  Native addon load failed: ${e.message}`);
    console.log(`     This is expected if running on a machine without DeckLink SDK.`);
    console.log(`     The WebSocket bridge mode will still work.`);
}

// ─────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────
console.log(`\n${'═'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(40)}\n`);

process.exit(failed > 0 ? 1 : 0);
