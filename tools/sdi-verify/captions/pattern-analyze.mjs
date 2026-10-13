// pattern-analyze.mjs <cc.csv> [fromFrame] — survival map for the wp-pattern.mjs test.
// 608: pairs A0..Z9 (24 letters × 10) were sent in rows of 16, each row preceded by
//      RU2 RU2 CR CR → sent-offset of pair k within its row = 4 + (k % 16), row = floor(k/16).
// 708: packets "Pnn ..." sent on consecutive frames.
import { readFileSync } from 'node:fs';
const rows = readFileSync(process.argv[2], 'utf8').split('\n').slice(1).filter(Boolean).map(l => {
    const [frame, type, cc, f1hex, f1text, dtvcc] = l.split(',');
    return { frame: +frame, type, f1hex, text: f1text ? JSON.parse(f1text) : '', dtvcc };
});
const from = +(process.argv[3] || 0);
const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const idx = (p) => { const L = letters.indexOf(p[0]); const d = +p[1]; return (L >= 0 && /\d/.test(p[1])) ? L * 10 + d : -1; };

// ---- 608 ----
const got = new Map();   // pair index → received frame
let ctrlFrames = [];
for (const r of rows) {
    if (r.frame < from) continue;
    const k = idx(r.text);
    if (k >= 0 && !got.has(k)) got.set(k, r.frame);
    if (r.text.startsWith('<14')) ctrlFrames.push(r.frame);
}
if (got.size) {
    // Estimate the sent frame of pair 0 from the earliest received pair (WP does not delay)
    const first = [...got.entries()].sort((a, b) => a[1] - b[1])[0];
    const base = first[1] - (4 + (first[0] % 16) + Math.floor(first[0] / 16) * 20);
    const total = 240;
    let map = '';
    let okCount = 0;
    for (let k = 0; k < total; k++) {
        if (k % 16 === 0) map += `\nrow ${String(Math.floor(k / 16)).padStart(2)} (sent frames ${base + Math.floor(k / 16) * 20}+): `;
        if (got.has(k)) { okCount++; const exp = base + Math.floor(k / 16) * 20 + 4 + (k % 16); const d = got.get(k) - exp; map += d === 0 ? '#' : `(${d > 0 ? '+' : ''}${d})`; }
        else map += '.';
    }
    console.log(`608 pattern: ${okCount}/${total} text pairs survived (${(100 * okCount / total).toFixed(0)}%); base frame ≈ ${base}; control pairs seen in window: ${ctrlFrames.filter(f => f >= base && f < base + 320).length}/60`);
    console.log('  # = received on the expected frame, (+n) = shifted, . = lost' + map);
    // gaps between surviving sent frames
    const sentFrames = [...got.keys()].sort((a, b) => a - b).map(k => base + Math.floor(k / 16) * 20 + 4 + (k % 16));
    const gaps = sentFrames.slice(1).map((f, i) => f - sentFrames[i]);
    const hist = {};
    for (const g of gaps) hist[g] = (hist[g] || 0) + 1;
    console.log('  gap histogram between surviving text pairs (frames):', JSON.stringify(hist));
    // survival by position within row
    const byPos = Array(16).fill(0);
    for (const k of got.keys()) byPos[k % 16]++;
    console.log('  survivors by position in row (0..15):', byPos.join(' '), ' of 15 rows each');
    // survival by frame type of the received frame
    const types = {};
    for (const r of rows) { if (idx(r.text) >= 0) types[r.type] = (types[r.type] || 0) + 1; }
    console.log('  received text pairs by WP frame type:', JSON.stringify(types));
}

// ---- 708 ----
const pk = [];
for (const r of rows) {
    if (r.frame < from || !r.dtvcc) continue;
    const b = Buffer.from(r.dtvcc, 'hex');
    const s = b.toString('latin1');
    const m = s.match(/P(\d\d) abc/);
    if (m) pk.push({ n: +m[1], frame: r.frame });
}
if (pk.length) {
    const seen = new Set(pk.map(p => p.n));
    let map = '';
    for (let i = 1; i <= 40; i++) map += seen.has(i) ? '#' : '.';
    console.log(`\n708 pattern: ${seen.size}/40 packets survived: ${map}`);
    console.log('  received at frames:', pk.map(p => `${p.n}@${p.frame}`).join(' '));
}
