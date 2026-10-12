/**
 * Context Sources
 *
 * Everything the Context Engine needs to turn *sources* (PDFs, DOCX files,
 * web pages, a municipality name) into text or dictionary entries:
 *
 *   - extractPdfText(buffer)         pdf-parse v2 (class API) wrapper
 *   - extractDocxText(buffer)        minimal .docx reader (no extra deps)
 *   - htmlToText(html)               readable text from HTML
 *   - fetchPage(url)                 browser-like fetch with timeout
 *   - resolveRedirect(url)           follow Google grounding redirect URLs
 *   - discoverLinks(url, html)       find relevant sub-pages on a site
 *   - locateMunicipalitySources()    Gemini + Google Search → real page URLs
 *   - researchMunicipality()         Gemini + Google Search → names/places/acronyms
 *   - extractDictionaryFromUrl()     Gemini urlContext tool (works on sites that
 *                                    block server-side fetches, e.g. Cloudflare)
 *   - itemsToEntries()               research items → dictionary entries
 *
 * All network calls have timeouts; nothing here ever throws on a bad page —
 * callers get { ok:false, error } style results so the UI can show progress.
 */

import zlib from 'zlib';
// Static imports so esbuild bundles pdf-parse (and pdfjs) into the standalone
// binary; a runtime require() is not resolvable inside the pkg snapshot.
import * as pdfParseModule from 'pdf-parse';
// pdfjs normally loads its worker with a dynamic import(), which the pkg
// snapshot cannot perform ("A dynamic import callback was not specified").
// pdfjs checks globalThis.pdfjsWorker first, so preload the worker module
// statically. The pdfjs-dist version must match the one pdf-parse embeds.
import * as pdfjsWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs';
if (!globalThis.pdfjsWorker) globalThis.pdfjsWorker = pdfjsWorker;

export const GEMINI_TEXT_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
};

// ---------------------------------------------------------------------------
// Document text extraction
// ---------------------------------------------------------------------------

let _pdfParse = null;
function loadPdfParse() {
    if (_pdfParse !== null) return _pdfParse;
    try {
        const mod = pdfParseModule;
        // v2.x exports a PDFParse class; v1.x exported a function (default).
        const PDFParse = mod?.PDFParse || mod?.default?.PDFParse;
        if (typeof PDFParse === 'function') {
            _pdfParse = { kind: 'v2', PDFParse };
        } else if (typeof mod?.default === 'function') {
            _pdfParse = { kind: 'v1', fn: mod.default };
        } else {
            _pdfParse = false;
        }
    } catch (e) {
        console.warn('[Sources] pdf-parse not available:', e.message);
        _pdfParse = false;
    }
    return _pdfParse;
}

export function pdfSupportAvailable() {
    return !!loadPdfParse();
}

/**
 * Extract plain text from a PDF buffer. Returns { text, pages }.
 * Throws with a readable message if the PDF cannot be parsed.
 */
export async function extractPdfText(buffer) {
    const pp = loadPdfParse();
    if (!pp) throw new Error('PDF parsing is not available on this server (pdf-parse missing)');
    if (pp.kind === 'v2') {
        const parser = new pp.PDFParse({ data: buffer });
        try {
            const result = await parser.getText();
            return { text: (result?.text || '').trim(), pages: result?.total || 0 };
        } finally {
            try { await parser.destroy(); } catch {}
        }
    }
    const result = await pp.fn(buffer);
    return { text: (result?.text || '').trim(), pages: result?.numpages || 0 };
}

/**
 * Minimal .docx reader: unzips word/document.xml and strips the XML.
 * Enough for agendas, minutes and rosters without pulling in a dependency.
 */
export function extractDocxText(buffer) {
    const xml = readZipEntry(buffer, 'word/document.xml');
    if (!xml) throw new Error('Not a valid .docx file (word/document.xml missing)');
    const text = xml
        .replace(/<w:tab\/>/g, '\t')
        .replace(/<\/w:p>/g, '\n')
        .replace(/<w:br\/>/g, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return { text };
}

function readZipEntry(buf, wantedName) {
    // Locate End Of Central Directory record (signature 0x06054b50)
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return null;
    const cdSize = buf.readUInt32LE(eocd + 12);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    let p = cdOffset;
    const end = Math.min(buf.length, cdOffset + cdSize);
    while (p + 46 <= end && buf.readUInt32LE(p) === 0x02014b50) {
        const method = buf.readUInt16LE(p + 10);
        const compSize = buf.readUInt32LE(p + 20);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const localOffset = buf.readUInt32LE(p + 42);
        const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
        if (name === wantedName) {
            if (buf.readUInt32LE(localOffset) !== 0x04034b50) return null;
            const lNameLen = buf.readUInt16LE(localOffset + 26);
            const lExtraLen = buf.readUInt16LE(localOffset + 28);
            const dataStart = localOffset + 30 + lNameLen + lExtraLen;
            const data = buf.subarray(dataStart, dataStart + compSize);
            if (method === 0) return data.toString('utf8');
            if (method === 8) return zlib.inflateRawSync(data).toString('utf8');
            return null;
        }
        p += 46 + nameLen + extraLen + commentLen;
    }
    return null;
}

/**
 * Extract text from an uploaded file based on its name/mimetype.
 * Returns { text, kind, pages? }.
 */
export async function extractUploadedText(buffer, filename = '', mimetype = '') {
    const lower = (filename || '').toLowerCase();
    const isPdf = mimetype.includes('pdf') || lower.endsWith('.pdf') || buffer.subarray(0, 5).toString() === '%PDF-';
    const isDocx = lower.endsWith('.docx') || mimetype.includes('officedocument.wordprocessingml');
    if (isPdf) {
        const r = await extractPdfText(buffer);
        return { ...r, kind: 'pdf' };
    }
    if (isDocx) {
        const r = extractDocxText(buffer);
        return { ...r, kind: 'docx' };
    }
    if (lower.endsWith('.doc')) {
        throw new Error('Legacy .doc files are not supported — save as .docx or PDF and try again');
    }
    if (lower.endsWith('.html') || lower.endsWith('.htm') || mimetype.includes('html')) {
        return { text: htmlToText(buffer.toString('utf8')), kind: 'html' };
    }
    return { text: buffer.toString('utf8').trim(), kind: 'text' };
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', ndash: '-', mdash: '-', hellip: '...', copy: '(c)', reg: '(R)', trade: '(TM)' };

export function decodeEntities(s) {
    return s
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
        .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}
function safeChar(code) {
    try { return String.fromCodePoint(code); } catch { return ''; }
}

/** Convert an HTML document into readable text, dropping chrome (nav/footer/scripts). */
export function htmlToText(html) {
    if (!html) return '';
    let s = html
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<(script|style|noscript|svg|template|iframe)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<(nav|header|footer|aside|form)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
    // Block-level elements → newlines so names/rows stay separated
    s = s.replace(/<\/(p|div|li|tr|h[1-6]|td|th|section|article|dd|dt|blockquote|pre)>/gi, '\n')
         .replace(/<(br|hr)\s*\/?>/gi, '\n');
    s = s.replace(/<[^>]+>/g, ' ');
    s = decodeEntities(s);
    s = s.replace(/\r\n?/g, '\n')
         .replace(/[ \t ]+/g, ' ')
         .replace(/ *\n */g, '\n')
         .replace(/\n{3,}/g, '\n\n')
         .trim();
    return s;
}

export function extractTitle(html) {
    const m = html && html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (!m) return '';
    return decodeEntities(m[1]).replace(/\s+/g, ' ').trim();
}

/** Turn "/343/Select-Board" or "boards-and-commissions" into "Select Board". */
export function titleFromUrl(url) {
    try {
        const u = new URL(url);
        const segs = u.pathname.split('/').filter(Boolean).filter(s => !/^\d+$/.test(s) && !/\.(aspx|php|html?)$/i.test(s) || /\.(aspx|php|html?)$/i.test(s));
        let last = segs[segs.length - 1] || u.hostname;
        last = decodeURIComponent(last).replace(/\.(aspx|php|html?)$/i, '').replace(/[-_+]/g, ' ');
        last = last.replace(/([a-z])([A-Z])/g, '$1 $2'); // AgendaCenter → Agenda Center
        if (/^\d+$/.test(last) || last === u.hostname) return u.hostname.replace(/^www\./, '') + (u.pathname === '/' ? ' (home page)' : '');
        return last.replace(/\b\w/g, c => c.toUpperCase()).trim() || u.hostname;
    } catch {
        return url;
    }
}

export function normalizeUrl(url) {
    try {
        const u = new URL(url);
        u.hash = '';
        for (const k of [...u.searchParams.keys()]) {
            if (/^(utm_|fbclid|gclid|ref$)/i.test(k)) u.searchParams.delete(k);
        }
        let s = u.toString();
        if (s.endsWith('/') && u.pathname !== '/') s = s.slice(0, -1);
        return s;
    } catch {
        return url;
    }
}

// ---------------------------------------------------------------------------
// Network helpers
// ---------------------------------------------------------------------------

/**
 * Fetch a page with browser-like headers. Never throws; returns
 * { ok, status, contentType, buffer?, html?, finalUrl, error? }.
 */
export async function fetchPage(url, { timeoutMs = 15000, maxBytes = 6 * 1024 * 1024 } = {}) {
    try {
        const res = await fetch(url, { headers: BROWSER_HEADERS, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
        const contentType = res.headers.get('content-type') || '';
        const finalUrl = res.url || url;
        if (!res.ok) {
            return { ok: false, status: res.status, contentType, finalUrl, blocked: res.status === 403 || res.status === 429 || res.status === 503, error: `HTTP ${res.status}` };
        }
        const ab = await res.arrayBuffer();
        const buffer = Buffer.from(ab.byteLength > maxBytes ? ab.slice(0, maxBytes) : ab);
        return { ok: true, status: res.status, contentType, finalUrl, buffer };
    } catch (e) {
        const msg = e?.name === 'TimeoutError' ? `Timed out after ${Math.round(timeoutMs / 1000)}s` : (e?.message || String(e));
        return { ok: false, status: 0, contentType: '', finalUrl: url, error: msg };
    }
}

/** Resolve a redirecting URL (Google grounding redirects) to its final URL. */
export async function resolveRedirect(url, timeoutMs = 8000) {
    if (!/vertexaisearch\.cloud\.google\.com|grounding-api-redirect|google\.com\/url/i.test(url)) return url;
    try {
        const res = await fetch(url, { method: 'HEAD', redirect: 'manual', headers: BROWSER_HEADERS, signal: AbortSignal.timeout(timeoutMs) });
        const loc = res.headers.get('location');
        if (loc) return new URL(loc, url).toString();
        if (res.url && res.url !== url) return res.url;
    } catch {}
    try {
        const res = await fetch(url, { method: 'GET', redirect: 'follow', headers: BROWSER_HEADERS, signal: AbortSignal.timeout(timeoutMs) });
        if (res.url && !/grounding-api-redirect/.test(res.url)) return res.url;
    } catch {}
    return null;
}

/** Run async tasks with limited concurrency, preserving order of results. */
export async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (true) {
            const i = next++;
            if (i >= items.length) return;
            try { results[i] = await fn(items[i], i); } catch (e) { results[i] = { error: e?.message || String(e) }; }
        }
    });
    await Promise.all(workers);
    return results;
}

// ---------------------------------------------------------------------------
// Link discovery & categorisation
// ---------------------------------------------------------------------------

const CATEGORY_RULES = [
    ['Officials',    /select.?board|city.?council|town.?council|board.?of.?alderm|alderm|mayor|councilor|councillor|elected|town.?meeting.?members|school.?committee|school.?board|county.?commission/i, 5],
    ['Departments',  /department|directory|staff|administration|town.?administrator|city.?manager|town.?manager|clerk|public.?works|police|fire|planning|finance|assessor|treasurer|health|library|recreation|building|engineering|human.?resources|it\b/i, 4],
    ['Committees',   /commission|committee|board|advisory|authority|trustees|zoning|appeals|conservation|historic|housing/i, 4],
    ['Meetings',     /agenda|minutes|meeting|calendar|hearing|civicclerk|legistar|granicus|novusagenda|boarddocs/i, 3],
    ['Places',       /parks?|schools?|neighborhood|village|square|library|facilit|cemeter/i, 2],
];

export function categorizeUrl(url, text = '') {
    const combined = `${url} ${text}`.toLowerCase();
    let best = 'General', bestScore = 0;
    for (const [cat, re, score] of CATEGORY_RULES) {
        if (re.test(combined) && score > bestScore) { best = cat; bestScore = score; }
    }
    return { type: best, score: bestScore };
}

const SKIP_HOSTS = /wikipedia\.org|facebook\.com|twitter\.com|x\.com|instagram\.com|linkedin\.com|youtube\.com|yelp\.com|tripadvisor|zillow|realtor|niche\.com|ballotpedia|patch\.com|nextdoor|tiktok|reddit\.com|amazon\.com|google\.com|mapquest|yellowpages|indeed\.com|glassdoor/i;
const SKIP_PATH = /\.(jpg|jpeg|png|gif|svg|webp|css|js|ico|zip|mp4|mp3|xml|rss)(\?|$)|\/(login|logout|signin|search|translate|rss|sitemap|privacy|terms|accessibility|contact-us|share)\b|^mailto:|^tel:|^javascript:/i;

/**
 * Pull same-site links that are likely to contain proper nouns.
 * Returns [{ title, url, type, score, isPdf }], highest score first.
 */
export function discoverLinks(pageUrl, html, { max = 40 } = {}) {
    const out = [];
    const seen = new Set();
    let base;
    try { base = new URL(pageUrl); } catch { return out; }
    const baseHost = base.hostname.replace(/^www\./, '');
    const re = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        let href = m[1].trim();
        const text = decodeEntities(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
        if (SKIP_PATH.test(href)) continue;
        let resolved;
        try { resolved = new URL(href, pageUrl); } catch { continue; }
        if (!/^https?:$/.test(resolved.protocol)) continue;
        const host = resolved.hostname.replace(/^www\./, '');
        const isPdf = /\.pdf(\?|$)/i.test(resolved.pathname);
        // Allow same site, or hosted agenda portals / PDFs linked from the site
        const isPortal = /civicclerk|legistar|granicus|novusagenda|boarddocs|civicplus|municode|ecode360/i.test(host);
        if (host !== baseHost && !host.endsWith('.' + baseHost) && !isPortal) continue;
        const key = normalizeUrl(resolved.toString());
        if (seen.has(key)) continue;
        if (!text || text.length < 3 || text.length > 90) continue;
        const { type, score } = categorizeUrl(key, text);
        if (score === 0 && !isPdf) continue;
        seen.add(key);
        out.push({ title: text, url: key, type, score: score + (isPdf ? 0.5 : 0), isPdf, why: `Linked from ${baseHost}` });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, max);
}

// ---------------------------------------------------------------------------
// Gemini helpers
// ---------------------------------------------------------------------------

async function getGenAI(apiKey) {
    const { GoogleGenAI } = await import('@google/genai');
    return new GoogleGenAI({ apiKey });
}

function parseJsonArray(raw) {
    if (!raw) return null;
    let s = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    try { const v = JSON.parse(s); return Array.isArray(v) ? v : (Array.isArray(v?.entries) ? v.entries : null); } catch {}
    const start = s.indexOf('['), end = s.lastIndexOf(']');
    if (start !== -1 && end > start) {
        try { const v = JSON.parse(s.slice(start, end + 1)); return Array.isArray(v) ? v : null; } catch {}
    }
    return null;
}

function withTimeout(promise, ms, label = 'request') {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms)),
    ]);
}

/**
 * Phase 1 of the wizard: find the official site and useful pages.
 * Returns { ok, officialHost, sources: [{title,url,type,why}], queries, error? }
 * `onProgress(phase, data)` is optional.
 */
export async function locateMunicipalitySources(query, apiKey, onProgress = () => {}) {
    if (!apiKey) return { ok: false, error: 'No Gemini API key', sources: [] };
    const ai = await getGenAI(apiKey);
    onProgress('searching', { message: `Searching Google for ${query}'s official website…` });

    let response;
    try {
        response = await withTimeout(ai.models.generateContent({
            model: GEMINI_TEXT_MODEL,
            contents: `Find the OFFICIAL government website for the municipality "${query}" (city, town, village or county).
List the most useful pages on that official site for learning the names used in public meetings:
- elected body (select board / city council / board of aldermen / county commission) members page
- school committee or school board members page
- town/city administration & department directory (department heads, chiefs, clerk, finance)
- boards and commissions index
- meeting agendas & minutes portal (CivicClerk, Legistar, Granicus, etc.)
For each page give: title, full URL, category. Prefer pages on the official .gov/.us/.org domain. Output a short markdown list with full URLs.`,
            config: { tools: [{ googleSearch: {} }], temperature: 0.1 },
        }), 40000, 'Google Search');
    } catch (e) {
        return { ok: false, error: e.message, sources: [] };
    }

    const text = response?.text || '';
    const meta = response?.candidates?.[0]?.groundingMetadata || {};
    const chunks = meta.groundingChunks || [];
    const queries = meta.webSearchQueries || [];

    // Candidate URLs: from the model's text (real URLs) + grounding chunks (redirects)
    const candidates = new Map(); // normalized url → {title?, fromText}
    for (const u of (text.match(/https?:\/\/[^\s)<>"'\]]+/g) || [])) {
        const clean = u.replace(/[.,;:!?)*]+$/, '');
        const norm = normalizeUrl(clean);
        if (!candidates.has(norm)) candidates.set(norm, { fromText: true });
    }
    const redirectUris = chunks.map(c => c?.web?.uri).filter(Boolean);
    onProgress('resolving', { message: `Resolving ${redirectUris.length} search result links…`, count: redirectUris.length });
    const resolved = await mapLimit(redirectUris, 8, u => resolveRedirect(u));
    resolved.forEach((real, i) => {
        if (!real || typeof real !== 'string') return;
        const norm = normalizeUrl(real);
        const title = chunks[i]?.web?.title || '';
        if (!candidates.has(norm)) candidates.set(norm, { fromText: false, title });
        else if (title && !candidates.get(norm).title) candidates.get(norm).title = title;
    });

    // Pick the official host: most common non-social host, preferring gov-ish TLDs
    const hostCounts = new Map();
    for (const url of candidates.keys()) {
        try {
            const h = new URL(url).hostname.replace(/^www\./, '');
            if (SKIP_HOSTS.test(h)) continue;
            const bonus = /\.(gov|us|gov\.[a-z]{2}|ca)$/i.test(h) ? 3 : /\.org$/i.test(h) ? 1 : 0;
            hostCounts.set(h, (hostCounts.get(h) || 0) + 1 + bonus);
        } catch {}
    }
    let officialHost = null, bestCount = 0;
    for (const [h, c] of hostCounts) if (c > bestCount) { officialHost = h; bestCount = c; }

    // Build the source list from candidates on the official host (plus agenda portals)
    const sources = [];
    const seen = new Set();
    for (const [url, info] of candidates) {
        let host;
        try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { continue; }
        if (SKIP_HOSTS.test(host)) continue;
        const isPortal = /civicclerk|legistar|granicus|novusagenda|boarddocs/i.test(host);
        if (officialHost && host !== officialHost && !host.endsWith('.' + officialHost) && !isPortal) continue;
        if (seen.has(url)) continue;
        seen.add(url);
        const { type, score } = categorizeUrl(url, info.title || '');
        sources.push({ title: info.title && !/^[\w.-]+\.\w+$/.test(info.title) ? info.title : titleFromUrl(url), url, type, score, why: info.fromText ? 'Recommended by Google Search' : 'Found via Google Search' });
    }

    // Crawl the official homepage for extra well-known pages (if the site lets us)
    let crawlNote = null;
    if (officialHost) {
        onProgress('crawling', { message: `Scanning ${officialHost} for officials, departments and meetings pages…`, host: officialHost });
        const home = await fetchPage(`https://${officialHost}/`, { timeoutMs: 10000 });
        if (home.ok && home.contentType.includes('html')) {
            const links = discoverLinks(home.finalUrl, home.buffer.toString('utf8'), { max: 30 });
            for (const l of links) {
                if (seen.has(l.url)) continue;
                seen.add(l.url);
                sources.push({ ...l, why: `Linked from ${officialHost} homepage` });
            }
        } else if (home.blocked) {
            crawlNote = `${officialHost} blocks automated visitors (HTTP ${home.status}); pages will be read via Gemini instead.`;
        }
    }

    // Rank: category score, then prefer the official host, cap the list
    sources.sort((a, b) => (b.score || 0) - (a.score || 0));
    const top = sources.slice(0, 14);

    // Fetch real titles for pages we can reach (parallel, quick)
    onProgress('titling', { message: `Checking ${top.length} pages…`, count: top.length });
    await mapLimit(top, 6, async (s) => {
        const r = await fetchPage(s.url, { timeoutMs: 7000, maxBytes: 200 * 1024 });
        if (r.ok && r.contentType.includes('html')) {
            const t = extractTitle(r.buffer.toString('utf8'));
            if (t) s.title = t.replace(/\s*[|\-–]\s*[^|\-–]*$/, '').trim() || t;
            s.reachable = true;
        } else if (r.ok && r.contentType.includes('pdf')) {
            s.isPdf = true; s.reachable = true;
        } else {
            s.reachable = false;
            s.blocked = !!r.blocked;
            if (r.status === 404) s.dead = true;
        }
        s.title = s.title || titleFromUrl(s.url);
        return s;
    });

    // Drop dead pages, collapse near-duplicates (same title+type, e.g. /directory and
    // /directory.aspx) and hide bare home pages when there is anything better.
    const byTitle = new Set();
    const finalSources = [];
    for (const s of top) {
        if (s.dead) continue;
        const tkey = `${s.type}|${s.title.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
        if (byTitle.has(tkey)) continue;
        byTitle.add(tkey);
        const { score, ...rest } = s;
        finalSources.push(rest);
    }
    const nonHome = finalSources.filter(s => { try { return new URL(s.url).pathname.replace(/\/+$/, '') !== '' && !/\/\d+\/home$/i.test(s.url); } catch { return true; } });
    return { ok: true, officialHost, sources: nonHome.length >= 3 ? nonHome : finalSources, queries, crawlNote };
}

// Research groups run in parallel — each is one grounded Gemini call.
const RESEARCH_GROUPS = [
    {
        key: 'people',
        label: 'Elected officials & staff',
        categories: ['elected_official', 'board_member', 'staff'],
        ask: `every CURRENT member of the elected governing body (select board / city council / board of aldermen / county commission) with full names and roles; every CURRENT school committee / school board member; the town or city administrator / manager / mayor and deputies; department heads and chiefs (police chief, fire chief, public works director, town clerk, finance director, planning director, health director, library director, superintendent of schools, etc.); frequently appearing town counsel, moderator and assistant administrators`,
    },
    {
        key: 'bodies',
        label: 'Boards, committees & organizations',
        categories: ['board_or_committee', 'department', 'organization'],
        ask: `the official names of all boards, commissions, committees and authorities (e.g. Planning Board, Zoning Board of Appeals, Conservation Commission, Housing Authority, Advisory Committee); the official names of municipal departments and divisions; local organizations, non-profits, neighborhood associations, chambers of commerce, unions, local newspapers, cable/media centers and major employers or institutions that come up in meetings`,
    },
    {
        key: 'places',
        label: 'Places, streets & schools',
        categories: ['place', 'neighborhood', 'street', 'park', 'school', 'facility'],
        ask: `villages, neighborhoods and squares; the major streets, avenues and routes; parks, playgrounds, reservoirs, cemeteries and recreation facilities; every public school and the school district name; municipal buildings (town hall, library branches, senior center, DPW yard, fire stations); neighboring municipalities, the county, and regional bodies (transit authority, regional school district, water/sewer authority)`,
    },
    {
        key: 'acronyms',
        label: 'Acronyms & local terms',
        categories: ['acronym', 'term'],
        ask: `acronyms and abbreviations commonly used in this municipality's public meetings with their expansions (e.g. DPW, ZBA, CPA, CIP, FY, OPEB, MBTA, MSBA, ADA, DEP, MGL chapters, override, Proposition 2½, warrant articles), and local-government terms specific to the state or municipality (e.g. Town Meeting, Select Board, Advisory Committee, warrant article, special permit, 40B)`,
    },
];

export function getResearchGroups() {
    return RESEARCH_GROUPS.map(({ key, label, categories }) => ({ key, label, categories }));
}

/**
 * Phase 2 of the wizard: research the municipality with Google Search grounding
 * and return raw items grouped by category. Calls onGroup(groupKey, result) as
 * each group finishes so the UI can stream.
 */
export async function researchMunicipality(query, apiKey, { onGroup = () => {}, groups = RESEARCH_GROUPS.map(g => g.key), domainHint = '' } = {}) {
    if (!apiKey) return { ok: false, error: 'No Gemini API key', items: [] };
    const ai = await getGenAI(apiKey);
    const selected = RESEARCH_GROUPS.filter(g => groups.includes(g.key));

    const results = await Promise.all(selected.map(async (group) => {
        const started = Date.now();
        const prompt = `You are building a live-captioning correction dictionary for public meetings of the municipality "${query}"${domainHint ? ` (focus: ${domainHint})` : ''}.
Use Google Search to find CURRENT, factual information. Research: ${group.ask}.

Return ONLY a JSON array. Each element: {"name": "<exact proper spelling>", "category": "<one of: ${group.categories.join(', ')}>", "detail": "<role, expansion or one-line context>", "misheard": ["<1-3 ways a speech-to-text engine might mis-transcribe this name, lowercase>"]}.
Rules:
- Only include real items you found evidence for. Never invent names.
- Use the exact official spelling and capitalization (e.g. "Bernard W. Greene", "Zoning Board of Appeals", "Coolidge Corner").
- For people give full names; put titles in "detail", not in "name".
- "misheard" should contain plausible phonetic errors (e.g. "Pham" → "fam", "Greene" → "green", "Buono" → "bono"); leave it empty when the name is spelled the way it sounds.
- Aim for 25-60 entries for this group.`;
        try {
            const response = await withTimeout(ai.models.generateContent({
                model: GEMINI_TEXT_MODEL,
                contents: prompt,
                config: { tools: [{ googleSearch: {} }], temperature: 0.1 },
            }), 75000, `${group.label} research`);
            const arr = parseJsonArray(response?.text) || [];
            const items = arr
                .filter(it => it && typeof it.name === 'string' && it.name.trim().length >= 2)
                .map(it => ({
                    name: it.name.trim().replace(/\s+/g, ' '),
                    category: group.categories.includes(it.category) ? it.category : group.categories[0],
                    detail: typeof it.detail === 'string' ? it.detail.trim().slice(0, 140) : '',
                    misheard: Array.isArray(it.misheard) ? it.misheard.filter(m => typeof m === 'string').map(m => m.trim().toLowerCase()).filter(Boolean).slice(0, 3) : [],
                    group: group.key,
                }));
            const meta = response?.candidates?.[0]?.groundingMetadata || {};
            const out = { key: group.key, label: group.label, ok: true, items, elapsedMs: Date.now() - started, queries: meta.webSearchQueries || [] };
            onGroup(group.key, out);
            return out;
        } catch (e) {
            const out = { key: group.key, label: group.label, ok: false, items: [], error: e.message, elapsedMs: Date.now() - started };
            onGroup(group.key, out);
            return out;
        }
    }));

    const items = results.flatMap(r => r.items);
    return { ok: results.some(r => r.ok), groups: results, items };
}

/**
 * Ask Gemini to read a URL itself (urlContext tool) and extract dictionary
 * entries. Used when our own fetch is blocked (403) or the page is a JS app.
 */
export async function extractDictionaryFromUrl(url, apiKey, { timeoutMs = 45000 } = {}) {
    if (!apiKey) return { ok: false, error: 'No Gemini API key', entries: [] };
    const ai = await getGenAI(apiKey);
    try {
        const response = await withTimeout(ai.models.generateContent({
            model: GEMINI_TEXT_MODEL,
            contents: `Read the page at ${url} .
Extract every proper noun that matters for live-caption accuracy: people's full names (with roles), board/committee/department names, place names, streets, schools, organizations, and acronyms (with expansions).
Return ONLY a JSON array of {"name": "<exact spelling>", "category": "<elected_official|staff|board_or_committee|department|organization|place|school|acronym|term>", "detail": "<role or expansion>", "misheard": ["<plausible speech-to-text errors, lowercase>"]}.
Only include items that actually appear on the page. If the page could not be read, return [].`,
            config: { tools: [{ urlContext: {} }], temperature: 0.1 },
        }), timeoutMs, 'Gemini page read');
        const status = response?.candidates?.[0]?.urlContextMetadata?.urlMetadata?.[0]?.urlRetrievalStatus || '';
        const arr = parseJsonArray(response?.text) || [];
        if (status && !/SUCCESS/i.test(status) && arr.length === 0) {
            return { ok: false, error: `Gemini could not read the page (${status.replace('URL_RETRIEVAL_STATUS_', '').toLowerCase()})`, entries: [] };
        }
        const items = arr.filter(it => it && typeof it.name === 'string').map(it => ({
            name: it.name.trim(), category: it.category || 'proper_noun', detail: it.detail || '',
            misheard: Array.isArray(it.misheard) ? it.misheard.map(m => String(m).toLowerCase().trim()).filter(Boolean).slice(0, 3) : [],
        }));
        return { ok: true, entries: itemsToEntries(items), items, retrieval: status };
    } catch (e) {
        return { ok: false, error: e.message, entries: [] };
    }
}

// ---------------------------------------------------------------------------
// Research items → dictionary entries
// ---------------------------------------------------------------------------

// Single common English words must never be used as a bare "original" — a rule
// like "green → Greene" would rewrite every "green" in the captions.
const COMMON_WORDS = new Set(`the of and to in a is that for it as was with be by on not he i this are or his from at which but have an had they you were their one all we can her has there been if more when will would who so no she my them what up out about into than its time only could other these two may then do first any like now over such our man me even most made after also did many before must through back years where much your way well down should because each just those people mr how too little state good very make world still own see men work long get here between both life being under never day same another know while last might us great old year off come since against go came right used take three states himself few house use during without again place american around however home small found mrs thought went say part once general high upon school every don't does got united left number course war until always away something fact though water less public put think almost hand enough far took head yet government system better set told nothing night end why called didn't eyes find going look asked later knew point next program city business give group toward young days let room president side social given present several order national possible rather second face per among form important often things looked early white case become large big need four within felt along children saw best church ever least power development light thing seemed family interest want members mind country area others turned although open god service problem certain kind began different door thus help means sense whole matter perhaps itself times human law line above name example action company hands local show whether five history gave either act today feet across taken anything past quite having seen death experience half really week words car field already themselves information tell college together shall held sure know turn full moved mean necessary free control board street road park town hall center hill lake river north south east west new old main first second third high low green white black brown gray grey blue red gold silver rose lake hill park church bridge mill wood woods field spring summer fall winter stone rock chief clerk director member members board officer chair vice mayor council committee commission department public works school schools fire police health library water sewer planning budget meeting minutes agenda article warrant vote motion second question item report update discussion approval approve approved review`.split(/\s+/));

const CATEGORY_TO_TYPE = {
    acronym: 'acronym', term: 'correction',
    place: 'place', neighborhood: 'place', street: 'place', park: 'place', school: 'place', facility: 'place',
};

// Web-page chrome and technical tokens that extraction sometimes returns from
// scraped pages. Never useful as caption corrections.
const JUNK_NAMES = new Set(['gov', 'com', 'org', 'net', 'edu', 'us', 'http', 'https', 'www', 'html', 'pdf', 'url', 'email', 'e-mail', 'login', 'logout', 'menu', 'search', 'home', 'faq', 'faqs', 'rss', 'api', 'css', 'javascript', 'cookie', 'cookies', 'copyright', 'skip to main content', 'skip to content', 'site map', 'sitemap', 'privacy policy', 'terms of use', 'accessibility', 'contact us', 'read more', 'learn more', 'click here', 'back to top', 'hypertext transfer protocol secure', 'hypertext transfer protocol', 'am', 'pm', 'et', 'est', 'edt', 'tbd', 'tba', 'na', 'n/a', 'id', 'ok']);

function isJunkName(name) {
    const n = name.toLowerCase().trim();
    if (JUNK_NAMES.has(n)) return true;
    if (/^https?:|^www\.|\.(gov|com|org|net|edu|us|io|html?|pdf|aspx|php)(\b|$)/i.test(n)) return true; // URLs / domains / file names
    if (/^[\d\s.,:/-]+$/.test(n)) return true;            // numbers, dates, times
    if (/^\$|^#\d|^page \d/i.test(n)) return true;         // money, page refs
    if (n.length > 80) return true;
    return false;
}

/**
 * Convert research/extraction items into dictionary entries:
 *   - lowercase form → correct form (the most common STT error is casing)
 *   - each plausible mishearing → correct form
 *   - acronyms also get a spelled-out "d p w" variant
 * Filters out dangerous single common-word originals and dedupes.
 */
export function itemsToEntries(items) {
    const entries = [];
    const seen = new Set();
    const push = (original, replacement, type, note) => {
        original = (original || '').toLowerCase().replace(/\s+/g, ' ').trim();
        replacement = (replacement || '').replace(/\s+/g, ' ').trim();
        if (!original || !replacement) return;
        if (original.length < 2 || original.length > 70 || replacement.length > 80) return;
        if (original === replacement.toLowerCase() && original === replacement) return; // nothing to fix
        const tokens = original.split(' ');
        if (tokens.length === 1 && COMMON_WORDS.has(original) && type !== 'acronym') return;
        if (tokens.length === 1 && original.length < 3 && type !== 'acronym') return;
        const key = `${original}→${replacement.toLowerCase()}`;
        if (seen.has(key)) return;
        seen.add(key);
        const e = { original, replacement, type };
        if (note) e.note = note;
        entries.push(e);
    };

    for (const it of items || []) {
        if (!it || !it.name) continue;
        const name = String(it.name).trim();
        if (isJunkName(name)) continue;
        const type = CATEGORY_TO_TYPE[it.category] || 'proper_noun';
        const note = it.detail ? String(it.detail).trim() : '';
        const isAcronym = type === 'acronym' || /^[A-Z][A-Z0-9&.]{1,7}$/.test(name);

        if (isAcronym) {
            const letters = name.replace(/[^A-Za-z0-9]/g, '');
            push(letters.toLowerCase(), name, 'acronym', note);
            if (letters.length >= 2 && letters.length <= 5) push(letters.toLowerCase().split('').join(' '), name, 'acronym', note);
            // "Department of Public Works" → "Department of Public Works" (casing) when detail is an expansion
            if (note && /^[A-Z][A-Za-z0-9&'’ .,-]{6,70}$/.test(note) && !/ (is|are|was|used|the) /i.test(note.slice(0, 20))) {
                push(note.toLowerCase(), note, 'proper_noun', `${name} expansion`);
            }
        } else {
            push(name.toLowerCase(), name, type, note);
            // Names with punctuation/initials: add the simplified spoken form
            const simple = name.replace(/\b[A-Z]\.\s*/g, '').replace(/[.,'’]/g, '').replace(/\s+/g, ' ').trim();
            if (simple && simple.toLowerCase() !== name.toLowerCase() && simple.split(' ').length >= 2) push(simple.toLowerCase(), name, type, note);
        }
        for (const mh of it.misheard || []) {
            if (!mh || mh === name.toLowerCase()) continue;
            push(mh, name, type, note);
        }
    }
    return entries;
}
