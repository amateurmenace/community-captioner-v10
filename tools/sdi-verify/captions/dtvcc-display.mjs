// dtvcc-display.mjs <capture.ts|.mp4|.h264> [--sent schedule.json] [--grace 12] [--quiet]
//
// What a CEA-708 decoder would SHOW from a capture: decodes the service-1 packets of every
// frame with the decoder model and prints the display on every change. With --sent (the
// schedule written by wp-redraw-test.mjs or yt-clean-708.mjs: {columns, rows, captions:
// [{frame, text}]}) it scores the run with the same metric as the simulation:
//   correct  the display equals the rows the sender meant to show
//   stale    an earlier complete state is still shown
//   mixed    every row is a real row, but from different captions (one stale row)
//   garbled  a row that was never sent (text on the wrong row / cut mid-row)
//   blank    nothing shown while something was meant to be
// and the delay of each caption (first frame its complete state is displayed) relative to
// the first caption, which is assumed to have arrived on time.
import { readFileSync } from 'node:fs';
import { extractFrames } from './sei-cc.mjs';
import { DtvccDecoder } from './dtvcc-model.mjs';
import { wrapRows } from '../../../server/cea708/cea608-encoder.js';

const args = process.argv.slice(2);
const file = args[0];
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const sentFile = opt('--sent', null);
const GRACE = +opt('--grace', 12);
const quiet = args.includes('--quiet');

const frames = extractFrames(file);
const dec = new DtvccDecoder();
const norm = (rows) => { const r = rows.map(x => x.replace(/\s+$/, '')); while (r.length && !r[r.length - 1]) r.pop(); return r.join('\n'); };
const timeline = [];   // {frame, shown}
let last = null, packets = 0;
for (const f of frames) {
    const pkt = f.dtvcc.length ? f.dtvcc : null;
    if (pkt) packets++;
    dec.feedFrame(pkt);
    const shown = norm(dec.display());
    if (shown !== last) { timeline.push({ frame: f.idx, shown }); last = shown; }
}
const defines = dec.events.filter(e => e.kind === 'define' || e.kind === 'redefine').length;
console.log(`${frames.length} frames, ${packets} with DTVCC packets, ${defines} DefineWindow, ${dec.etxCount} ETX, ${dec.badPackets} short blocks; window anchor ${JSON.stringify(dec.anchorOf(0))}`);
if (!quiet) for (const t of timeline) console.log(`${String(t.frame).padStart(6)}  ${(t.frame / 29.97).toFixed(2).padStart(7)}s  ${JSON.stringify(t.shown.split('\n'))}`);

if (sentFile) {
    const sched = JSON.parse(readFileSync(sentFile, 'utf8'));
    const caps = Array.isArray(sched) ? sched : sched.captions;
    const columns = (Array.isArray(sched) ? 27 : sched.columns) || 27;
    const rows = (Array.isArray(sched) ? 2 : sched.rows) || 2;
    // intended states, in order
    const states = [];
    let lines = [];
    let phase = null;
    for (const c of caps) {
        if (c.phase !== undefined && c.phase !== phase) { phase = c.phase; lines = []; }   // a fresh encoder per phase
        for (const r of wrapRows(c.text, c.columns || columns)) { lines.push(r); while (lines.length > rows) lines.shift(); }
        states.push({ frame: c.frame, text: c.text, state: norm(lines) });
    }
    const known = new Set(states.map(s => s.state));
    const knownRows = new Set(['']); for (const s of states) for (const r of s.state.split('\n')) knownRows.add(r);
    // Map sender frames (the app's frame counter at each POST) to capture frames. The two
    // clocks drift a little, so: (1) the first frame on which a row that is new in caption k
    // appears is evidence of its send frame (row 0 goes out one frame after DefineWindow);
    // (2) fit capture = a + b * sender over that evidence, dropping outliers (captions whose
    // first copy was lost show up late); (3) look for each caption's complete state from the
    // fitted frame on, in order.
    const rowsOf = (st) => new Set(st.split('\n').filter(Boolean));
    const evidence = [];
    let cursor = 0;
    for (let k = 0; k < states.length; k++) {
        const prev = k ? rowsOf(states[k - 1].state) : new Set();
        // only rows that start with the caption's first word (its tag) are unique enough to be evidence
        const tag = states[k].text.split(/\s+/)[0] + ' ';
        const fresh = [...rowsOf(states[k].state)].filter(r => !prev.has(r) && r.startsWith(tag));
        let ev = null;
        for (let i = cursor; i < timeline.length; i++) {
            const rows = timeline[i].shown.split('\n');
            if (fresh.some(r => rows.includes(r))) { ev = timeline[i].frame - 1; cursor = i; break; }
        }
        evidence.push(fresh.length ? ev : null);
    }
    let pts = states.map((s, k) => [s.frame, evidence[k]]).filter(x => x[1] !== null);
    if (pts.length < 2) { console.log('score: too few captions found in the capture'); process.exit(0); }
    let a = pts[0][1] - pts[0][0], b = 1;
    for (let pass = 0; pass < 3; pass++) {
        const n = pts.length, sx = pts.reduce((t, x) => t + x[0], 0), sy = pts.reduce((t, x) => t + x[1], 0);
        const sxx = pts.reduce((t, x) => t + x[0] * x[0], 0), sxy = pts.reduce((t, x) => t + x[0] * x[1], 0);
        if (n >= 3 && n * sxx - sx * sx !== 0) { b = (n * sxy - sx * sy) / (n * sxx - sx * sx); a = (sy - b * sx) / n; }
        const res = pts.map(x => x[1] - (a + b * x[0])).sort((p, q) => p - q);
        const med = res[res.length >> 1];
        a += med;                                                     // median offset: late evidence does not pull it
        pts = pts.filter(x => Math.abs(x[1] - (a + b * x[0])) <= 12);  // drop captions whose evidence came late (lost first copy)
        if (pts.length < 3) break;
    }
    const sendFrames = states.map(s => Math.round(a + b * s.frame));
    const offset = Math.round(a);
    const firstShown = [];
    let after = 0;
    for (let k = 0; k < states.length; k++) {
        const limit = k + 1 < states.length ? sendFrames[k + 1] + 150 : Infinity;
        const t = timeline.find(x => x.shown === states[k].state && x.frame >= Math.max(after, sendFrames[k] - 3) && x.frame <= limit);
        firstShown.push(t ? t.frame : null);
        if (t) after = t.frame;
        else if (evidence[k] !== null) after = Math.max(after, evidence[k]);
    }
    console.log(`  clock fit: capture frame = ${a.toFixed(1)} + ${b.toFixed(5)} × sender frame (${((b - 1) * 100).toFixed(2)} % drift; ${evidence.filter(e => e !== null).length} captions with a tag row seen, ${pts.length} used)`);
    let correct = 0, stale = 0, mixed = 0, garbled = 0, blank = 0, scored = 0, episodes = 0, lastState = 'correct';
    const perPhase = new Map();   // phase → counters
    const bump = (ph, st) => { if (ph === undefined) return; const c = perPhase.get(ph) || { correct: 0, stale: 0, mixed: 0, garbled: 0, blank: 0, scored: 0 }; c[st]++; c.scored++; perPhase.set(ph, c); };
    let ti = 0, cur = '';
    const firstCapture = Math.max(0, sendFrames[0] - 1);
    const lastCapture = Math.min(frames.length - 1, sendFrames[sendFrames.length - 1] + 90);
    let si = -1;
    for (let f = firstCapture; f <= lastCapture; f++) {
        while (ti < timeline.length && timeline[ti].frame <= f) { cur = timeline[ti].shown; ti++; }
        while (si + 1 < states.length && sendFrames[si + 1] <= f) si++;
        if (si < 0) continue;
        if (f - sendFrames[si] < GRACE) continue;
        if (si + 1 < states.length && f >= sendFrames[si + 1] - 3) continue;   // the next caption's clear/redraw is under way
        scored++;
        const intended = states[si].state;
        let st;
        if (cur === intended) st = 'correct';
        else if (!cur && intended) st = 'blank';
        else if (known.has(cur)) st = 'stale';
        else if (cur.split('\n').every(r => knownRows.has(r))) st = 'mixed';
        else st = 'garbled';
        if (st === 'correct') correct++; else if (st === 'stale') stale++; else if (st === 'mixed') mixed++; else if (st === 'blank') blank++; else garbled++;
        if (st === 'garbled' && lastState !== 'garbled') episodes++;
        lastState = st;
        bump(caps[si].phase, st);
        if (st !== 'correct' && args.includes('--errors')) console.log(`    ${String(f).padStart(6)} ${st.padEnd(7)} shown ${JSON.stringify(cur.split('\n'))} wanted ${JSON.stringify(intended.split('\n'))}`);
    }
    const delays = states.map((s, k) => firstShown[k] === null ? null : firstShown[k] - sendFrames[k]);
    const fin = delays.filter(d => d !== null).sort((a, b) => a - b);
    const q = (p) => fin.length ? fin[Math.min(fin.length - 1, Math.floor(p * fin.length))] : NaN;
    const pct = (n) => (100 * n / Math.max(1, scored)).toFixed(1).padStart(5);
    console.log(`\nscore vs ${caps.length} sent captions (${columns}-column rows, ${rows} rows, grace ${GRACE} frames, offset ${offset}):`);
    console.log(`  frames scored ${scored}: correct ${pct(correct)} %  stale ${pct(stale)} %  mixed ${pct(mixed)} %  garbled ${pct(garbled)} % (${episodes} episodes)  blank ${pct(blank)} %`);
    console.log(`  captions shown completely: ${fin.length}/${states.length}; delay after send (frames) p50 ${q(0.5)}  p95 ${q(0.95)}  max ${fin[fin.length - 1]}`);
    if (perPhase.size) {
        console.log('  per phase (correct / stale / mixed / garbled / blank %):');
        for (const [ph, c] of perPhase) console.log(`    ${String(ph).padEnd(10)} ${(100 * c.correct / c.scored).toFixed(1).padStart(5)} ${(100 * c.stale / c.scored).toFixed(1).padStart(5)} ${(100 * c.mixed / c.scored).toFixed(1).padStart(5)} ${(100 * c.garbled / c.scored).toFixed(1).padStart(5)} ${(100 * c.blank / c.scored).toFixed(1).padStart(5)}   (${c.scored} frames)`);
    }
    const missing = states.map((s, k) => firstShown[k] === null ? s.text : null).filter(Boolean);
    if (missing.length) console.log('  never displayed completely: ' + missing.map(t => JSON.stringify(t.slice(0, 40))).join(', '));
}
