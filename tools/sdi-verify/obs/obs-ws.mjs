// obs-ws.mjs — a small obs-websocket 5 client (also importable) to drive OBS Studio as the
// CONTROL ENCODER for the embedded-caption measurements: a DeckLink input source (the loopback
// of the app's SDI output), the "Decklink Captions" tool forwarding the VANC captions into the
// stream's H.264 SEI, x264 to a local RTMP receiver or to YouTube, and SendStreamCaption (OBS's
// own libcaption pop-on CEA-608, the path thousands of YouTube streams use).
//
//   node obs-ws.mjs [--url ws://127.0.0.1:4455] [--password PW] <command> [args]
//     version                       obs-websocket / OBS versions
//     status                        stream status (active, bytes, frames, skipped)
//     inputs                        every input with its kind
//     devices <input>               DeckLink devices (name → device_hash) the input can choose from
//     modes <input>                 the input's video modes (name → mode_id)
//     get-input <input>             current settings of an input
//     set-input <input> <json>      merge settings into an input, e.g. '{"device_hash":"…","mode_id":-1}'
//     scene <name>                  switch the program scene
//     start | stop                  start / stop streaming
//     caption <text>                SendStreamCaption (needs an active stream)
//     captions-test [n] [interval]  n numbered captions `interval` ms apart through SendStreamCaption
//     request <type> [json]         any raw request
// The password can also come from OBS_WS_PASSWORD; the URL from OBS_WS_URL.
import WebSocket from 'ws';
import { createHash } from 'node:crypto';

export class ObsClient {
    constructor(url = process.env.OBS_WS_URL || 'ws://127.0.0.1:4455', password = process.env.OBS_WS_PASSWORD || '') {
        this.url = url; this.password = password; this.ws = null; this.pending = new Map(); this.seq = 0; this.identified = false;
    }
    connect(timeoutMs = 8000) {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(this.url);
            this.ws = ws;
            const timer = setTimeout(() => { reject(new Error(`obs-websocket: no Identified within ${timeoutMs} ms`)); try { ws.close(); } catch {} }, timeoutMs);
            ws.on('error', (e) => { clearTimeout(timer); reject(e); });
            ws.on('close', () => { this.identified = false; for (const [, p] of this.pending) p.reject(new Error('obs-websocket closed')); this.pending.clear(); });
            ws.on('message', (raw) => {
                let m; try { m = JSON.parse(raw.toString()); } catch { return; }
                if (m.op === 0) {               // Hello
                    const d = { rpcVersion: 1, eventSubscriptions: 0 };
                    if (m.d.authentication) {
                        const { challenge, salt } = m.d.authentication;
                        const secret = createHash('sha256').update(this.password + salt).digest('base64');
                        d.authentication = createHash('sha256').update(secret + challenge).digest('base64');
                    }
                    ws.send(JSON.stringify({ op: 1, d }));
                } else if (m.op === 2) {        // Identified
                    clearTimeout(timer); this.identified = true; resolve();
                } else if (m.op === 7) {        // RequestResponse
                    const p = this.pending.get(m.d.requestId);
                    if (!p) return;
                    this.pending.delete(m.d.requestId);
                    if (m.d.requestStatus.result) p.resolve(m.d.responseData || {});
                    else p.reject(new Error(`${m.d.requestType}: ${m.d.requestStatus.code} ${m.d.requestStatus.comment || ''}`));
                }
            });
        });
    }
    request(requestType, requestData = {}) {
        if (!this.identified) return Promise.reject(new Error('obs-websocket: not connected'));
        const requestId = `r${++this.seq}`;
        return new Promise((resolve, reject) => {
            this.pending.set(requestId, { resolve, reject });
            this.ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
        });
    }
    close() { try { this.ws?.close(); } catch {} }
}

// ---- CLI ----
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = process.argv.slice(2);
    const opt = (k, d) => { const i = args.indexOf(k); if (i >= 0) { args.splice(i, 2); return process.argv[process.argv.indexOf(k) + 1]; } return d; };
    const url = opt('--url', process.env.OBS_WS_URL || 'ws://127.0.0.1:4455');
    const password = opt('--password', process.env.OBS_WS_PASSWORD || '');
    const [cmd, ...rest] = args;
    const obs = new ObsClient(url, password);
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    try {
        await obs.connect();
        let out;
        switch (cmd) {
            case 'version': out = await obs.request('GetVersion'); break;
            case 'status': out = await obs.request('GetStreamStatus'); break;
            case 'inputs': out = (await obs.request('GetInputList')).inputs.map(i => `${i.inputName}  [${i.inputKind}]`).join('\n'); break;
            case 'devices': out = (await obs.request('GetInputPropertiesListPropertyItems', { inputName: rest[0], propertyName: 'device_hash' })).propertyItems.map(i => `${i.itemName}  →  ${i.itemValue}${i.itemEnabled ? '' : '  (disabled)'}`).join('\n'); break;
            case 'modes': out = (await obs.request('GetInputPropertiesListPropertyItems', { inputName: rest[0], propertyName: 'mode_id' })).propertyItems.map(i => `${i.itemName}  →  ${i.itemValue}`).join('\n'); break;
            case 'get-input': out = await obs.request('GetInputSettings', { inputName: rest[0] }); break;
            case 'set-input': out = await obs.request('SetInputSettings', { inputName: rest[0], inputSettings: JSON.parse(rest[1] || '{}'), overlay: true }); break;
            case 'scene': out = await obs.request('SetCurrentProgramScene', { sceneName: rest[0] }); break;
            case 'start': out = await obs.request('StartStream'); break;
            case 'stop': out = await obs.request('StopStream'); break;
            case 'caption': out = await obs.request('SendStreamCaption', { captionText: rest.join(' ') }); break;
            case 'captions-test': {
                // captions-test [n] [intervalMs] [tag] [--out schedule.json]: numbered two-row captions
                // through SendStreamCaption; the schedule (text + UTC time) is scored by yt-score.mjs
                const n = +(rest[0] || 20), interval = +(rest[1] || 2500), tag = rest[2] || 'OBS';
                const outFile = rest.includes('--out') ? rest[rest.indexOf('--out') + 1] : null;
                const FIRST = ['quick brown fox jumps', 'select board of the', 'public comment on the', 'all those in favor', 'report from the town', 'the next item is the', 'thank you madam chair', 'we now take a short'];
                const SECOND = ['over the lazy dog', 'town of brookline', 'capital plan tonight', 'say aye motion carries', 'administrator on water', 'school budget for next', 'for that update today', 'recess of five minutes'];
                const captions = [];
                for (let i = 1; i <= n; i++) {
                    const nn = String(i).padStart(2, '0');
                    const text = `${tag}${nn} ${FIRST[i % 8]} ${SECOND[i % 8]} ${nn}.`;
                    await obs.request('SendStreamCaption', { captionText: text });
                    captions.push({ text, utc: new Date().toISOString(), frame: Math.round(i * interval / 1000 * 29.97) });
                    console.log(`${new Date().toISOString().slice(11, 23)}  ${text}`);
                    await sleep(interval);
                }
                if (outFile) { const { writeFileSync } = await import('node:fs'); writeFileSync(outFile, JSON.stringify({ columns: 32, rows: 2, style: 'popon', source: 'SendStreamCaption', captions }, null, 1)); console.log(`schedule → ${outFile}`); }
                out = 'done'; break;
            }
            case 'request': out = await obs.request(rest[0], JSON.parse(rest[1] || '{}')); break;
            default: throw new Error(`unknown command ${cmd}`);
        }
        console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 1));
    } catch (e) {
        console.error(e.message); process.exitCode = 1;
    } finally { obs.close(); }
}
