/**
 * Municipality Wizard — fully local path (no Gemini / Google Search).
 *
 * Uses DuckDuckGo's key-free HTML results to find the official site and the
 * pages that matter, reads the ones that allow it, and extracts names with the
 * local Ollama brain. Sites that block automated readers (Cloudflare) can't be
 * read without a browser; search snippets still give the headline names, and
 * the operator is told to upload the agenda PDF for full coverage.
 *
 * Emits the same SSE events as the Gemini path (status / sources / research_start
 * / group / done) so the wizard UI is unchanged.
 */

import { fetchPage, htmlToText, extractPdfText, extractTitle, titleFromUrl, normalizeUrl, discoverLinks, categorizeUrl, mapLimit, itemsToEntries, decodeEntities } from './context-sources.js';
import { extractItemsWithOllama, ollamaJson, getBrainConfig } from './local-llm.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const SKIP_HOSTS = /wikipedia\.org|facebook\.com|twitter\.com|x\.com|instagram\.com|linkedin\.com|youtube\.com|yelp\.com|tripadvisor|zillow|realtor|niche\.com|ballotpedia|patch\.com|nextdoor|tiktok|reddit\.com|amazon\.com|google\.com|mapquest|yellowpages|indeed\.com|glassdoor|mma\.org|masscivics|duckduckgo/i;

/** DuckDuckGo HTML search → [{title, url, snippet}] (no key, light use only). */
export async function ddgSearch(query, { max = 8 } = {}) {
    const res = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), {
        headers: { 'User-Agent': UA, 'Accept': 'text/html' }, signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`search returned HTTP ${res.status}`);
    const html = await res.text();
    const out = [];
    const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]+class="result__a"|<div class="nav-links"|$)/g;
    let m;
    while ((m = re.exec(html)) !== null && out.length < max) {
        let url = m[1];
        const u = url.match(/uddg=([^&]+)/);
        if (u) { try { url = decodeURIComponent(u[1]); } catch {} }
        if (!/^https?:\/\//.test(url)) continue;
        const title = decodeEntities(m[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
        const snipM = m[3].match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
        const snippet = snipM ? decodeEntities(snipM[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim() : '';
        out.push({ title, url: normalizeUrl(url), snippet });
    }
    return out;
}

// Things small models like to "extract" from a town website that are useless (or
// harmful) as caption corrections: web tools, nav labels, floors, zip codes, the
// town's own name with a state/zip suffix.
const JUNK_NAMES = /^(zoom|microsoft teams|teams|webex|youtube|facebook|twitter|x|instagram|google|google maps|civicclerk|civicplus|civic clerk|granicus|legistar|municode|ecode360|accela|adobe|adobe acrobat|pdf|home|menu|search|login|sign in|contact us|online payments?|online permits?|e-?mail|website|skip to main content|read more|learn more|click here)$/i;
function isWizardJunk(it) {
    const n = String(it.name || '').trim();
    if (n.length < 2 || n.length > 60) return true;
    if (JUNK_NAMES.test(n)) return true;
    if (/^\d+(st|nd|rd|th)\s+floor$/i.test(n)) return true;          // "5th Floor"
    if (/\b\d{5}(-\d{4})?\b/.test(n)) return true;                     // zip codes
    if (/^(room|suite|floor|fl\.?)\s*\d+/i.test(n)) return true;      // "Room 204"
    if (/^\d{1,2}:\d{2}\s*(am|pm)?$/i.test(n)) return true;           // times
    if (/^(https?:\/\/|www\.)/i.test(n) || /\.(com|org|gov|net|edu)$/i.test(n)) return true; // URLs / domains
    if (/^[\d\s.,-]+$/.test(n)) return true;                           // bare numbers
    if (/^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?$/i.test(n)) return true;
    return false;
}

function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } }

/**
 * Find the official site and useful pages without Gemini.
 * Returns { ok, officialHost, sources, snippets, crawlNote, error? }.
 */
export async function locateMunicipalityLocally(query, onProgress = () => {}) {
    const queries = [
        `${query} official town OR city website`,
        `${query} select board OR city council OR town council members`,
        `${query} boards and commissions`,
        `${query} departments staff directory`,
        `${query} school committee members`,
    ];
    onProgress('searching', { message: `Searching the web for ${query}'s official pages…` });
    const results = [];
    const searched = await mapLimit(queries, 2, q => ddgSearch(q).catch(e => ({ error: e.message })));
    for (const r of searched) { if (Array.isArray(r)) results.push(...r); }
    if (results.length === 0) return { ok: false, error: 'Web search returned nothing (offline, or the search service is throttling). You can still paste a URL into the Scrape URL tool or upload an agenda PDF.', sources: [], snippets: [] };

    // Official host = most frequent gov-ish host among results
    const hostScore = new Map();
    for (const r of results) {
        const h = hostOf(r.url);
        if (!h || SKIP_HOSTS.test(h)) continue;
        const bonus = /\.(gov|us|gov\.[a-z]{2}|ca)$/i.test(h) ? 3 : /\.org$/i.test(h) ? 1 : 0;
        hostScore.set(h, (hostScore.get(h) || 0) + 1 + bonus);
    }
    let officialHost = null, best = 0;
    for (const [h, s] of hostScore) if (s > best) { officialHost = h; best = s; }

    const seen = new Set();
    const sources = [];
    for (const r of results) {
        const h = hostOf(r.url);
        if (!h || SKIP_HOSTS.test(h)) continue;
        const isPortal = /civicclerk|legistar|granicus|novusagenda|boarddocs/i.test(h);
        if (officialHost && h !== officialHost && !h.endsWith('.' + officialHost) && !isPortal) continue;
        if (seen.has(r.url)) continue;
        seen.add(r.url);
        const { type, score } = categorizeUrl(r.url, r.title);
        sources.push({ title: r.title.replace(/\s*[|\-–]\s*[^|\-–]*$/, '').trim() || titleFromUrl(r.url), url: r.url, type, score, why: 'Found by web search', snippet: r.snippet });
    }

    let crawlNote = null;
    if (officialHost) {
        onProgress('crawling', { message: `Scanning ${officialHost} for officials, departments and meetings pages…`, host: officialHost });
        const home = await fetchPage(`https://${officialHost}/`, { timeoutMs: 10000 });
        if (home.ok && home.contentType.includes('html')) {
            for (const l of discoverLinks(home.finalUrl, home.buffer.toString('utf8'), { max: 30 })) {
                if (seen.has(l.url)) continue;
                seen.add(l.url);
                sources.push({ ...l, why: `Linked from ${officialHost} homepage` });
            }
        } else if (home.blocked) {
            crawlNote = `${officialHost} blocks automated readers (HTTP ${home.status}). In local mode those pages can't be read — names below come from search results and what the model already knows. Upload the agenda PDF for full coverage.`;
        }
    }

    sources.sort((a, b) => (b.score || 0) - (a.score || 0));
    const top = sources.slice(0, 12);
    onProgress('titling', { message: `Checking ${top.length} pages…`, count: top.length });
    await mapLimit(top, 6, async (s) => {
        const r = await fetchPage(s.url, { timeoutMs: 7000, maxBytes: 200 * 1024 });
        if (r.ok && r.contentType.includes('html')) { const t = extractTitle(r.buffer.toString('utf8')); if (t) s.title = t.replace(/\s*[|\-–]\s*[^|\-–]*$/, '').trim() || t; s.reachable = true; }
        else if (r.ok && r.contentType.includes('pdf')) { s.isPdf = true; s.reachable = true; }
        else { s.reachable = false; s.blocked = !!r.blocked; if (r.status === 404) s.dead = true; }
        return s;
    });
    const byTitle = new Set();
    const finalSources = [];
    for (const s of top) {
        if (s.dead) continue;
        const k = `${s.type}|${s.title.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
        if (byTitle.has(k)) continue;
        byTitle.add(k);
        const { score, ...rest } = s;
        finalSources.push(rest);
    }
    const snippets = results.filter(r => r.snippet && !SKIP_HOSTS.test(hostOf(r.url))).map(r => `${r.title}: ${r.snippet}`);
    return { ok: true, officialHost, sources: finalSources, snippets, crawlNote };
}

const CATEGORY_GROUP = {
    elected_official: 'people', board_member: 'people', staff: 'people',
    board_or_committee: 'bodies', department: 'bodies', organization: 'bodies',
    place: 'places', neighborhood: 'places', street: 'places', park: 'places', school: 'places', facility: 'places',
    acronym: 'acronyms', term: 'acronyms',
};
const GROUP_LABELS = { people: 'Elected officials & staff', bodies: 'Boards, committees & organizations', places: 'Places, streets & schools', acronyms: 'Acronyms & local terms' };

/**
 * Full local research run. `emit(phase, data)` receives the same events the
 * Gemini path emits.
 */
export async function researchMunicipalityLocally(query, { emit = () => {}, maxPages = 6 } = {}) {
    const brain = getBrainConfig();
    const start = Date.now();
    emit('research_start', { groups: Object.entries(GROUP_LABELS).map(([key, label]) => ({ key, label })) });

    // 1. Locate
    const loc = await locateMunicipalityLocally(query, (phase, data) => emit('status', { step: 'locate', phase, message: data.message || '' }));
    if (!loc.ok) {
        emit('sources', { officialHost: null, sources: [], error: loc.error, elapsedMs: Date.now() - start });
        emit('error', { error: loc.error });
        return { ok: false };
    }
    emit('sources', { officialHost: loc.officialHost, sources: loc.sources, crawlNote: loc.crawlNote, elapsedMs: Date.now() - start });

    const allItems = new Map();
    const addItems = (items) => {
        for (const it of items || []) {
            if (!it || typeof it.name !== 'string' || isWizardJunk(it)) continue;
            const k = it.name.toLowerCase();
            if (!allItems.has(k)) allItems.set(k, it);
            else if (!allItems.get(k).detail && it.detail) allItems.get(k).detail = it.detail;
        }
    };

    // 2. Search snippets are free text we always have (even when pages are blocked)
    if (loc.snippets.length) {
        emit('status', { step: 'research', message: `Reading ${loc.snippets.length} search results with ${brain.model}…` });
        try { addItems((await extractItemsWithOllama(loc.snippets.join('\n'), { url: brain.url, model: brain.model, domainHint: `web search results about ${query}` })).items); }
        catch (e) { emit('status', { step: 'research', message: `Search results: ${e.message}` }); }
    }

    // 3. Read the pages we can reach (sequentially — one local GPU)
    const readable = loc.sources.filter(s => s.reachable).slice(0, maxPages);
    for (let i = 0; i < readable.length; i++) {
        const s = readable[i];
        emit('status', { step: 'research', message: `Reading ${hostOf(s.url)}${(() => { try { return new URL(s.url).pathname; } catch { return ''; } })()} (${i + 1}/${readable.length}) with ${brain.model}…` });
        try {
            const page = await fetchPage(s.url, { timeoutMs: 15000 });
            if (!page.ok) continue;
            const isPdf = page.contentType.includes('pdf') || page.buffer.subarray(0, 5).toString() === '%PDF-';
            const text = isPdf ? (await extractPdfText(page.buffer)).text : htmlToText(page.buffer.toString('utf8'));
            if (text.length < 200) continue;
            addItems((await extractItemsWithOllama(text.slice(0, 18000), { url: brain.url, model: brain.model, domainHint: `a page from the official website of ${query}` })).items);
        } catch (e) {
            emit('status', { step: 'research', message: `${hostOf(s.url)}: ${e.message}` });
        }
    }

    // 4. What the model already knows (well-known places, schools, acronyms)
    emit('status', { step: 'research', message: `Asking ${brain.model} about well-known places and acronyms in ${query}…` });
    try {
        const r = await ollamaJson({
            url: brain.url, model: brain.model, maxTokens: 2500,
            prompt: `List well-known proper nouns for the municipality "${query}" that come up in its public meetings: neighborhoods and villages, squares, major streets and routes, parks, public schools and the school district, municipal buildings, neighboring towns and the county, regional bodies (transit, water, regional schools), and common municipal acronyms used in that state with their expansions.
Only include items you are confident really exist; never invent people's names.
Respond with ONLY this JSON object: {"items":[{"name":"<exact spelling>","category":"<place|school|neighborhood|street|park|organization|acronym|term>","detail":"<short context or expansion>","misheard":["<0-2 plausible lowercase speech-to-text errors>"]}]}`,
        });
        const list = Array.isArray(r.parsed?.items) ? r.parsed.items : Array.isArray(r.parsed) ? r.parsed : [];
        addItems(list.filter(it => it && typeof it.name === 'string').map(it => ({
            name: it.name.trim(), category: typeof it.category === 'string' ? it.category : 'place',
            detail: typeof it.detail === 'string' ? it.detail.trim().slice(0, 140) : '',
            misheard: Array.isArray(it.misheard) ? it.misheard.map(m => String(m).toLowerCase().trim()).filter(Boolean).slice(0, 2) : [],
        })));
    } catch (e) {
        emit('status', { step: 'research', message: `Knowledge pass: ${e.message}` });
    }

    // 5. Bucket into the wizard's groups and emit
    const groups = { people: [], bodies: [], places: [], acronyms: [] };
    for (const it of allItems.values()) {
        const g = CATEGORY_GROUP[it.category] || (/^[A-Z][A-Z0-9&.]{1,7}$/.test(it.name) ? 'acronyms' : 'bodies');
        groups[g].push({ ...it, entries: itemsToEntries([it]) });
    }
    let totalItems = 0, totalEntries = 0;
    for (const [key, items] of Object.entries(groups)) {
        const kept = items.filter(it => it.entries.length > 0);
        totalItems += kept.length;
        totalEntries += kept.reduce((n, it) => n + it.entries.length, 0);
        emit('group', { key, label: GROUP_LABELS[key], ok: true, elapsedMs: Date.now() - start, items: kept, engine: `ollama:${brain.model}` });
    }
    emit('done', { totalItems, totalEntries, totalMs: Date.now() - start, engine: `ollama:${brain.model}` });
    return { ok: true, totalItems, totalEntries };
}
