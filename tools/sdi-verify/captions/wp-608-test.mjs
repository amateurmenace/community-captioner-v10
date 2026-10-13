// wp-608-test.mjs — send numbered captions through the app's CEA-608 encoder while the
// encoder's output is being captured (Web Presenter RTMP, OBS loopback, or a DeckLink input),
// and write the schedule that cea608-display.mjs / yt-score.mjs score the capture against.
//
//   node wp-608-test.mjs [--relay http://localhost:8090] [--captions 30] [--interval 75]
//                        [--config '{"cea608Style":"popon","cea608OneFrame":true,"cea608Copies":3,"cea608CopyGap":4}']
//                        [--tag S] [--out schedule-S.json] [--short N]
//
// The relay must already be injecting. The script switches it to CEA-608, verbatim, no polish,
// applies the config, sends `captions` captions `interval` frames apart (measured with the
// addon's frame counter), records {frame, text, style} for each, and restores the config.
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const BASE = opt('--relay', process.env.RELAY || 'http://localhost:8090');
const N = +opt('--captions', 30);
const INTERVAL = +opt('--interval', 75);
const TAG = opt('--tag', 'S');
const OUT = opt('--out', `schedule-${TAG}.json`);
const extra = JSON.parse(opt('--config', '{}'));
const SHORT = +opt('--short', 0);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 23);
async function post(path, body) {
    const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const t = await r.text(); if (!r.ok) throw new Error(`${path} → ${r.status} ${t.slice(0, 200)}`);
    try { return JSON.parse(t); } catch { return t; }
}
async function get(path) { return (await fetch(BASE + path)).json(); }

const FIRST = ['quick brown fox jumps', 'select board of the', 'public comment on the', 'all those in favor', 'report from the town', 'the next item is the', 'thank you madam chair', 'we now take a short'];
const SECOND = ['over the lazy dog', 'town of brookline', 'capital plan tonight', 'say aye motion carries', 'administrator on water', 'school budget for next', 'for that update today', 'recess of five minutes'];
const BRIEF = ['quick fox', 'town hall', 'public say', 'all in favor', 'water main', 'next item', 'thank you', 'recess now'];

const st = await get('/api/inject/status');
if (!st.running) { console.error(`${stamp()} injection is not running on ${BASE} — start Caption Injection first`); process.exit(1); }
const before = await get('/api/caption/config');
const cfg = await post('/api/caption/config', { encodingMode: 'cea608', captionStrategy: 'verbatim', polishEnabled: false, profanityFilter: false, maxCharsPerLine: 64, ...extra });
console.log(`${stamp()} relay ${BASE}: ${st.mode}, ${st.frameRate} fps, ${st.framesOutput} frames out; 608 style=${cfg.cea608Style} ctrl×${cfg.cea608ControlRepeat} oneFrame=${cfg.cea608OneFrame} copies=${cfg.cea608Copies} gap=${cfg.cea608CopyGap} hold=${cfg.cea608HoldFrames} ccCount=${cfg.cea608CcCount} rows=${cfg.rollupRows}`);
await sleep(1500);

const captions = [];
let next = (await get('/api/inject/status')).framesOutput + 10;
for (let i = 1; i <= N; i++) {
    let s;
    for (;;) { s = await get('/api/inject/status'); if (s.framesOutput >= next) break; await sleep(20); }
    const nn = String(i).padStart(2, '0');
    const text = SHORT ? `${TAG}${nn} ${(SHORT >= 30 ? FIRST : BRIEF)[i % 8]} ${nn}`.slice(0, SHORT) : `${TAG}${nn} ${FIRST[i % FIRST.length]} ${SECOND[i % SECOND.length]} ${nn}.`;
    const t0 = Date.now();
    await post('/api/inject/caption', { text, isFinal: true, applyDictionary: false });
    captions.push({ frame: s.framesOutput, text, style: cfg.cea608Style });
    if (i % 10 === 1 || i === N) console.log(`${stamp()}   ${text}  @frame ${s.framesOutput} (${Date.now() - t0} ms)`);
    next = s.framesOutput + INTERVAL;
}
await sleep(3000);
writeFileSync(OUT, JSON.stringify({ relay: BASE, columns: 32, rows: cfg.rollupRows || 2, style: cfg.cea608Style, config: cfg, captions }, null, 1));
console.log(`${stamp()} ${N} captions sent, schedule → ${OUT}`);
const keep = {};
for (const k of ['encodingMode', 'captionStrategy', 'polishEnabled', 'profanityFilter', 'maxCharsPerLine', 'cea608Style', 'cea608ControlRepeat', 'cea608OneFrame', 'cea608Copies', 'cea608CopyGap', 'cea608HoldFrames', 'cea608CcCount', 'cea608PaceFrames', 'cea608Repeat', 'rollupRows']) if (before[k] !== undefined) keep[k] = before[k];
await post('/api/caption/config', keep);
console.log(`${stamp()} config restored`);
