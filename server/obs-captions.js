/**
 * OBS caption output — send every final caption to OBS Studio over obs-websocket 5
 * (`SendStreamCaption`). OBS turns the text into a CEA-608 pop-on caption with libcaption
 * (the whole caption in one H.264 SEI on the next video frame) and YouTube, Twitch, Facebook
 * etc. render it like any broadcast caption. This is the path most captioned YouTube streams
 * use, and it bypasses the SDI encoder entirely: it is the embedded-caption answer for
 * operators who stream with OBS instead of (or behind) a Blackmagic Web Presenter.
 *
 * Configure with POST /api/obs/config {enabled, url, password, displaySeconds}; the relay
 * keeps the connection open, re-identifies after a drop (1 s → 15 s backoff) and reports
 * status through GET /api/obs/status. OBS must be streaming for SendStreamCaption to be
 * accepted ("OutputNotRunning" otherwise); such refusals are counted, not retried.
 */
import WebSocket from 'ws';
import { createHash } from 'crypto';

const state = {
    enabled: false,
    url: 'ws://127.0.0.1:4455',
    password: '',
    displaySeconds: 0,     // 0 = OBS default (2 s hold per caption; a new caption replaces it anyway)
    connected: false,
    identified: false,
    lastError: null,
    sent: 0,
    refused: 0,
    lastSentMs: 0,
    lastText: '',
    obsVersion: null,
    streaming: null,
};
let ws = null;
let reconnectTimer = null;
let backoffMs = 1000;
let seq = 0;
const pending = new Map();

function clearSocket() {
    if (ws) { try { ws.removeAllListeners(); ws.close(); } catch {} }
    ws = null;
    state.connected = false; state.identified = false;
    for (const [, p] of pending) p.reject(new Error('obs-websocket closed'));
    pending.clear();
}

function scheduleReconnect() {
    if (!state.enabled || reconnectTimer) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, backoffMs);
    backoffMs = Math.min(15000, backoffMs * 2);
}

function request(requestType, requestData = {}, timeoutMs = 3000) {
    if (!ws || !state.identified) return Promise.reject(new Error('OBS not connected'));
    const requestId = `cc${++seq}`;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`${requestType}: timeout`)); }, timeoutMs);
        pending.set(requestId, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
        try { ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } })); }
        catch (e) { pending.delete(requestId); clearTimeout(timer); reject(e); }
    });
}

function connect() {
    if (!state.enabled || ws) return;
    let socket;
    try { socket = new WebSocket(state.url); } catch (e) { state.lastError = e.message; scheduleReconnect(); return; }
    ws = socket;
    socket.on('open', () => { state.connected = true; state.lastError = null; });
    socket.on('error', (e) => { state.lastError = e.message; });
    socket.on('close', () => { if (ws === socket) { clearSocket(); scheduleReconnect(); } });
    socket.on('message', (raw) => {
        let m; try { m = JSON.parse(raw.toString()); } catch { return; }
        if (m.op === 0) {
            const d = { rpcVersion: 1, eventSubscriptions: 0 };
            if (m.d.authentication) {
                const { challenge, salt } = m.d.authentication;
                const secret = createHash('sha256').update(state.password + salt).digest('base64');
                d.authentication = createHash('sha256').update(secret + challenge).digest('base64');
            }
            socket.send(JSON.stringify({ op: 1, d }));
        } else if (m.op === 2) {
            state.identified = true; backoffMs = 1000; state.lastError = null;
            console.log(`[OBS CC] Connected to ${state.url} (obs-websocket ${m.d.negotiatedRpcVersion ? 'rpc ' + m.d.negotiatedRpcVersion : ''})`);
            request('GetVersion').then(v => { state.obsVersion = `${v.obsVersion} / obs-websocket ${v.obsWebSocketVersion}`; }).catch(() => {});
            request('GetStreamStatus').then(s => { state.streaming = !!s.outputActive; }).catch(() => {});
        } else if (m.op === 7) {
            const p = pending.get(m.d.requestId);
            if (!p) return;
            pending.delete(m.d.requestId);
            if (m.d.requestStatus.result) p.resolve(m.d.responseData || {});
            else { const err = new Error(`${m.d.requestType}: ${m.d.requestStatus.code} ${m.d.requestStatus.comment || ''}`.trim()); err.code = m.d.requestStatus.code; p.reject(err); }
        }
    });
}

export function configureObsCaptions(cfg = {}) {
    if (cfg.url !== undefined && typeof cfg.url === 'string' && cfg.url.trim()) state.url = cfg.url.trim();
    if (cfg.password !== undefined) state.password = String(cfg.password || '');
    if (cfg.displaySeconds !== undefined) state.displaySeconds = Math.max(0, Math.min(30, parseFloat(cfg.displaySeconds) || 0));
    const wasEnabled = state.enabled;
    if (cfg.enabled !== undefined) state.enabled = !!cfg.enabled;
    // any change restarts the connection
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    clearSocket();
    backoffMs = 1000;
    if (state.enabled) connect();
    else if (wasEnabled) console.log('[OBS CC] Disabled');
    return getObsCaptionStatus();
}

export function getObsCaptionStatus() {
    return {
        enabled: state.enabled, url: state.url, passwordSet: !!state.password, displaySeconds: state.displaySeconds,
        connected: state.connected, identified: state.identified, obsVersion: state.obsVersion, streaming: state.streaming,
        sent: state.sent, refused: state.refused, lastSentMs: state.lastSentMs, lastText: state.lastText, lastError: state.lastError,
    };
}

/** Send one final caption; never throws, never blocks the caller. */
export function sendObsCaption(text) {
    if (!state.enabled || !text) return;
    const captionText = String(text).trim();
    if (!captionText) return;
    const data = { captionText };
    if (state.displaySeconds > 0) data.displayDuration = state.displaySeconds;   // obs-websocket ≥ 5.6
    request('SendStreamCaption', data).then(() => {
        state.sent++; state.lastSentMs = Date.now(); state.lastText = captionText; state.streaming = true; state.lastError = null;
    }).catch((e) => {
        state.refused++;
        state.lastError = e.message;
        if (e.code === 500 || /OutputNotRunning/.test(e.message)) state.streaming = false;
    });
}

/** Ask OBS for its stream status (for the status panel). */
export async function refreshObsStreaming() {
    try { const s = await request('GetStreamStatus'); state.streaming = !!s.outputActive; } catch {}
    return state.streaming;
}
