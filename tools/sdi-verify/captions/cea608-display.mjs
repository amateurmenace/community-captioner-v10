// cea608-display.mjs <capture.ts|.mp4|.h264> [--sent schedule.json] [--grace 12] [--quiet] [--errors]
//
// What a CEA-608 decoder would SHOW from a capture: decodes every frame's field-1 pairs (all of
// them, in order — the one-frame transport and libcaption/OBS put many in one frame) with the
// decoder model and prints the display on every change. With --sent (a schedule from
// yt-clean-608.mjs or wp-608-test.mjs: {rows, style, captions: [{frame, text, phase?, style?}]})
// it scores the run:
//   captions  complete (its rows were on screen together), partial (only part of it was ever
//             shown), missing (nothing of it was shown), and the delay from the first pair of the
//             caption's transmission to its complete display
//   frames    correct (the display is the caption meant to be up) · typing (rows of that caption
//             or the next one being written) · stale (an earlier caption still up) · garbled (text
//             that was never sent, or rows from different captions) · blank
// The capture is aligned to the schedule through the control codes that start each caption
// (RCL / RUx / RDC): the start event nearest to each caption's expected frame, with a fitted
// line absorbing the drift between the sender's frame counter and the capture.
import { readFileSync } from 'node:fs';
import { extractFrames } from './sei-cc.mjs';
import { Cea608Decoder } from './cea608-model.mjs';
import { wrapRows } from '../../../server/cea708/cea608-encoder.js';

const args = process.argv.slice(2);
const file = args[0];
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const sentFile = opt('--sent', null);
const GRACE = +opt('--grace', 12);
const quiet = args.includes('--quiet');

const frames = extractFrames(file);
const dec = new Cea608Decoder();
const timeline = [];   // {frame, shown}
let last = null, dataFrames = 0;
for (const f of frames) {
    const pairs = f.f1all.filter(p => (p[0] & 0x7F) || (p[1] & 0x7F));
    if (pairs.length) dataFrames++;
    dec.feedFrame(pairs);
    const shown = dec.shown();
    if (shown !== last) { timeline.push({ frame: f.idx, shown }); last = shown; }
}
const count = (k) => dec.events.filter(e => e.kind === k).length;
console.log(`${frames.length} frames, ${dataFrames} with 608 pairs (${dec.pairCount} pairs, ${dec.ctrlCount} control codes, ${count('eoc')} EOC, ${count('cr')} CR, ${count('edm')} EDM, ${count('rcl')} RCL, ${count('rollup')} RUx, ${count('rdc')} RDC)`);
if (!quiet) for (const t of timeline) console.log(`${String(t.frame).padStart(6)}  ${(t.frame / 29.97).toFixed(2).padStart(7)}s  ${JSON.stringify(t.shown.split('\n'))}`);

if (sentFile) {
    const sched = JSON.parse(readFileSync(sentFile, 'utf8'));
    const caps = Array.isArray(sched) ? sched : sched.captions;
    const rowsN = (Array.isArray(sched) ? 2 : sched.rows) || 2;
    const norm = (s) => s.split('\n').map(r => r.replace(/\s+$/, '')).filter(Boolean).join('\n');
    // intended states in order: pop-on/paint-on show the caption's (last `rows`) rows; roll-up the last `rows` rows of the running text
    const states = [];
    let lines = [];
    let phase = null;
    for (const c of caps) {
        if (c.phase !== undefined && c.phase !== phase) { phase = c.phase; lines = []; }
        const style = c.style || sched.style || 'rollup';
        const rows = wrapRows(c.text, 32);
        if (style === 'popon' || style === 'painton') lines = rows.slice(-rowsN);
        else for (const r of rows) { lines.push(r); while (lines.length > rowsN) lines.shift(); }
        states.push({ frame: c.frame, text: c.text, state: norm(lines.join('\n')), phase: c.phase, style });
    }
    const known = new Set(states.map(s => s.state));
    const rowsOf = (st) => st.split('\n').filter(Boolean);
    // --- alignment: caption start events (first RCL / RUx / RDC of a transmission, 3-frame dedupe) ---
    const starts = [];
    for (const e of dec.events) {
        if (e.kind !== 'rcl' && e.kind !== 'rollup' && e.kind !== 'rdc') continue;
        if (starts.length && e.frame - starts[starts.length - 1] <= 3) continue;
        starts.push(e.frame);
    }
    if (starts.length < 2) { console.log('score: too few caption starts found in the capture'); process.exit(0); }
    let a = starts[0] - states[0].frame, b = 1;
    const nearest = (expected, tol) => { let best = null; for (const s of starts) { if (Math.abs(s - expected) <= tol && (best === null || Math.abs(s - expected) < Math.abs(best - expected))) best = s; } return best; };
    let evidence = states.map(s => nearest(s.frame + a, 30));
    for (let pass = 0; pass < 3; pass++) {
        const pts = states.map((s, k) => [s.frame, evidence[k]]).filter(x => x[1] !== null);
        if (pts.length >= 3) {
            const n = pts.length, sx = pts.reduce((t, x) => t + x[0], 0), sy = pts.reduce((t, x) => t + x[1], 0);
            const sxx = pts.reduce((t, x) => t + x[0] * x[0], 0), sxy = pts.reduce((t, x) => t + x[0] * x[1], 0);
            if (n * sxx - sx * sx !== 0) { b = (n * sxy - sx * sy) / (n * sxx - sx * sx); a = (sy - b * sx) / n; }
        }
        evidence = states.map(s => nearest(a + b * s.frame, 30));
    }
    const sendFrames = states.map((s, k) => evidence[k] !== null ? evidence[k] : Math.round(a + b * s.frame));
    // --- when was each caption first shown completely? partially? ---
    const firstShown = [], partial = [];
    let after = 0;
    for (let k = 0; k < states.length; k++) {
        const from = sendFrames[k] - 3;
        const limit = k + 1 < states.length ? sendFrames[k + 1] + 60 : Infinity;
        const t = timeline.find(x => x.shown === states[k].state && x.frame >= Math.max(after, from) && x.frame <= limit);
        firstShown.push(t ? t.frame : null);
        if (t) { after = t.frame; partial.push(false); continue; }
        const rows = rowsOf(states[k].state);
        const p = timeline.find(x => x.frame >= from && x.frame <= limit && x.shown.split('\n').some(r => r.length >= 6 && rows.some(s => s.startsWith(r) || r === s)));
        partial.push(!!p);
    }
    console.log(`  alignment: capture frame = ${a.toFixed(1)} + ${b.toFixed(5)} × sender frame (${((b - 1) * 100).toFixed(2)} % drift); ${evidence.filter(e => e !== null).length}/${states.length} caption starts found among ${starts.length} start events`);
    // --- frame scoring ---
    let ti = 0, cur = '';
    const tally = () => ({ correct: 0, typing: 0, stale: 0, garbled: 0, blank: 0, scored: 0 });
    const total = tally();
    const perPhase = new Map();
    const firstCapture = Math.max(0, sendFrames[0] - 1);
    const lastCapture = Math.min(frames.length - 1, sendFrames[sendFrames.length - 1] + 90);
    let si = -1;
    for (let f = firstCapture; f <= lastCapture; f++) {
        while (ti < timeline.length && timeline[ti].frame <= f) { cur = timeline[ti].shown; ti++; }
        while (si + 1 < states.length && sendFrames[si + 1] <= f) si++;
        if (si < 0) continue;
        // the caption meant to be up: caption si once it has appeared, else the previous one (still loading)
        const shownAt = firstShown[si];
        const idx = (shownAt !== null && f >= shownAt) || (shownAt === null && f >= sendFrames[si] + 45) ? si : si - 1;
        if (idx < 0) continue;
        if (f < sendFrames[si] + GRACE && idx === si - 1 && si > 0 && firstShown[si - 1] !== null && f < firstShown[si - 1] + GRACE) continue;
        const intended = states[idx].state;
        const nextRows = idx + 1 < states.length ? rowsOf(states[idx + 1].state) : [];
        const allowed = [...rowsOf(intended), ...nextRows];
        let st;
        if (cur === intended) st = 'correct';
        else if (!cur) st = 'blank';
        else if (cur.split('\n').every(r => allowed.some(s => s.startsWith(r)))) st = 'typing';
        else if (known.has(cur)) st = 'stale';
        else st = 'garbled';
        total[st]++; total.scored++;
        const ph = caps[si].phase;
        if (ph !== undefined) { const c = perPhase.get(ph) || { ...tally(), complete: 0, partial: 0, missing: 0, n: 0, delays: [] }; c[st]++; c.scored++; perPhase.set(ph, c); }
        if (st === 'garbled' && args.includes('--errors')) console.log(`    ${String(f).padStart(6)} garbled  shown ${JSON.stringify(cur.split('\n'))} wanted ${JSON.stringify(intended.split('\n'))}`);
    }
    let complete = 0, part = 0, missing = 0;
    const delays = [];
    states.forEach((s, k) => {
        const c = perPhase.get(s.phase);
        if (c) c.n++;
        if (firstShown[k] !== null) { complete++; const d = firstShown[k] - sendFrames[k]; delays.push(d); if (c) { c.complete++; c.delays.push(d); } }
        else if (partial[k]) { part++; if (c) c.partial++; }
        else { missing++; if (c) c.missing++; }
    });
    const fin = delays.slice().sort((x, y) => x - y);
    const q = (p) => fin.length ? fin[Math.min(fin.length - 1, Math.floor(p * fin.length))] : NaN;
    const pct = (n, d) => (100 * n / Math.max(1, d)).toFixed(1).padStart(5);
    console.log(`\nscore vs ${caps.length} sent captions (${rowsN} rows, grace ${GRACE} frames):`);
    console.log(`  captions: complete ${complete}/${states.length}, partial ${part}, missing ${missing}; delay from first pair to complete display (frames) p50 ${q(0.5)}  p95 ${q(0.95)}  max ${fin[fin.length - 1]}`);
    console.log(`  frames scored ${total.scored}: correct ${pct(total.correct, total.scored)} %  typing ${pct(total.typing, total.scored)} %  stale ${pct(total.stale, total.scored)} %  garbled ${pct(total.garbled, total.scored)} %  blank ${pct(total.blank, total.scored)} %`);
    if (perPhase.size) {
        console.log('  per phase: complete/partial/missing of n · correct · typing · stale · garbled · blank % · median delay (frames)');
        for (const [ph, c] of perPhase) {
            const ds = c.delays.slice().sort((x, y) => x - y);
            console.log(`    ${String(ph).padEnd(8)} ${String(c.complete).padStart(2)}/${c.partial}/${c.missing} of ${String(c.n).padStart(2)}   ${pct(c.correct, c.scored)} ${pct(c.typing, c.scored)} ${pct(c.stale, c.scored)} ${pct(c.garbled, c.scored)} ${pct(c.blank, c.scored)}   ${ds.length ? ds[ds.length >> 1] : '-'}`);
        }
    }
    const miss = states.map((s, k) => firstShown[k] === null ? s.text : null).filter(Boolean);
    if (miss.length) console.log('  never displayed completely: ' + miss.slice(0, 12).map(t => JSON.stringify(t.slice(0, 40))).join(', ') + (miss.length > 12 ? ` … (${miss.length})` : ''));
}
