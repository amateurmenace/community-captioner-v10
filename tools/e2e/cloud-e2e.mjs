// cloud-e2e.mjs <appUrl> <wav> — fresh Chrome profile with a fake microphone that plays the WAV,
// driven over the DevTools protocol: Start Captioning → Live Session → Cloud mode → Start,
// then watch for the Gemini Live connection and caption text. Prints a verdict.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const [appUrl = 'http://localhost:8092', wav] = process.argv.slice(2);
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9333;
const profile = mkdtempSync(join(tmpdir(), 'cc-e2e-'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 23);

const chrome = spawn(CHROME, [
    `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, '--no-first-run', '--no-default-browser-check',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`,
    '--autoplay-policy=no-user-gesture-required', '--window-size=1400,900', '--disable-background-timer-throttling', appUrl,
], { stdio: 'ignore' });

let ws, id = 0; const pending = new Map(); const consoleLog = [];
async function connect() {
    for (let i = 0; i < 40; i++) {
        try {
            const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
            const page = targets.find(t => t.type === 'page' && t.url.startsWith(appUrl));
            if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); }); break; }
        } catch {}
        await sleep(500);
    }
    if (!ws) throw new Error('no page target');
    ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
        else if (m.method === 'Runtime.consoleAPICalled') consoleLog.push(`${stamp()} ${m.params.type}: ${m.params.args.map(a => a.value ?? a.description ?? '').join(' ')}`);
        else if (m.method === 'Runtime.exceptionThrown') consoleLog.push(`${stamp()} EXCEPTION: ${m.params.exceptionDetails.text} ${m.params.exceptionDetails.exception?.description || ''}`);
    });
}
const send = (method, params = {}) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || '')); return r.result.value; };
const clickText = async (text, selector = 'button, a, [role=button], div[class*=cursor-pointer]') => evaluate(`(() => { const els = [...document.querySelectorAll(${JSON.stringify(selector)})]; const el = els.find(e => (e.textContent || '').replace(/\\s+/g, ' ').trim().includes(${JSON.stringify(text)})); if (!el) return 'NOT FOUND'; el.click(); return 'clicked ' + (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 50); })()`);
const waitFor = async (expr, timeoutMs = 15000, label = expr) => { const t0 = Date.now(); while (Date.now() - t0 < timeoutMs) { const v = await evaluate(expr); if (v) return v; await sleep(400); } throw new Error('timeout waiting for ' + label); };

try {
    await connect();
    await send('Runtime.enable'); await send('Page.enable');
    await waitFor(`document.readyState === 'complete' && !!document.body`);
    await sleep(1500);
    console.log(stamp(), 'landing:', await clickText('Start Captioning'));
    // locally "Start Captioning" goes straight to the Dashboard; a cloud deployment shows the workflow picker first
    // (textContent, not innerText: the Mode label is rendered uppercase by CSS)
    const dashboardExpr = `[...document.querySelectorAll('label')].some(l => l.textContent.trim() === 'Mode') && [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Start')`;
    const where = await waitFor(`(${dashboardExpr}) ? 'dashboard' : (document.body.innerText.includes('Choose a workflow') ? 'picker' : '')`, 20000, 'dashboard or workflow picker');
    if (where === 'picker') { console.log(stamp(), 'picker:', await clickText('Live Session')); await waitFor(dashboardExpr, 20000, 'dashboard'); }
    else console.log(stamp(), 'dashboard opened directly');
    await sleep(800);
    // the mode group: the "Mode" label's container holds five icon buttons, the fifth is Cloud
    console.log(stamp(), 'mode:', await evaluate(`(() => { const lab = [...document.querySelectorAll('label')].find(l => l.textContent.trim() === 'Mode'); if (!lab) return 'no Mode label'; const btns = lab.parentElement.querySelectorAll('button'); if (btns.length < 5) return 'only ' + btns.length + ' mode buttons'; btns[4].click(); return 'clicked cloud (' + btns.length + ' buttons)'; })()`));
    await sleep(800);
    const modeSel = await evaluate(`(() => { const lab = [...document.querySelectorAll('label')].find(l => l.textContent.trim() === 'Mode'); const btns = [...lab.parentElement.querySelectorAll('button')]; return btns.map((b, i) => (b.className.includes('bg-white') ? 'ON' : 'off')).join(','); })()`);
    console.log(stamp(), 'mode buttons (balanced,local,fully_local,resilience,cloud):', modeSel);
    console.log(stamp(), 'start:', await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Start'); if (!b) return 'no Start'; b.click(); return 'clicked Start'; })()`));
    const t0 = Date.now();
    let connected = false, captionText = '', diag = '', lastBody = '';
    while (Date.now() - t0 < 75000) {
        await sleep(2000);
        diag = await evaluate(`localStorage.getItem('cc_diag_log') || ''`);
        const body = await evaluate(`document.body.innerText`);
        if (body !== lastBody) lastBody = body;
        if (!connected && consoleLog.some(l => l.includes('Gemini Live Connected'))) { connected = true; console.log(stamp(), 'Gemini Live connected after', ((Date.now() - t0) / 1000).toFixed(1), 's'); }
        const hit = ['Brookline', 'Harvard', 'motion carries', 'Select Board', 'water main'].filter(w => body.includes(w));
        if (hit.length >= 2) { captionText = hit.join(' / '); console.log(stamp(), 'caption text seen on the Dashboard:', captionText, 'after', ((Date.now() - t0) / 1000).toFixed(1), 's'); break; }
    }
    const dialogOpen = await evaluate(`document.body.innerText.includes('Help & Settings') && document.body.innerText.includes('Gemini API Key') && !!document.querySelector('input[type=password]')`);
    const stored = await evaluate(`localStorage.getItem('cc_api_key')`);
    const modeNow = await evaluate(`(() => { const lab = [...document.querySelectorAll('label')].find(l => l.textContent.trim() === 'Mode'); const btns = [...lab.parentElement.querySelectorAll('button')]; return btns.findIndex(b => b.className.includes('bg-white')); })()`);
    const pill = await evaluate(`(() => { const t = document.body.innerText; const m = t.match(/(Cloud \\(Gemini\\)|Cloud|Balanced|Local)[^\\n]{0,40}/); return m ? m[0] : ''; })()`);
    console.log('\n==== verdict');
    console.log('mode button selected index (4 = cloud):', modeNow, '| settings dialog open:', dialogOpen, '| cc_api_key in localStorage:', stored ? 'SET (' + String(stored).length + ' chars)' : 'none (server key path)');
    console.log('Gemini Live connected:', connected, '| caption text from the WAV on screen:', captionText || 'NONE');
    console.log('diag log (last 12):'); try { const d = JSON.parse(diag); for (const e of d.slice(-12)) console.log('  ', JSON.stringify(e).slice(0, 200)); } catch { console.log('  ', String(diag).slice(-800)); }
    console.log('console (filtered):'); for (const l of consoleLog.filter(l => /Gemini|cloud|Cloud|key|Session|error|Error|caption/i.test(l)).slice(0, 25)) console.log('  ', l.slice(0, 220));
    const screenshot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 60 });
    (await import('node:fs')).writeFileSync(join(process.cwd(), 'e2e-final.jpg'), Buffer.from(screenshot.data, 'base64'));
    console.log('screenshot → e2e-final.jpg');
} catch (e) {
    console.error('E2E ERROR:', e.message);
    try { const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 60 }); (await import('node:fs')).writeFileSync(join(process.cwd(), 'e2e-error.jpg'), Buffer.from(shot.data, 'base64')); console.log('screenshot → e2e-error.jpg'); console.log('body text:', (await evaluate('document.body.innerText')).replace(/\s+/g, ' ').slice(0, 600)); } catch {}
    console.log('console (last 15):'); for (const l of consoleLog.slice(-15)) console.log('  ', l.slice(0, 220));
} finally {
    try { ws?.close(); } catch {}
    try { chrome.kill(); } catch {}
    await sleep(1500);
    try { spawn('taskkill', ['/F', '/T', '/PID', String(chrome.pid)], { stdio: 'ignore' }); } catch {}
    await sleep(1500);
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
