// wp-control.mjs — point a Blackmagic Web Presenter 4K (software 4.2+) at a local RTMP
// receiver for caption captures, and put it back, through its REST API.
//
//   node wp-control.mjs <host> status
//   node wp-control.mjs <host> capture-on  <rtmp://pc-ip:1935/live> [key]   # saves the current platform to wp-saved-<host>.json
//   node wp-control.mjs <host> capture-off                                  # restores the saved platform (stream key included)
//   node wp-control.mjs <host> start | stop
//
// capture-on selects the built-in "Custom URL H.264" platform (server "Custom" + the url,
// Streaming High: 1080p 6 Mb/s, keyframe every 2 s) and starts the stream; capture-off
// stops it and re-selects what was active before. The saved file holds that platform's
// stream key — keep it out of the repository (it is written in the working directory).
// (A custom platform XML uploaded through /livestreams/customPlatforms registers and lists
// its server, but PUT activePlatform answered "Invalid server provided" for it on 4.2.3.)
// The receiver: ffmpeg -listen 1 -i rtmp://0.0.0.0:1935/live/<key> -c copy cap.ts
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const [host, cmd, ...rest] = process.argv.slice(2);
if (!host || !cmd) { console.error('usage: wp-control.mjs <host> status|capture-on <rtmp-url> [key]|capture-off|start|stop'); process.exit(1); }
const api = (p) => `http://${host}/control/api/v1/${p}`;
const saved = `wp-saved-${host}.json`;
async function get(p) { const r = await fetch(api(p)); if (!r.ok) throw new Error(`GET ${p} → ${r.status}`); return r.json(); }
async function put(p, body, type = 'application/json') {
    const r = await fetch(api(p), { method: 'PUT', headers: { 'Content-Type': type }, body: type === 'application/json' ? JSON.stringify(body) : body });
    if (!r.ok) throw new Error(`PUT ${p} → ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.status;
}
const redact = (o) => ({ ...o, key: o.key ? `<${String(o.key).length} chars>` : o.key });

if (cmd === 'status') {
    const [s, p, prod] = await Promise.all([get('livestreams/0'), get('livestreams/0/activePlatform'), get('system/product')]);
    console.log(JSON.stringify({ product: prod, stream: s, activePlatform: redact(p) }, null, 1));
} else if (cmd === 'capture-on') {
    const url = rest[0]; const key = rest[1] || 'test';
    if (!url) throw new Error('rtmp url required');
    const current = await get('livestreams/0/activePlatform');
    if (current.platform !== 'Custom URL H.264') { writeFileSync(saved, JSON.stringify(current)); console.log(`saved current platform → ${saved}: ${JSON.stringify(redact(current))}`); }
    // the platform cannot be changed while the stream runs (HTTP 400): stop it first
    try { await put('livestreams/0/stop', {}); await new Promise(r => setTimeout(r, 3000)); } catch {}
    // the built-in "Custom URL H.264" platform takes the destination directly (server "Custom" + url)
    await put('livestreams/0/activePlatform', { platform: 'Custom URL H.264', server: 'Custom', url, key, quality: 'Streaming High' });
    await put('livestreams/0/start', {});
    await new Promise(r => setTimeout(r, 5000));
    console.log(`streaming to ${url}/${key}; status:`, JSON.stringify(await get('livestreams/0')));
} else if (cmd === 'capture-off') {
    if (!existsSync(saved)) throw new Error(`${saved} not found — nothing to restore`);
    const prev = JSON.parse(readFileSync(saved, 'utf8'));
    try { await put('livestreams/0/stop', {}); } catch {}
    await new Promise(r => setTimeout(r, 3000));   // a platform change right after stop is refused
    await put('livestreams/0/activePlatform', prev);
    console.log(`restored ${JSON.stringify(redact(prev))} (not started); status:`, JSON.stringify(await get('livestreams/0')));
} else if (cmd === 'start' || cmd === 'stop') {
    await put(`livestreams/0/${cmd}`, {});
    console.log(JSON.stringify(await get('livestreams/0')));
} else {
    throw new Error(`unknown command ${cmd}`);
}
