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

// ─────────────────────────────────────────────
// CEA-708 DTVCC encoder
// ─────────────────────────────────────────────
console.log('\n═══ CEA-708 DTVCC Encoder ═══');
{
    const { DtvccEncoder } = await import('../server/cea708/dtvcc-encoder.js');
    const { DtvccDecoder, dtvccFromCdp } = await import('../tools/sdi-verify/captions/dtvcc-model.mjs');
    const CAP = new Cea708CdpBuilder().dtvccCapacity('29.97');
    assert(CAP === 35, `DTVCC capacity at 29.97 is 35 service bytes (got ${CAP})`);

    // DefineWindow layout (CEA-708 §8.4.5): anchor point 7 (bottom-centre), relative 50 %/90 %, rows − 1, columns − 1
    const d = new DtvccEncoder();
    d.setRows(2);
    d.setRepaint(30); d.setRedraw({ repeat: 2, repeatGap: 3 });   // the 1 s keep-alive layout; the default is continuous
    d.setFrameCapacity(CAP);
    d.enqueueText('Hi');
    const first = d.drainFrame(CAP);
    const i = first.indexOf(0x98);
    const dfw = first.slice(i, i + 7);
    assert(i === 1 && dfw[1] === 0x20 && dfw[2] === (0x80 | 90) && dfw[3] === 50 && dfw[4] === ((7 << 4) | 1) && dfw[5] === d.columns - 1,
        `DefineWindow packet first: visible, rp 90 %/50 %, anchor 7, 2 rows, ${d.columns} cols (got ${dfw.map(b => b.toString(16)).join(' ')})`);
    assert(d.columns === 27 && d.chunkChars === 27, `Redraw rows are 27 columns at 29.97 (one 31-byte service block: SPL + 27 chars + ETX) (got ${d.columns}/${d.chunkChars})`);

    // Every following packet is self-contained: one service block, SPL(row, 0) … ETX, ≤ capacity
    const pk = [];
    for (let f = 0; f < 12; f++) pk.push(d.drainFrame(CAP));
    const rowPk = pk.filter(Boolean);
    assert(rowPk.length === 4, `2 rows × 2 copies = 4 row packets (got ${rowPk.length})`);
    assert(rowPk.every(p => p.length <= CAP && p[0] === 0x3F && p[1] === 0x92 && p[3] === 0 && p[p.length - 1] === 0x03),
        'Each row packet = one 31-byte service block starting with SetPenLocation(row, 0) and ending with ETX');
    assert(rowPk[0][2] === 0 && rowPk[1][2] === 1 && rowPk[2][2] === 0 && rowPk[3][2] === 1, 'Row packets address rows 0,1 then 0,1 again');
    const gapIdx = pk.map((p, k) => (p ? '' : k)).filter(k => k !== '');
    assert(gapIdx.slice(0, 3).join() === '2,3,4' && pk[5] && pk[6] && !pk[7], `Second copy follows 3 idle frames (idle at ${gapIdx.join()})`);
    assert(rowPk[0].length === 32 && String.fromCharCode(...rowPk[0].slice(4, 31)) === 'Hi'.padEnd(27), 'Row text padded to 27 columns overwrites stale characters');

    // Decoder round trip with the first copy of every row lost: the second copy restores the display
    const e2 = new DtvccEncoder(); e2.setRows(2); e2.setRepaint(30); e2.setRedraw({ repeat: 2, repeatGap: 3 });
    const b2 = new Cea708CdpBuilder(); const dec = new DtvccDecoder();
    e2.enqueueText('The quick brown fox jumps over the lazy dog near the river.');
    const shown = [];
    for (let f = 0; f < 10; f++) {
        const data = e2.drainFrame(CAP);
        const pkt = dtvccFromCdp(b2.buildCDP_DTVCC(data, '29.97', 0x80, 0x80, false));
        dec.feedFrame(f === 1 || f === 2 ? null : pkt);   // drop the first copy of both rows
        shown.push(dec.display().join('|'));
    }
    assert(shown[2] === '|' && shown[7] === 'over the lazy dog near the|river.', `Lost first copy → window blank, second copy repairs it (got "${shown[2]}" then "${shown[7]}")`);
    const knownRows = new Set(['', 'The quick brown fox jumps', 'over the lazy dog near the', 'river.']);
    assert(shown.every(s => s.split('|').every(r => knownRows.has(r))), `No frame ever shows text on the wrong row (${shown.filter(s => !s.split('|').every(r => knownRows.has(r))).join(' / ')})`);

    // Keep-alive: with nothing new, the rows are re-sent every repaint interval
    const e3 = new DtvccEncoder(); e3.setRows(2); e3.setRepaint(15); e3.setRedraw({ repeat: 1 });
    e3.enqueueText('Keep alive');
    let active = [];
    for (let f = 0; f < 50; f++) if (e3.drainFrame(CAP)) active.push(f);
    assert(active.join() === '0,1,2,17,18,33,34,49', `Keep-alive re-sends both rows 15 frames after the last packet (active frames ${active.join()})`);

    // DefineWindow accompanies every new caption, never a keep-alive
    const e4 = new DtvccEncoder(); e4.setRows(2); e4.setRepaint(15); e4.setRedraw({ repeat: 1 });
    e4.enqueueText('One'); const dfwCount = (n) => { let c = 0; for (let f = 0; f < n; f++) { const p = e4.drainFrame(CAP); if (p && p[1] === 0x98) c++; } return c; };
    assert(dfwCount(40) === 1, 'One DefineWindow for the first caption, none in the keep-alives');
    e4.enqueueText('Two');
    assert(dfwCount(40) === 1, 'The next caption carries its own DefineWindow');

    // Clear: blank rows are sent and kept alive for three cycles, then the encoder goes idle
    e4.enqueueClear();
    let blankFrames = 0, idleAfter = 0;
    for (let f = 0; f < 120; f++) { const p = e4.drainFrame(CAP); if (p) blankFrames++; }
    for (let f = 0; f < 60; f++) { if (e4.drainFrame(CAP)) idleAfter++; }
    assert(blankFrames === 8 && idleAfter === 0, `Clear = 2 blank rows now + 3 keep-alives (${blankFrames} packets), then idle (${idleAfter})`);

    // Continuous mode (repaint 1): rows alternate on every frame, no duplicate copies
    const e7 = new DtvccEncoder(); e7.setRows(2); e7.setRepaint(1); e7.setRedraw({ repeat: 2, repeatGap: 3 });
    e7.enqueueText('Continuous rows');
    const seq7 = []; for (let f = 0; f < 9; f++) { const p = e7.drainFrame(CAP); seq7.push(p ? (p[1] === 0x98 ? 'D' : String(p[2])) : '-'); }
    assert(seq7.join('') === 'D01010101', `Continuous: DefineWindow then row 0, row 1, row 0, row 1 … every frame (got ${seq7.join('')})`);

    // Burst mode (keepAlive false): DefineWindow + the rows `repeat` times, then silence
    const e8 = new DtvccEncoder(); e8.setRows(2); e8.setRepaint(30); e8.setRedraw({ repeat: 5, repeatGap: 4, keepAlive: false, rowErase: 'hcr' });
    e8.enqueueText('Burst mode rows');
    const seq8 = []; for (let f = 0; f < 120; f++) { const p = e8.drainFrame(CAP); seq8.push(p ? (p[1] === 0x98 ? 'D' : String(p[2])) : '-'); }
    assert(seq8.join('').replace(/-+$/, '') === 'D01----01----01----01----01' && !seq8.slice(27).some(x => x !== '-'), `Burst: DFW, 5 copies 4 frames apart, then nothing for the rest of the window (got ${seq8.join('').slice(0, 40)})`);
    const b8 = new Cea708CdpBuilder(); const dec8 = new DtvccDecoder(); const e8b = new DtvccEncoder(); e8b.setRows(2); e8b.setRepaint(30); e8b.setRedraw({ repeat: 5, repeatGap: 4, keepAlive: false, rowErase: 'hcr' });
    e8b.enqueueText('Burst mode rows');
    for (let f = 0; f < 30; f++) { const d = e8b.drainFrame(CAP); dec8.feedFrame(f >= 1 && f <= 15 ? null : dtvccFromCdp(b8.buildCDP_DTVCC(d, '29.97', 0x80, 0x80, false))); }
    assert(dec8.display().join('|') === 'Burst mode rows|', `Burst with the first three copies lost still displays the caption (got "${dec8.display().join('|')}")`);
    assert(dec8.events.some(e => e.kind === 'hcr'), 'HCR row erase used instead of space padding');

    // Pop-on style: hidden window per caption, rows name their window, DisplayWindow/HideWindow swap
    const e9 = new DtvccEncoder(); e9.setRows(2); e9.setRepaint(30); e9.setRedraw({ style: 'popon', repeat: 2, repeatGap: 4, keepAlive: false, rowErase: 'hcr' });
    const b9 = new Cea708CdpBuilder(); const dec9 = new DtvccDecoder();
    const feed9 = (n, drop = () => false) => { for (let f = 0; f < n; f++) { const d = e9.drainFrame(CAP); dec9.feedFrame(drop(f) ? null : dtvccFromCdp(b9.buildCDP_DTVCC(d, '29.97', 0x80, 0x80, false))); } };
    assert(e9.columns === 26, `Pop-on rows are 26 columns (SetCurrentWindow byte) (got ${e9.columns})`);
    e9.enqueueText('First pop-on caption');
    const p9 = e9.drainFrame(CAP);
    assert(p9[1] === 0x98 && p9[2] === 0x00, `First caption defines window 0 hidden (got ${p9.slice(1, 3).map(b => b.toString(16)).join(' ')})`);
    dec9.feedFrame(dtvccFromCdp(b9.buildCDP_DTVCC(p9, '29.97', 0x80, 0x80, false)));
    // layout for 2 copies: DFW, idle, DFW, rows ×2 (4 packets), show, gap 4, show
    feed9(2 + 4);
    assert(dec9.display().join('|') === '', 'Rows written while the window is still hidden show nothing');
    feed9(1);
    assert(dec9.display().join('|') === 'First pop-on caption|' && dec9.windows[0].visible && !dec9.windows[1].visible, `First show packet displays window 0 (got "${dec9.display().join('|')}")`);
    feed9(12);
    e9.enqueueText('Second pop-on caption');
    feed9(8, (f) => f === 7);   // the first show packet of the second caption is lost
    assert(dec9.display().join('|') === 'First pop-on caption|', 'Lost show packet: the first caption stays on screen');
    feed9(6);
    assert(dec9.display().join('|') === 'Second pop-on caption|' && dec9.windows[1].visible && !dec9.windows[0].visible, `Second show swaps to window 1 (got "${dec9.display().join('|')}")`);
    e9.enqueueClear(); feed9(3);
    assert(dec9.display().join('|') === '', 'Clear hides both windows');

    // YouTube style: every copy = HideWindow + DefineWindow, rows, first row again; no keep-alive
    const e10 = new DtvccEncoder(); e10.setRows(2); e10.setRepaint(30); e10.setRedraw({ style: 'youtube', repeat: 2, repeatGap: 4, keepAlive: false, rowErase: 'hcr' });
    e10.enqueueText('YouTube style rows');
    const seq10 = []; for (let f = 0; f < 60; f++) { const p = e10.drainFrame(CAP); seq10.push(p ? (p[1] === 0x8A && p[3] === 0x98 ? 'H' : String(p[2])) : '-'); }
    assert(seq10.join('').replace(/-+$/, '') === 'H010----H010', `YouTube style: hide+define, row 0, row 1, row 0 again, twice (got ${seq10.join('').slice(0, 20)})`);

    // cc_count 31: a 115-byte CDP with 29 DTVCC triplets (56 service bytes per frame), valid checksum
    const b31 = new Cea708CdpBuilder();
    assert(b31.dtvccCapacity('29.97', 31) === 57, `capacity with cc_count 31 = 57 service bytes (got ${b31.dtvccCapacity('29.97', 31)})`);
    const cdp31 = b31.buildCDP_DTVCC([0x3F, 0x92, 0, 0, 0x41, 0x03], '29.97', 0x80, 0x80, false, 31);
    let sum31 = 0; for (const x of cdp31) sum31 += x;
    assert(cdp31.length === 115 && cdp31[2] === 115 && cdp31[8] === 0xFF && sum31 % 256 === 0, `cc_count 31 CDP: 115 bytes, cc_count byte 0xFF, checksum ok (got ${cdp31.length}/${cdp31[8].toString(16)}/${sum31 % 256})`);

    // Atomic style: the whole caption in one packet; 18 characters at the standard 20 triplets, 40 at cc_count 31
    const e11 = new DtvccEncoder(); e11.setRows(2); e11.setRepaint(30); e11.setRedraw({ style: 'atomic', repeat: 3, repeatGap: 20, keepAlive: false });
    e11.setFrameCapacity(34);
    assert(e11.atomicChars === 18 && e11.columns === 18, `atomic at 34 bytes: 18 characters (got ${e11.atomicChars})`);
    e11.setFrameCapacity(35);
    assert(e11.atomicChars === 19, `atomic at 35 bytes: 19 characters (got ${e11.atomicChars})`);
    e11.setRedraw({ atomicDelete: true });
    assert(e11.atomicChars === 23, `atomic with DeleteWindow + DefineWindow at 35 bytes: 23 characters (got ${e11.atomicChars})`);
    e11.enqueueText('Twenty-three chars here');
    const pd = e11.drainFrame(35);
    assert(pd.length <= 35 && pd[1] === 0x8C && pd[2] === 0x01 && pd[3] === 0x98, `delete-and-define packet fits a frame and starts with DeleteWindow 0 + DefineWindow 0 (got ${pd.length} bytes)`);
    e11.setRedraw({ atomicDelete: false });
    e11.setFrameCapacity(56);
    assert(e11.atomicChars === 40 && e11.columns === 40, `atomic at 56 bytes: 40 characters (got ${e11.atomicChars})`);
    e11.enqueueText('Atomic caption of forty characters here!');
    const pk11 = []; for (let f = 0; f < 60; f++) { const p = e11.drainFrame(56); pk11.push(p ? p.length : 0); }
    const sentAt = pk11.map((n, i) => n ? i : -1).filter(i => i >= 0);
    assert(sentAt.join() === '0,21,42' && pk11[0] <= 56, `three identical copies 20 idle frames apart, each within the frame (sent at ${sentAt.join()}, ${pk11[0]} bytes)`);
    const dec11 = new DtvccDecoder(); const b11 = new Cea708CdpBuilder();
    const e11b = new DtvccEncoder(); e11b.setRows(2); e11b.setRepaint(30); e11b.setRedraw({ style: 'atomic', repeat: 3, repeatGap: 20, keepAlive: false }); e11b.setFrameCapacity(56);
    e11b.enqueueText('Atomic caption of forty characters here!');
    for (let f = 0; f < 60; f++) { const d = e11b.drainFrame(56); dec11.feedFrame(f < 42 ? null : dtvccFromCdp(b11.buildCDP_DTVCC(d, '29.97', 0x80, 0x80, false, 31))); }
    assert(dec11.display().join('|') === 'Atomic caption of forty characters here!' && dec11.windows[0].rowCount === 1, `two lost copies, the third shows the whole caption in a one-row window (got "${dec11.display().join('|')}")`);
    e11b.enqueueText('A longer caption that does not fit in forty characters at all');
    const parts = []; for (let f = 0; f < 200; f++) { const d = e11b.drainFrame(56); if (d) { dec11.feedFrame(dtvccFromCdp(b11.buildCDP_DTVCC(d, '29.97', 0x80, 0x80, false, 31))); parts.push(dec11.display()[0]); } }
    assert([...new Set(parts)].join('|') === 'A longer caption that does not fit in|forty characters at all', `a long caption goes out as consecutive one-row captions (got ${JSON.stringify([...new Set(parts)])})`);

    // Atomic queue: a second caption arriving mid-way appends its parts after the first caption's parts
    const e13 = new DtvccEncoder(); e13.setRows(2); e13.setRepaint(30); e13.setRedraw({ style: 'atomic', atomicDelete: true, repeat: 2, repeatGap: 5, keepAlive: false, atomicHoldFrames: 20 });
    e13.setFrameCapacity(35);
    const dec13 = new DtvccDecoder(); const b13 = new Cea708CdpBuilder();
    e13.enqueueText('First caption part one, first caption part two');   // 2 parts of ≤ 23
    for (let f = 0; f < 3; f++) { const d = e13.drainFrame(35); if (d) dec13.feedFrame(dtvccFromCdp(b13.buildCDP_DTVCC(d, '29.97', 0x80, 0x80, false))); }
    e13.enqueueText('Second caption arrives');
    const shown13 = [];
    for (let f = 0; f < 120; f++) { const d = e13.drainFrame(35); if (d) { dec13.feedFrame(dtvccFromCdp(b13.buildCDP_DTVCC(d, '29.97', 0x80, 0x80, false))); shown13.push(dec13.display()[0]); } }
    assert([...new Set(shown13)].join('|') === 'First caption part one,|first caption part two|Second caption arrives', `parts are shown in order, nothing cut off (got ${JSON.stringify([...new Set(shown13)])})`);

    // Two-window atomic: rows A and B in windows 0 and 1, each packet self-contained; a lone row hides window 0
    const e12 = new DtvccEncoder(); e12.setRows(2); e12.setRepaint(30); e12.setRedraw({ style: 'atomic', atomicDelete: true, atomicWindows: 2, repeat: 2, repeatGap: 10, keepAlive: false });
    e12.setFrameCapacity(35);
    const dec12 = new DtvccDecoder(); const b12 = new Cea708CdpBuilder();
    e12.enqueueText('Two window atomic test with two rows');   // 36 chars → 23 + 13
    const seen12 = [];
    for (let f = 0; f < 40; f++) { const d = e12.drainFrame(35); if (d) { dec12.feedFrame(dtvccFromCdp(b12.buildCDP_DTVCC(d, '29.97', 0x80, 0x80, false))); seen12.push(f); } }
    assert(seen12.join() === '0,1,12,13', `two packets per copy, copies 10 frames apart (sent at ${seen12.join()})`);
    assert(dec12.display().join('|') === 'Two window atomic test|with two rows' && dec12.windows[0].anchor.v === 85 && dec12.windows[1].anchor.v === 90, `both rows shown, window 0 at 85 %, window 1 at 90 % (got "${dec12.display().join('|')}")`);
    e12.enqueueText('Short one');
    for (let f = 0; f < 30; f++) { const d = e12.drainFrame(35); if (d) dec12.feedFrame(dtvccFromCdp(b12.buildCDP_DTVCC(d, '29.97', 0x80, 0x80, false))); }
    assert(dec12.display().join('|') === 'Short one' && !dec12.windows[0].defined, `a one-row caption deletes window 0 and shows in window 1 (got "${dec12.display().join('|')}")`);

    // Classic roll-up (repaint 0): CW0, text, ETX as a byte stream; CR BEFORE every later row
    const e5 = new DtvccEncoder(); e5.setRows(2); e5.setRepaint(0);
    e5.enqueueText('Hi');
    const c = e5.drainFrame(CAP);
    assert(c[0] === (0x20 | 11) && c[1] === 0x98 && c[8] === 0x80 && c[9] === 0x48 && c[10] === 0x69 && c[11] === 0x03,
        `Classic mode: DFW + CW0 + "Hi" + ETX in one block, no CR after the first row (got ${c.map(b => b.toString(16)).join(' ')})`);
    e5.enqueueText('Second row.');
    const c2 = e5.drainFrame(CAP);
    assert(c2[1] === 0x80 && c2[2] === 0x0D && c2[3] === 0x53, 'Classic mode: the next caption starts with CR, then its text');
    const dec5 = new DtvccDecoder(); const b5 = new Cea708CdpBuilder();
    const e5b = new DtvccEncoder(); e5b.setRows(2); e5b.setRepaint(0);
    for (const t of ['One', 'Two', 'Three']) { e5b.enqueueText(t); for (let f = 0; f < 3; f++) dec5.feedFrame(dtvccFromCdp(b5.buildCDP_DTVCC(e5b.drainFrame(CAP), '29.97', 0x80, 0x80, false))); }
    assert(dec5.display().join('|') === 'Two|Three', `Classic roll-up shows the last two captions on both rows (got "${dec5.display().join('|')}")`);
    assert(e5.columns === 32, 'Classic mode keeps 32-column rows');

    // Low per-frame capacity (59.94: 14 service bytes): 32-column rows go out in self-positioned chunks
    const e6 = new DtvccEncoder(); e6.setRows(2); e6.setRepaint(30); e6.setRedraw({ repeat: 1 });
    e6.setFrameCapacity(14);
    assert(e6.columns === 32 && e6.chunkChars === 9, `59.94: 32 columns in 9-character chunks (got ${e6.columns}/${e6.chunkChars})`);
    e6.enqueueText('abcdefghijklmnopqrstuvwxyz012345');
    const pk6 = []; for (let f = 0; f < 12; f++) { const p = e6.drainFrame(14); if (p) pk6.push(p); }
    assert(pk6.length === 1 + 8 && pk6.slice(1).every(p => p.length <= 14 && p[1] === 0x92), `DFW + 4 chunks per row × 2 rows, each ≤ 14 bytes with its own SetPenLocation (got ${pk6.length})`);
    assert(pk6[2][3] === 9 && String.fromCharCode(...pk6[2].slice(4, 13)) === 'jklmnopqr', 'Second chunk starts at column 9 with the next 9 characters');
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
