// wp-pattern.mjs — numbered caption pattern so each surviving pair/packet in the Web
// Presenter output identifies the exact sent frame.
//   phase 608: captions of 16 unique 2-char pairs (A0..Z9), one row each → 20 frames/caption
//   phase 708: 40 short captions "P01 ..." each fitting one DTVCC packet (one frame)
// Usage: node wp-pattern.mjs [608|708|both] [1080p|1080i]
const BASE = process.env.RELAY || 'http://localhost:8080';
const phase = process.argv[2] || 'both';
const fmt = process.argv[3];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 23);
async function post(path, body) {
    const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const t = await r.text(); if (!r.ok) throw new Error(`${path} → ${r.status} ${t.slice(0, 200)}`);
    try { return JSON.parse(t); } catch { return t; }
}
async function get(path) { return (await fetch(BASE + path)).json(); }
async function queueBelow(n) { for (let i = 0; i < 200; i++) { const s = await get('/api/inject/status'); if ((s.encoderQueueDepth || 0) < n) return; await sleep(150); } }

if (fmt) {
    const displayMode = fmt === '1080i' ? 1214854457 : 1215312441;
    console.log(`${stamp()} restarting injection at ${fmt}`);
    await post('/api/inject/start', { sourceKind: 'ndi', ndiSource: 'AUD CAM 1 (Chan 1)', outputDevice: 8, displayMode, frameRate: '29.97', encodingMode: 'cea608' });
    await sleep(15000);  // let the Web Presenter re-lock
}
await post('/api/caption/config', { captionStrategy: 'verbatim', polishEnabled: false, profanityFilter: false, maxCharsPerLine: 64, rollupRows: 2 });

if (phase === '608' || phase === 'both') {
    await post('/api/caption/config', { encodingMode: 'cea608', cea608PaceFrames: 1, cea608Repeat: 1, cea608InDtvcc: true });
    await sleep(1000);
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';  // 24 letters × 10 digits = 240 pairs = 15 rows
    const pairs = [];
    for (const L of letters) for (let d = 0; d < 10; d++) pairs.push(L + d);
    console.log(`${stamp()} 608 pattern start (${pairs.length / 16} rows of 16 pairs)`);
    for (let r = 0; r < pairs.length / 16; r++) {
        const row = pairs.slice(r * 16, r * 16 + 16).join('');
        await queueBelow(40);
        await post('/api/inject/caption', { text: row, isFinal: true, applyDictionary: false });
        console.log(`${stamp()}   row ${r}: ${row}`);
    }
    await queueBelow(1);
    console.log(`${stamp()} 608 pattern sent`);
    await sleep(3000);
}
if (phase === '708' || phase === 'both') {
    await post('/api/caption/config', { encodingMode: 'dtvcc', cea608InDtvcc: false });
    await sleep(1000);
    console.log(`${stamp()} 708 pattern start (40 one-packet captions)`);
    for (let i = 1; i <= 40; i++) {
        const text = `P${String(i).padStart(2, '0')} abcdefghijklmnopqrstuvw`;   // 27 chars → one packet
        await queueBelow(3);
        await post('/api/inject/caption', { text, isFinal: true, applyDictionary: false });
    }
    await queueBelow(1);
    console.log(`${stamp()} 708 pattern sent`);
    await sleep(3000);
}
await post('/api/caption/config', { encodingMode: 'cea608', cea608PaceFrames: 1, cea608Repeat: 1, cea608InDtvcc: true, captionStrategy: 'truncate', polishEnabled: true });
console.log(`${stamp()} done`);
