// yt-score.mjs <schedule.json> <cues.json> [--from HH:MM:SS] [--to HH:MM:SS]
// Did each caption sent by wp-redraw-test.mjs reach YouTube's live caption track (cues.json from
// yt-live-captions.mjs --json), when, for how long, and with the complete text? A caption is
// matched by the rows its window would show (the last `rows` rows of the text wrapped at
// `columns`), in order (each match must start after the previous caption's first cue), within
// the UTC time window of the run.
import { readFileSync } from 'node:fs';
import { wrapRows } from '../../../server/cea708/cea608-encoder.js';

const args = process.argv.slice(2);
const [schedFile, cuesFile] = args;
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const today = new Date().toISOString().slice(0, 10);
const fromMs = opt('--from') ? Date.parse(`${today}T${opt('--from')}Z`) : -Infinity;
const toMs = opt('--to') ? Date.parse(`${today}T${opt('--to')}Z`) : Infinity;

const sched = JSON.parse(readFileSync(schedFile, 'utf8'));
const caps = Array.isArray(sched) ? sched : sched.captions;
const columns = (Array.isArray(sched) ? 26 : sched.columns) || 26;
// CEA-608 schedules (wp-608-test.mjs / yt-clean-608.mjs / obs-ws.mjs captions-test) carry `style`; 708 schedules take the window rows from the transport
const rows = (Array.isArray(sched) ? 2 : (sched.style ? sched.rows : (sched.config && sched.config.dtvccStyle === 'atomic' ? (sched.config.dtvccAtomicWindows === 2 ? 2 : 1) : sched.rows))) || 2;
const cues = JSON.parse(readFileSync(cuesFile, 'utf8')).cues.filter(x => x.start >= fromMs && x.start <= toMs).sort((a, b) => a.start - b.start);
// YouTube emits paint-on captions as karaoke-style cues with per-pair timestamps (<00:00:03.551><c>05</c>): strip the tags
const norm = (t) => t.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

let found = 0, complete = 0, totalVisible = 0;
const diffs = [];
let prevFirst = null, prevSend = null, cursor = 0;
for (let k = 0; k < caps.length; k++) {
    const c = caps[k];
    const want = wrapRows(c.text, columns).slice(-rows);
    const wantText = norm(want.join(' '));
    // a lone row counts only when it carries the caption's tag (first word): second rows repeat across runs
    const matches = (x) => norm(x.text) === wantText || (want.length > 1 && norm(x.text) === norm(want[0]));
    const start = cues.findIndex((x, i) => i >= cursor && matches(x));
    if (start < 0) { console.log(`  ${String(k + 1).padStart(2)}  MISSING   ${JSON.stringify(want.join(' | '))}`); prevFirst = null; prevSend = null; continue; }
    // this caption's cues run until a cue that is not its text (the next caption or something else)
    const taken = [];
    let i = start;
    for (; i < cues.length; i++) { if (matches(cues[i])) taken.push(cues[i]); else if (taken.length) break; }
    cursor = i;
    found++;
    const first = taken[0].start;
    const visible = taken.reduce((t, x) => t + (x.end - x.start), 0) / 1000;
    totalVisible += visible;
    const ok = taken.some(x => norm(x.text) === wantText);
    if (ok) complete++;
    let spacing = '';
    if (prevFirst !== null && c.frame !== undefined && prevSend !== null) {
        const sentGap = (c.frame - prevSend) / 29.97, ytGap = (first - prevFirst) / 1000;
        spacing = `  spacing ${ytGap.toFixed(2)} s (sent ${sentGap.toFixed(2)} s)`;
        diffs.push(ytGap - sentGap);
    }
    prevFirst = first; prevSend = c.frame;
    console.log(`  ${String(k + 1).padStart(2)}  ${new Date(first).toISOString().slice(11, 23)}  visible ${visible.toFixed(2).padStart(5)} s  pieces ${taken.length}  ${ok ? 'complete' : 'PARTIAL '}  ${JSON.stringify(norm(taken[taken.length - 1].text).slice(0, 52))}${spacing}`);
}
const jitter = diffs.length ? Math.sqrt(diffs.reduce((t, x) => t + x * x, 0) / diffs.length) : 0;
console.log(`\n${found}/${caps.length} captions reached YouTube's caption track, ${complete} with the complete window text; mean visible ${(totalVisible / Math.max(1, found)).toFixed(2)} s per caption (sent every ${caps.length > 1 && caps[1].frame !== undefined ? ((caps[1].frame - caps[0].frame) / 29.97).toFixed(2) : '?'} s); caption-to-caption spacing error ${jitter.toFixed(2)} s rms over ${diffs.length} pairs`);
