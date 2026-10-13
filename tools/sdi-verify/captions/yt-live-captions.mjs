// yt-live-captions.mjs <watch-or-channel-live-url> [--python <venv python>] [--minutes 3] [--raw] [--json cues.json]
//
// Reads a YouTube live stream's caption track as the player receives it: yt-dlp finds the
// live video and its automatic_captions (the WebVTT HLS track YouTube derives from embedded
// CEA-608/708), the playlist's segments of the last N minutes are fetched and every cue is
// printed with its wall-clock time, its cue settings (line/position/align) and its text,
// de-duplicated. --json also writes every cue with absolute times for yt-score.mjs.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const url = args[0];
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const python = opt('--python', process.env.YT_PYTHON || 'python');
const minutes = +opt('--minutes', 3);
const raw = args.includes('--raw');
const jsonOut = opt('--json', null);

const info = JSON.parse(execFileSync(python, ['-m', 'yt_dlp', '--dump-json', '--no-warnings', url], { maxBuffer: 1 << 28 }).toString('utf8'));
const track = (info.automatic_captions?.en || info.subtitles?.en || [])[0];
console.log(`video ${info.id} "${info.title}" live=${info.is_live} availability=${info.availability}; caption track: ${track ? track.ext + ' ' + (track.protocol || '') : 'NONE'}`);
if (!track) process.exit(0);
const curl = (u) => execFileSync('curl.exe', ['-s', '-m', '20', u], { maxBuffer: 1 << 26 }).toString('utf8');
const m3u8 = curl(track.url);
// PROGRAM-DATE-TIME may be given only once; later segments follow by their EXTINF durations
const segs = [];
let pdt = null, dur = 0;
for (const l of m3u8.split('\n')) {
    if (l.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) pdt = Date.parse(l.slice(25).trim());
    else if (l.startsWith('#EXTINF:')) dur = parseFloat(l.slice(8)) || 5;
    else if (l && !l.startsWith('#')) { if (pdt !== null) { segs.push({ t: pdt, u: l.trim() }); pdt += dur * 1000; } }
}
const from = Date.now() - minutes * 60000;
const base = track.url.slice(0, track.url.lastIndexOf('/') + 1);
console.log(`${segs.length} segments in the playlist; reading the last ${minutes} min`);
const tsMs = (t) => { const [h, m, rest] = t.split(':'); return (+h * 3600 + +m * 60 + parseFloat(rest)) * 1000; };
const allCues = [];
let last = '';
for (const s of segs.filter(s => s.t >= from)) {
    const body = curl(s.u.startsWith('http') ? s.u : base + s.u);
    if (raw) { console.log(`--- ${new Date(s.t).toISOString().slice(11, 19)} ---\n${body}`); continue; }
    const lines = body.split('\n');
    const cues = [];
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^(\d\d:\d\d:\d\d\.\d{3}) --> (\d\d:\d\d:\d\d\.\d{3})(.*)$/);
        if (!m) continue;
        const text = [];
        for (let k = i + 1; k < lines.length && lines[k].trim() !== '' && !/-->/.test(lines[k]); k++) text.push(lines[k]);
        cues.push(`${m[1].slice(3)}→${m[2].slice(3)}${m[3].trim() ? ' [' + m[3].trim() + ']' : ''} ${JSON.stringify(text.join('\n'))}`);
        allCues.push({ seg: s.t, start: s.t + tsMs(m[1]), end: s.t + tsMs(m[2]), settings: m[3].trim(), text: text.join('\n') });
    }
    const out = cues.join('\n    ');
    if (out && out !== last) console.log(`${new Date(s.t).toISOString().slice(11, 19)}  ${out}`);
    last = out;
}
if (jsonOut) { writeFileSync(jsonOut, JSON.stringify({ video: info.id, cues: allCues }, null, 1)); console.log(`${allCues.length} cues → ${jsonOut}`); }
