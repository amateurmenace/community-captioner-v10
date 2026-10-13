// sei-cc.mjs <capture.ts|.mp4|.flv|.h264> [--csv out.csv]
// Lists, per video frame, the CEA-608 field-1 pair and any DTVCC bytes found in the
// ATSC A/53 caption SEI (GA94 / user_data_type_code 3) of an H.264 stream.
// Also importable: extractFrames(file) → [{idx, idr, f1, f2, dtvcc, ccCount, raw}].
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function extractFrames(file) {
    let h264;
    if (file.endsWith('.h264') || file.endsWith('.264')) {
        h264 = readFileSync(file);
    } else {
        h264 = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:v:0', '-c:v', 'copy', '-bsf:v', 'h264_mp4toannexb', '-f', 'h264', '-'], { maxBuffer: 2 ** 31 });
    }

    // Split Annex B into NAL units
    const nals = [];
    const n = h264.length;
    const starts = [];
    for (let p = 0; p + 3 < n; p++) {
        if (h264[p] === 0 && h264[p + 1] === 0 && h264[p + 2] === 1) { starts.push(p + 3); p += 2; }
    }
    for (let s = 0; s < starts.length; s++) {
        let end = s + 1 < starts.length ? starts[s + 1] - 3 : n;
        while (end > starts[s] && h264[end - 1] === 0) end--;  // trailing zero bytes of the next start code
        nals.push(h264.subarray(starts[s], end));
    }

    function unescape(buf) {   // remove emulation prevention bytes
        const out = [];
        let z = 0;
        for (const b of buf) {
            if (z >= 2 && b === 3) { z = 0; continue; }
            out.push(b);
            z = b === 0 ? z + 1 : 0;
        }
        return out;
    }

    function parseSei(nal) {
        const d = unescape(nal.subarray(1));
        let p = 0;
        const found = [];
        while (p < d.length && d[p] !== 0x80) {
            let type = 0, size = 0;
            while (d[p] === 0xFF) { type += 255; p++; } type += d[p++];
            while (d[p] === 0xFF) { size += 255; p++; } size += d[p++];
            const payload = d.slice(p, p + size); p += size;
            if (type !== 4) continue;
            if (payload[0] !== 0xB5 || payload[1] !== 0x00 || payload[2] !== 0x31) continue;
            if (String.fromCharCode(...payload.slice(3, 7)) !== 'GA94' || payload[7] !== 0x03) continue;
            const flags = payload[8];
            const ccCount = flags & 0x1F;
            const process = !!(flags & 0x40);
            const trip = [];
            for (let k = 0; k < ccCount; k++) {
                const o = 10 + k * 3;
                trip.push([payload[o], payload[o + 1], payload[o + 2]]);
            }
            found.push({ ccCount, process, trip });
        }
        return found;
    }

    const frames = [];
    let frameIdx = -1;
    let pendingSei = [];
    for (const nal of nals) {
        const type = nal[0] & 0x1F;
        if (type === 6) { pendingSei.push(...parseSei(nal)); continue; }
        if (type === 1 || type === 5) {
            const firstMb = (nal[1] & 0x80) !== 0;  // ue(v) == 0 → first slice of a picture
            if (!firstMb) continue;
            frameIdx++;
            const f = { idx: frameIdx, idr: type === 5, f1: null, f2: null, dtvcc: [], ccCount: 0, raw: [] };
            for (const sei of pendingSei) {
                f.ccCount = sei.ccCount;
                for (const [h, a, b] of sei.trip) {
                    const valid = !!(h & 0x04), ct = h & 0x03;
                    f.raw.push([h, a, b]);
                    if (!valid) continue;
                    if (ct === 0) f.f1 = [a, b];
                    else if (ct === 1) f.f2 = [a, b];
                    else f.dtvcc.push(a, b);
                }
            }
            pendingSei = [];
            frames.push(f);
        }
    }
    return frames;
}

const strip = (b) => b & 0x7F;
export const isNullPair = (p) => !p || (strip(p[0]) === 0 && strip(p[1]) === 0);
export const pairText = (p) => {
    const a = strip(p[0]), b = strip(p[1]);
    if (a >= 0x10 && a <= 0x1F) return `<${a.toString(16)}${b.toString(16)}>`;
    const ch = (c) => c >= 0x20 && c < 0x7F ? String.fromCharCode(c) : c === 0 ? '' : `\\x${c.toString(16)}`;
    return ch(a) + ch(b);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const file = process.argv[2];
    const csvOut = process.argv.includes('--csv') ? process.argv[process.argv.indexOf('--csv') + 1] : null;
    const frames = extractFrames(file);
    let nonNull = 0, ctrl = 0, dtvccFrames = 0;
    const lines = [];
    let text = '';
    for (const f of frames) {
        if (!isNullPair(f.f1)) {
            nonNull++;
            const a = strip(f.f1[0]);
            if (a >= 0x10 && a <= 0x1F) ctrl++;
            text += pairText(f.f1);
        }
        if (f.dtvcc.length) dtvccFrames++;
        if (csvOut || !isNullPair(f.f1) || f.dtvcc.length) {
            lines.push(`${f.idx},${f.idr ? 'I' : 'P'},${f.ccCount},${f.f1 ? f.f1.map(b => b.toString(16).padStart(2, '0')).join('') : ''},${!isNullPair(f.f1) ? JSON.stringify(pairText(f.f1)) : ''},${f.dtvcc.map(b => b.toString(16).padStart(2, '0')).join('')}`);
        }
    }
    console.log(`${frames.length} frames; ${nonNull} with a non-null 608 field-1 pair (${ctrl} control codes); ${dtvccFrames} frames with DTVCC bytes`);
    console.log('608 text:', JSON.stringify(text));
    if (csvOut) writeFileSync(csvOut, 'frame,type,cc_count,f1hex,f1text,dtvcc\n' + lines.join('\n') + '\n');
    else console.log(lines.join('\n'));
}
