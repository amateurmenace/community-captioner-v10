// wp-redraw-test.mjs — send numbered captions through the app's CEA-708 redraw transport
// while the Web Presenter's RTMP output is being captured, and write the schedule that
// dtvcc-display.mjs scores the capture against.
//
//   node wp-redraw-test.mjs [--relay http://localhost:8090] [--captions 40] [--interval 75]
//                           [--config '{"dtvccRepeat":2,"dtvccRepaintFrames":30}'] [--tag R]
//                           [--out schedule.json]
//
// The relay must already be injecting (Caption Injection running on the output that feeds
// the Web Presenter). The script switches it to CEA-708 only, verbatim, no polish, applies
// the transport config, sends `captions` captions `interval` frames apart (measured with the
// addon's frame counter), records {frame: framesOutput at the POST, text} for each, and
// restores the caption config it found at the start.
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const BASE = opt('--relay', process.env.RELAY || 'http://localhost:8090');
const N = +opt('--captions', 40);
const INTERVAL = +opt('--interval', 75);
const TAG = opt('--tag', 'R');
const OUT = opt('--out', `schedule-${TAG}.json`);
const extra = JSON.parse(opt('--config', '{}'));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 23);
async function post(path, body) {
    const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const t = await r.text(); if (!r.ok) throw new Error(`${path} → ${r.status} ${t.slice(0, 200)}`);
    try { return JSON.parse(t); } catch { return t; }
}
async function get(path) { return (await fetch(BASE + path)).json(); }

// two rows of at most 26 characters, both unique per caption: "<TAG>nn <first>" and "<second> <nn>"
const FIRST = ['quick brown fox jumps', 'select board of the', 'public comment on the', 'all those in favor', 'report from the town', 'the next item is the', 'thank you madam chair', 'we now take a short'];
const SECOND = ['over the lazy dog', 'town of brookline', 'capital plan tonight', 'say aye motion carries', 'administrator on water', 'school budget for next', 'for that update today', 'recess of five minutes'];

const st = await get('/api/inject/status');
if (!st.running) { console.error(`${stamp()} injection is not running on ${BASE} — start Caption Injection first`); process.exit(1); }
const before = await get('/api/caption/config');
console.log(`${stamp()} relay ${BASE}: ${st.mode}, ${st.frameRate} fps, ${st.framesOutput} frames out; transport ${JSON.stringify(st.dtvccTransport)}`);
const cfg = await post('/api/caption/config', { encodingMode: 'dtvcc', cea608InDtvcc: false, captionStrategy: 'verbatim', polishEnabled: false, profanityFilter: false, maxCharsPerLine: 64, ...extra });
console.log(`${stamp()} config: mode=${cfg.encodingMode} 608=${cfg.cea608InDtvcc} repaint=${cfg.dtvccRepaintFrames} repeat=${cfg.dtvccRepeat} gap=${cfg.dtvccRepeatGap} blocks=${cfg.dtvccBlocks} erase=${cfg.dtvccRowErase} cols=${cfg.dtvccColumns} dfw=${cfg.dtvccDefineOnChange}`);
await sleep(1500);
const after = await get('/api/inject/status');
const columns = after.dtvccTransport?.columns || 27;
const rows = cfg.rollupRows || 2;

const captions = [];
let next = (await get('/api/inject/status')).framesOutput + 10;
for (let i = 1; i <= N; i++) {
    // wait for the frame counter to reach the next slot
    let s;
    for (;;) { s = await get('/api/inject/status'); if (s.framesOutput >= next) break; await sleep(20); }
    const nn = String(i).padStart(2, '0');
    const text = `${TAG}${nn} ${FIRST[i % FIRST.length]} ${SECOND[i % SECOND.length]} ${nn}.`;
    const t0 = Date.now();
    await post('/api/inject/caption', { text, isFinal: true, applyDictionary: false });
    captions.push({ frame: s.framesOutput, text });
    if (i % 10 === 1 || i === N) console.log(`${stamp()}   ${text}  @frame ${s.framesOutput} (${Date.now() - t0} ms)`);
    next = s.framesOutput + INTERVAL;
}
await sleep(3000);
writeFileSync(OUT, JSON.stringify({ relay: BASE, columns, rows, config: cfg, captions }, null, 1));
console.log(`${stamp()} ${N} captions sent, schedule → ${OUT}`);
// restore what the operator had
const keep = {};
for (const k of ['encodingMode', 'cea608InDtvcc', 'captionStrategy', 'polishEnabled', 'profanityFilter', 'maxCharsPerLine', 'dtvccRepaintFrames', 'dtvccRepeat', 'dtvccRepeatGap', 'dtvccBlocks', 'dtvccRowErase', 'dtvccColumns', 'dtvccDefineOnChange']) if (before[k] !== undefined) keep[k] = before[k];
await post('/api/caption/config', keep);
console.log(`${stamp()} config restored`);
