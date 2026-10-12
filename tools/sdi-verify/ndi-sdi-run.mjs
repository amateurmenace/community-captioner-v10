#!/usr/bin/env node
// Drive the app's NDI → SDI caption injection through the relay API (the same calls the
// Caption Injection screen makes): start, send a caption every 3 s, print frame/drop/queue
// counters every 5 s, stop. Run it against the packaged app, not dev mode.
//
// Usage: node tools/sdi-verify/ndi-sdi-run.mjs "<NDI source name>" <outputDevice> [displayMode=1080p29.97] [seconds=60] [relay=http://localhost:8090]
//   displayMode: a mode name as listed by /api/decklink/devices (e.g. 1080p29.97, 1080i59.94) or its numeric code
const [source, outArg, modeArg = '1080p29.97', secsArg = '60', base = 'http://localhost:8090'] = process.argv.slice(2);
if (!source || outArg === undefined) {
  console.error('usage: ndi-sdi-run.mjs "<NDI source name>" <outputDevice> [displayMode=1080p29.97] [seconds=60] [relay=http://localhost:8090]');
  process.exit(1);
}
const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(r => r.json());
const get = (p) => fetch(base + p).then(r => r.json());

const outputDevice = Number(outArg);
let displayMode = Number(modeArg);
if (!Number.isFinite(displayMode)) {
  const devs = await get('/api/decklink/devices');
  const dev = (devs.devices || devs).find(d => d.index === outputDevice);
  const m = dev?.displayModes?.find(x => x.name === modeArg);
  if (!m) { console.error(`mode "${modeArg}" not found on device ${outputDevice}`); process.exit(1); }
  displayMode = m.mode;
}
const frameRate = /23\.98/.test(modeArg) ? '23.98' : /59\.94/.test(modeArg) ? '59.94' : '29.97';

const status = await get('/api/inject/status');
console.log(`relay: addonLoaded=${status.addonLoaded} ndiAvailable=${status.ndiAvailable}`);
const t0 = Date.now();
const start = await post('/api/inject/start', { sourceKind: 'ndi', ndiSource: source, outputDevice, displayMode, frameRate, encodingMode: 'cea608' });
console.log(`start (${Date.now() - t0} ms):`, JSON.stringify(start));
if (!start.ok) process.exit(1);

let n = 0, prev = null;
const capTimer = setInterval(() => {
  post('/api/inject/caption', { text: `CAPTION TEST ${++n} from the NDI to SDI check.`, isFinal: true }).catch(() => {});
}, 3000);
const end = Date.now() + Number(secsArg) * 1000;
while (Date.now() < end) {
  await new Promise(r => setTimeout(r, 5000));
  const s = await get('/api/inject/status');
  const fps = prev ? ((s.framesOutput - prev.framesOutput) / 5).toFixed(1) : '-';
  console.log(`+${((Date.now() - t0) / 1000).toFixed(0)}s mode=${s.mode} frames=${s.framesOutput} (${fps}/s) dropped=${s.droppedFrames} captionQueue=${s.encoderQueueDepth}`);
  prev = s;
}
clearInterval(capTimer);
const metrics = await get('/api/caption/metrics').catch(() => null);
if (metrics) console.log(`captions encoded ${metrics.totalEncoded}, dropped ${metrics.totalDropped}`);
console.log('stop:', JSON.stringify(await post('/api/inject/stop')));
