// yt-clean-608.mjs <src.ts> <out.mp4> [phases] — a clean CEA-608-only test stream from the app's
// encoder in labelled phases (fresh encoder per phase), for YouTube's converter / player and for
// any decoder, with the schedule for cea608-display.mjs / yt-score.mjs. Every frame carries a
// standard 20-triplet CDP's cc_data (field 1 + field 2 + DTVCC padding) so the stream looks
// exactly like the SDI, minus the Web Presenter.
//
// Phases (default "all"; or a comma list of ids):
//   R2  rollup      RU2 RU2 [PAC PAC] CR CR text — the app's roll-up, control codes doubled (6.11–6.13)
//   RP  rollup_pac  RU2 CR PAC per row, doubled
//   R1  rollup1     the roll-up with every control code ONCE
//   P2  popon       RCL ENM PAC14 text PAC15 text EOC, doubled, one pair per frame (broadcast pop-on)
//   P1  popon1      pop-on with control codes once (libcaption/OBS send them once, EOC twice)
//   PF  popon-frame pop-on packed into one frame (19 pairs), 3 copies 4 frames apart
//   PA  painton     RDC PAC text DER per row, doubled
// Caption text: "<id>-nn <words>" two rows ≤ 32 columns, unique per caption, every 75 frames (2.5 s);
// 13 captions = 975 frames + 50 idle per phase (34 s).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { Cea608Encoder } from '../../../server/cea708/cea608-encoder.js';
import { Cea708CdpBuilder } from '../../../server/cea708/cea708-cdp-builder.js';

const [inFile, outFile, phaseArg = 'all'] = process.argv.slice(2);
if (!inFile || !outFile) { console.error('usage: yt-clean-608.mjs <src.ts> <out.mp4> [phases]'); process.exit(1); }
const FPS = '29.97';
const CAPTIONS = 13, INTERVAL = 75, IDLE = 50;
const PHASE_FRAMES = CAPTIONS * INTERVAL + IDLE;
const ALL = [
    { id: 'R2', style: 'rollup',     setup: (e) => { e.setStyle('rollup'); e.setControlRepeat(2); } },
    { id: 'RP', style: 'rollup_pac', setup: (e) => { e.setStyle('rollup_pac'); e.setControlRepeat(2); } },
    { id: 'R1', style: 'rollup',     setup: (e) => { e.setStyle('rollup'); e.setControlRepeat(1); } },
    { id: 'P2', style: 'popon',      setup: (e) => { e.setStyle('popon'); e.setControlRepeat(2); } },
    { id: 'P1', style: 'popon',      setup: (e) => { e.setStyle('popon'); e.setControlRepeat(1); } },
    { id: 'PF', style: 'popon',      setup: (e) => { e.setStyle('popon'); e.setControlRepeat(2); e.setOneFrame({ enabled: true, maxPairs: 19, copies: 3, copyGap: 4 }); } },
    { id: 'PA', style: 'painton',    setup: (e) => { e.setStyle('painton'); e.setControlRepeat(2); } },
];
const PHASES = phaseArg === 'all' ? ALL : ALL.filter(p => phaseArg.split(',').includes(p.id));
const FIRST = ['quick brown fox jumps', 'select board of the', 'public comment on the', 'all those in favor', 'report from the town', 'the next item is the', 'thank you madam chair', 'we now take a short'];
const SECOND = ['over the lazy dog', 'town of brookline', 'capital plan tonight', 'say aye motion carries', 'administrator on water', 'school budget for next', 'for that update today', 'recess of five minutes'];

const tmp = outFile + '.h264';
execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', inFile, '-map', '0:v:0', '-c:v', 'copy', '-bsf:v', 'h264_mp4toannexb', '-f', 'h264', tmp]);
const h264 = readFileSync(tmp);

const builder = new Cea708CdpBuilder();
let enc = null, phaseIdx = -1;
const sent = [];
function ccDataForFrame(frameIdx) {
    const p = Math.floor(frameIdx / PHASE_FRAMES);
    if (p !== phaseIdx && p < PHASES.length) { phaseIdx = p; enc = new Cea608Encoder(); PHASES[p].setup(enc); }
    if (p >= PHASES.length) enc = null;
    const inPhase = frameIdx % PHASE_FRAMES;
    if (enc && inPhase % INTERVAL === 0 && inPhase / INTERVAL < CAPTIONS) {
        const n = inPhase / INTERVAL + 1;
        const text = `${PHASES[p].id}-${String(n).padStart(2, '0')} ${FIRST[n % FIRST.length]} ${SECOND[n % SECOND.length]} ${n % 2 ? PHASES[p].id.toLowerCase() : PHASES[p].id}.`;
        enc.enqueueText(text);
        sent.push({ frame: frameIdx, t: (frameIdx / 29.97).toFixed(2), text, phase: PHASES[p].id, style: PHASES[p].style });
    }
    const pairs = enc ? enc.drainPairs() : [{ cc1: 0x80, cc2: 0x80 }];
    const cdp = builder.buildCDP(pairs, FPS);
    if (cdp[7] !== 0x72) throw new Error('unexpected CDP layout');
    const count = cdp[8] & 0x1F;
    return Buffer.from(cdp.subarray(9, 9 + count * 3));
}

function buildSei(ccData) {
    const count = ccData.length / 3;
    const payload = Buffer.concat([
        Buffer.from([0xB5, 0x00, 0x31, 0x47, 0x41, 0x39, 0x34, 0x03, 0xC0 | count, 0xFF]),
        ccData,
        Buffer.from([0xFF]),
    ]);
    const body = Buffer.concat([Buffer.from([0x04, payload.length]), payload, Buffer.from([0x80])]);
    const out = [0x06];
    let z = 0;
    for (const b of body) {
        if (z >= 2 && b <= 3) { out.push(3); z = 0; }
        out.push(b);
        z = b === 0 ? z + 1 : 0;
    }
    return Buffer.from(out);
}

const starts = [];
for (let p = 0; p + 3 < h264.length; p++) if (h264[p] === 0 && h264[p + 1] === 0 && h264[p + 2] === 1) { starts.push(p + 3); p += 2; }
const nals = starts.map((s, i) => { let e = i + 1 < starts.length ? starts[i + 1] - 3 : h264.length; while (e > s && h264[e - 1] === 0) e--; return h264.subarray(s, e); });
const isCaptionSei = (nal) => (nal[0] & 0x1F) === 6 && nal.includes(Buffer.from('GA94', 'latin1'));
const SC = Buffer.from([0, 0, 0, 1]);
const chunks = [];
let frame = 0;
for (const nal of nals) {
    const type = nal[0] & 0x1F;
    if (isCaptionSei(nal)) continue;
    if ((type === 1 || type === 5) && (nal[1] & 0x80)) { chunks.push(SC, buildSei(ccDataForFrame(frame))); frame++; }
    chunks.push(SC, nal);
}
writeFileSync(tmp, Buffer.concat(chunks));
// keep the source's AAC audio (YouTube needs an audio track); the source may be longer than the phases
execFileSync('ffmpeg', ['-y', '-v', 'error', '-r', '30000/1001', '-i', tmp, '-i', inFile, '-map', '0:v', '-map', '1:a:0', '-c', 'copy', '-movflags', '+faststart', outFile]);
unlinkSync(tmp);
writeFileSync(outFile + '.sent.json', JSON.stringify({ columns: 32, rows: 2, phases: PHASES.map(p => ({ id: p.id, style: p.style })), captions: sent }, null, 1));
console.log(`${outFile}: ${frame} frames, ${sent.length} captions in ${PHASES.length} phases of ${PHASE_FRAMES} frames (${PHASES.map(p => p.id).join(' ')}); schedule in ${outFile}.sent.json`);
