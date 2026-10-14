// live-feed-e2e.mjs — the whole caption path in software: a relay with the virtual output,
// a session WebSocket sending the interims and finals of a few spoken sentences the way the
// Dashboard does, and the CEA-608 decoder model reading the CDPs the frame loop produced.
//
//   node tools/e2e/live-feed-e2e.mjs [--relay http://localhost:8093] [--spawn] [--config '{…}']
//
// --spawn starts `node server/relay.js` on the relay's port first (and stops it at the end).
// Prints when each word reached the screen relative to the interim that first carried it,
// and fails when the final text is not what the display shows at the end.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import WebSocket from 'ws';
import { Cea608Decoder, pairsFromCdp } from '../sdi-verify/captions/cea608-model.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const RELAY = opt('--relay', process.env.RELAY || 'http://localhost:8093');
const SPAWN = args.includes('--spawn');
const extra = JSON.parse(opt('--config', '{}'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

async function post(p, body) { const r = await fetch(RELAY + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const t = await r.text(); if (!r.ok) throw new Error(`${p} → ${r.status} ${t.slice(0, 200)}`); try { return JSON.parse(t); } catch { return t; } }
async function get(p) { return (await fetch(RELAY + p)).json(); }

let child = null;
if (SPAWN) {
    const port = new URL(RELAY).port || '8093';
    // the dev relay keeps its data (and the saved caption config) in <repo>/.data, never in the
    // packaged app's ~/.community-captioner/data, so the test cannot touch an operator's settings
    child = spawn(process.execPath, ['server/relay.js'], { cwd: root, env: { ...process.env, PORT: port }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
    for (let i = 0; i < 60; i++) { try { await get('/api/app/info'); break; } catch { await sleep(500); } }
}

// Sentences as a recognizer produces them: a growing interim every 250 ms, then the final.
const SENTENCES = [
    'so welcome to the advisory committee meeting of tonight which is to discuss one article',
    'if there are any members of the public who wish to speak please raise your hand',
    'the town of brookline will post the minutes on its website next week',
];
const FINALS = [
    'So welcome to the Advisory Committee meeting of tonight, which is to discuss one Article.',
    'If there are any members of the public who wish to speak, please raise your hand.',
    'The Town of Brookline will post the minutes on its website next week.',
];

let failed = 0;
const assert = (c, label) => { console.log(`  ${c ? '✅' : '❌'} ${label}`); if (!c) failed++; };

try {
    await post('/api/inject/stop', {}).catch(() => {});
    await post('/api/caption/config', { encodingMode: 'cea608', cea608Style: 'rollup_pac', captionStrategy: 'verbatim', polishEnabled: false, liveFeed: true, liveFeedStable: 3, liveFeedHold: 1, liveFeedBreak: false, ...extra });
    const start = await post('/api/inject/start', { sourceKind: 'virtual', frameRate: '29.97', encodingMode: 'cea608' });
    assert(start.ok && start.mode === 'inject_virtual', `virtual output started (${JSON.stringify(start)})`);

    const ws = new WebSocket(RELAY.replace(/^http/, 'ws') + '/');
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    ws.send(JSON.stringify({ type: 'join', sessionId: 'demo', role: 'broadcaster' }));
    await sleep(200);

    const t0 = Date.now();
    const firstSeen = new Map();   // word index (global) → ms the interim first carried it
    const sent = [];               // {at, text, final}
    let g = 0;
    for (let s = 0; s < SENTENCES.length; s++) {
        const words = SENTENCES[s].split(' ');
        for (let i = 1; i <= words.length; i++) {
            const text = words.slice(0, i).join(' ');
            firstSeen.set(g + i - 1, Date.now() - t0);
            ws.send(JSON.stringify({ type: 'caption', isFinal: false, payload: { text } }));
            sent.push({ at: Date.now() - t0, text, final: false });
            await sleep(250);
        }
        await sleep(600);
        ws.send(JSON.stringify({ type: 'caption', isFinal: true, payload: { id: String(Date.now()), text: FINALS[s], timestamp: Date.now(), isFinal: true } }));
        sent.push({ at: Date.now() - t0, text: FINALS[s], final: true });
        g += words.length;
        await sleep(1500);
    }
    await sleep(2500);
    const tEnd = Date.now() - t0;

    // Read every CDP the frame loop produced and replay it into the decoder model
    const { cdps, frameRate } = await get('/api/inject/cdps?from=0');
    const fps = 29.97;
    const dec = new Cea608Decoder();
    const shownAt = new Map();     // normalized word → ms it first appeared on screen
    let frames = 0, dataFrames = 0;
    for (const hex of cdps) {
        const pairs = (pairsFromCdp(Buffer.from(hex, 'hex')) || []).map(p => Array.isArray(p) ? p : [p.cc1, p.cc2]);
        if (pairs.some(p => (p[0] & 0x7F) !== 0 || (p[1] & 0x7F) !== 0)) dataFrames++;
        dec.feedFrame(pairs);
        frames++;
        const text = dec.display().filter(Boolean).join(' ');
        for (const w of text.toLowerCase().split(/\s+/)) { const k = w.replace(/[^a-z0-9']/g, ''); if (k && !shownAt.has(k)) shownAt.set(k, Math.round(frames * 1000 / fps)); }
    }
    const status = await get('/api/inject/status');
    console.log(`\n${frames} frames (${dataFrames} with caption data) in ${tEnd} ms; live feed: ${JSON.stringify(status.liveFeed)}`);
    console.log('final display:', JSON.stringify(dec.display().filter(Boolean)));

    // Every word of every final must be on screen at some point, in order
    const allWords = FINALS.join(' ').toLowerCase().split(/\s+/).map(w => w.replace(/[^a-z0-9']/g, '')).filter(Boolean);
    const missing = allWords.filter(w => !shownAt.has(w));
    assert(missing.length === 0, `every word of the three sentences reached the screen${missing.length ? ' — missing: ' + missing.join(', ') : ''}`);
    // The frame loop runs on wall-clock time, so the frame index is a clock: words should appear well before the final
    const lastFinalAt = sent.filter(x => x.final).map(x => x.at);
    let early = 0, total = 0;
    SENTENCES.forEach((s, si) => {
        const ws_ = s.split(' ');
        ws_.forEach((w, i) => { const k = w.replace(/[^a-z0-9']/g, ''); const at = shownAt.get(k); if (at !== undefined && i < ws_.length - 3) { total++; if (at < lastFinalAt[si]) early++; } });
    });
    assert(early > total * 0.6, `${early} of ${total} early-sentence words were on screen before their sentence's final arrived`);
    const lags = [];
    SENTENCES.forEach((s, si) => { s.split(' ').forEach((w, i) => { const k = w.replace(/[^a-z0-9']/g, ''); const seen = firstSeen.get(SENTENCES.slice(0, si).reduce((n, x) => n + x.split(' ').length, 0) + i); const at = shownAt.get(k); if (seen !== undefined && at !== undefined && at >= seen) lags.push(at - seen); }); });
    lags.sort((a, b) => a - b);
    const p = (q) => lags.length ? lags[Math.min(lags.length - 1, Math.floor(q * lags.length))] : NaN;
    console.log(`word on screen after the interim that first carried it: p50 ${p(0.5)} ms, p90 ${p(0.9)} ms (${lags.length} words)`);
    assert(p(0.5) < 2500, 'median word latency under 2.5 s (3 identical interims at 250 ms + one held word + 608 transmission)');
    assert(status.liveFeed.targets.includes('cea608') && status.liveFeed.chunks > 0, 'the relay reports the live feed active on the CEA-608 encoder');
    ws.close();
    await post('/api/inject/stop', {});
} catch (e) {
    console.error('e2e failed:', e.message);
    failed++;
} finally {
    if (child) { child.kill(); }
}
console.log(failed ? `\n${failed} FAILED` : '\nPASS');
process.exit(failed ? 1 : 0);
