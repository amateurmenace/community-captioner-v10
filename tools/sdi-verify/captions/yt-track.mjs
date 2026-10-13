// yt-track.mjs <playlist-url-file> <fromUTC HH:MM:SS> [toUTC] — print YouTube live caption
// segments (WebVTT, 5 s each, PROGRAM-DATE-TIME) in a UTC window, de-duplicated.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const url = readFileSync(process.argv[2], 'utf8').trim();
const today = new Date().toISOString().slice(0, 10);
const from = Date.parse(`${today}T${process.argv[3]}Z`);
const to = process.argv[4] ? Date.parse(`${today}T${process.argv[4]}Z`) : Date.now();
const curl = (u) => execFileSync('curl.exe', ['-s', '-m', '20', u], { maxBuffer: 1 << 26 }).toString('utf8');
const m3u8 = curl(url);
const lines = m3u8.split('\n');
const segs = [];
let pdt = null;
for (const l of lines) {
    if (l.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) pdt = Date.parse(l.slice(25).trim());
    else if (l && !l.startsWith('#')) { if (pdt !== null) segs.push({ t: pdt, u: l.trim() }); pdt = null; }
}
console.log(`playlist: ${segs.length} segments, ${segs.length ? new Date(segs[0].t).toISOString().slice(11, 19) : '-'} → ${segs.length ? new Date(segs[segs.length - 1].t).toISOString().slice(11, 19) : '-'} UTC`);
const base = url.slice(0, url.lastIndexOf('/') + 1);
let last = '';
for (const s of segs.filter(s => s.t >= from - 5000 && s.t <= to)) {
    const body = curl(s.u.startsWith('http') ? s.u : base + s.u);
    const cues = body.split('\n').filter(l => l && !l.startsWith('WEBVTT') && !l.startsWith('X-TIMESTAMP') && !/^\d\d:\d\d/.test(l) && !/-->/.test(l) && !/^\d+$/.test(l));
    const text = [...new Set(cues)].join(' | ');
    if (text && text !== last) console.log(`${new Date(s.t).toISOString().slice(11, 19)}  ${text}`);
    last = text;
}
