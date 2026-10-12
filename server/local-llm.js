/**
 * Local AI brain — Ollama as the Context Engine's extraction engine.
 *
 * When the operator finishes the Local Setup wizard with a model selected,
 * the relay stores {enabled, url, model} here and every extraction endpoint
 * (paste, PDF/DOCX upload, URL scrape, Auto-Learn) runs through Ollama first.
 * Gemini stays the engine for the Municipality Wizard (needs Google Search),
 * translation and caption polish.
 *
 *   getBrainConfig() / setBrainConfig()
 *   extractItemsWithOllama(text, {url, model})   → items [{name, category, detail, misheard}]
 *   extractEntriesWithOllama(text, cfg)          → dictionary entries (via itemsToEntries)
 *   testOllamaExtraction(model, url)             → runs the real prompt on a sample agenda
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { itemsToEntries } from './context-sources.js';
import { DATA_DIR } from './context-learner.js';

const DEFAULT_URL = 'http://127.0.0.1:11434';
let brain = { enabled: false, url: DEFAULT_URL, model: 'gemma3:4b' };
let loaded = false;

function brainFile() { return join(DATA_DIR, 'local', 'brain.json'); }

export function getBrainConfig() {
    if (!loaded) {
        loaded = true;
        try { if (existsSync(brainFile())) brain = { ...brain, ...JSON.parse(readFileSync(brainFile(), 'utf-8')) }; } catch {}
    }
    return { ...brain };
}

export function setBrainConfig(patch) {
    getBrainConfig();
    brain = { ...brain, ...patch };
    if (typeof brain.url !== 'string' || !brain.url) brain.url = DEFAULT_URL;
    try { mkdirSync(join(DATA_DIR, 'local'), { recursive: true }); writeFileSync(brainFile(), JSON.stringify(brain, null, 2)); } catch {}
    console.log(`[Brain] ${brain.enabled ? `enabled: ${brain.model} at ${brain.url}` : 'disabled'}`);
    return { ...brain };
}

/** True when extraction should go through Ollama. */
export function brainActive() {
    const b = getBrainConfig();
    return !!(b.enabled && b.model);
}

// ---------------------------------------------------------------------------
// Ollama calls
// ---------------------------------------------------------------------------

const capsCache = new Map();
async function modelCapabilities(model, url) {
    const key = `${url}|${model}`;
    if (capsCache.has(key)) return capsCache.get(key);
    try {
        const res = await fetch(`${url}/api/show`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }), signal: AbortSignal.timeout(10000) });
        const data = await res.json();
        const caps = Array.isArray(data.capabilities) ? data.capabilities : [];
        capsCache.set(key, caps);
        return caps;
    } catch { return []; }
}

const stripThinking = (s) => String(s || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

function parseJsonLoose(raw) {
    const s = stripThinking(raw);
    try { return JSON.parse(s); } catch {}
    const c = s.indexOf('{'), d = s.lastIndexOf('}');
    if (c !== -1 && d > c) { try { return JSON.parse(s.slice(c, d + 1)); } catch {} }
    const a = s.indexOf('['), b = s.lastIndexOf(']');
    if (a !== -1 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch {} }
    return null;
}

/**
 * Ask Ollama for JSON. Thinking models (Qwen3, gpt-oss, DeepSeek-R1) are told
 * not to think so the whole budget goes to the answer and it arrives fast.
 */
export async function ollamaJson({ url = DEFAULT_URL, model, prompt, maxTokens = 2048, timeoutMs = 180000, temperature = 0.1 }) {
    const caps = await modelCapabilities(model, url);
    const body = { model, prompt, stream: false, format: 'json', options: { temperature, num_predict: maxTokens, num_ctx: 8192 } };
    if (caps.includes('thinking')) body.think = false;
    const t0 = Date.now();
    const res = await fetch(`${url}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    return {
        parsed: parseJsonLoose(data.response),
        raw: data.response || '',
        latencyMs: Date.now() - t0,
        loadMs: data.load_duration ? Math.round(data.load_duration / 1e6) : null,
        tokensPerSec: data.eval_count && data.eval_duration ? +(data.eval_count / (data.eval_duration / 1e9)).toFixed(1) : null,
        evalTokens: data.eval_count || 0,
    };
}

const EXTRACT_PROMPT = (chunk, hint) => `You prepare a correction dictionary for live closed captions of ${hint || 'a public meeting'}.
From the document text below, extract every proper noun a speech-to-text engine could get wrong:
- people's full names (put their title/role in "detail")
- boards, committees, commissions, departments and organizations
- places: streets, squares, neighborhoods, parks, buildings, schools, neighboring towns
- project, program and plan names
- acronyms and abbreviations (put the expansion in "detail")
Skip generic words, lone first names, dates, dollar amounts, URLs and page furniture.

Respond with ONLY this JSON object and nothing else:
{"items":[{"name":"<exact spelling as written>","category":"<elected_official|staff|board_or_committee|department|organization|place|school|acronym|term>","detail":"<role, expansion or short context>","misheard":["<1-2 plausible lowercase speech-to-text errors, or empty>"]}]}

Document:
${chunk}`;

function splitChunks(text, size) {
    const out = [];
    let rest = text;
    while (rest.length > size) {
        let cut = rest.lastIndexOf('\n\n', size);
        if (cut < size * 0.5) cut = rest.lastIndexOf('\n', size);
        if (cut < size * 0.5) cut = rest.lastIndexOf('. ', size);
        if (cut < size * 0.5) cut = size;
        out.push(rest.slice(0, cut));
        rest = rest.slice(cut).trim();
    }
    if (rest) out.push(rest);
    return out;
}

/**
 * Extract dictionary items from text with Ollama. Chunks are processed one at a
 * time (local models share one GPU/CPU); long documents are capped at 4 chunks.
 */
export async function extractItemsWithOllama(text, { url = DEFAULT_URL, model, domainHint = '', onProgress = () => {} } = {}) {
    if (!model) throw new Error('No Ollama model selected');
    const cleaned = String(text || '').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    if (!cleaned) return { items: [], chunks: 0, latencyMs: 0 };
    const chunks = splitChunks(cleaned, 6000).slice(0, 4);
    const byName = new Map();
    const t0 = Date.now();
    let tokensPerSec = null;
    for (let i = 0; i < chunks.length; i++) {
        onProgress({ chunk: i + 1, chunks: chunks.length });
        const r = await ollamaJson({ url, model, prompt: EXTRACT_PROMPT(chunks[i], domainHint), maxTokens: 2500 });
        if (r.tokensPerSec) tokensPerSec = r.tokensPerSec;
        const list = Array.isArray(r.parsed) ? r.parsed : Array.isArray(r.parsed?.items) ? r.parsed.items : Array.isArray(r.parsed?.entries) ? r.parsed.entries : [];
        for (const it of list) {
            if (!it || typeof it.name !== 'string') continue;
            const name = it.name.trim().replace(/\s+/g, ' ');
            if (name.length < 2) continue;
            const k = name.toLowerCase();
            const item = {
                name,
                category: typeof it.category === 'string' ? it.category : 'proper_noun',
                detail: typeof it.detail === 'string' ? it.detail.trim().slice(0, 140) : '',
                misheard: Array.isArray(it.misheard) ? it.misheard.filter(m => typeof m === 'string').map(m => m.trim().toLowerCase()).filter(Boolean).slice(0, 2) : [],
            };
            const existing = byName.get(k);
            if (!existing) byName.set(k, item);
            else if (!existing.detail && item.detail) existing.detail = item.detail;
        }
    }
    return { items: [...byName.values()], chunks: chunks.length, latencyMs: Date.now() - t0, tokensPerSec };
}

export async function extractEntriesWithOllama(text, cfg = {}) {
    const b = getBrainConfig();
    const r = await extractItemsWithOllama(text, { url: cfg.url || b.url, model: cfg.model || b.model, domainHint: cfg.domainHint });
    return { entries: itemsToEntries(r.items).slice(0, 400), items: r.items, latencyMs: r.latencyMs, chunks: r.chunks, tokensPerSec: r.tokensPerSec };
}

// A realistic sample agenda for the wizard's "does this model work with the app?" test.
const SAMPLE_AGENDA = `TOWN OF BROOKLINE — SELECT BOARD
Regular Meeting Agenda, Tuesday 7:00 PM, Town Hall, 333 Washington Street, 6th Floor Hearing Room
Members: David Pearlman (Chair), Michael Rubenstein (Vice Chair), Bernard W. Greene, Amanda Zimmerman, Anthony Buono
Staff: Charles Carey, Town Administrator; Melissa Goff, Deputy Town Administrator; Erin Chute Gallentine, Commissioner of Public Works (DPW)
1. Public comment
2. Capital Improvement Program (CIP) update — FY2027 Capital Subcommittee, presented by Finance Director Charles Young
3. Coolidge Corner parking garage feasibility study — Transportation Board recommendation; MBTA Green Line "C" branch coordination
4. Harvard Street redesign: Complete Streets grant from MassDOT; Zoning Board of Appeals (ZBA) comments
5. Other Post-Employment Benefits (OPEB) trust funding; Advisory Committee report
6. Licenses: Common victualler license, Kumo Sushi, 1370 Beacon Street`;

/** Run the real extraction prompt on a sample agenda and grade the result. */
export async function testOllamaExtraction(model, url = DEFAULT_URL) {
    const t0 = Date.now();
    const r = await extractItemsWithOllama(SAMPLE_AGENDA, { url, model });
    const entries = itemsToEntries(r.items);
    const names = r.items.map(i => i.name);
    const expected = ['David Pearlman', 'Bernard W. Greene', 'Coolidge Corner', 'DPW', 'Zoning Board of Appeals', 'Melissa Goff'];
    const hits = expected.filter(e => names.some(n => n.toLowerCase().includes(e.toLowerCase().replace(' w. ', ' ').slice(0, 8))));
    const score = hits.length / expected.length;
    return {
        ok: r.items.length >= 5 && score >= 0.5,
        model, latencyMs: Date.now() - t0, tokensPerSec: r.tokensPerSec,
        itemCount: r.items.length, entryCount: entries.length,
        score: Math.round(score * 100),
        sample: names.slice(0, 10),
        verdict: r.items.length === 0 ? 'The model returned no usable JSON — try another model.'
            : score < 0.5 ? `Found ${r.items.length} names but missed most of the expected ones (${Math.round(score * 100)}% recall) — a larger model will do better.`
            : `Works with the app: ${r.items.length} names (${entries.length} correction rules) in ${((Date.now() - t0) / 1000).toFixed(1)}s.`,
    };
}
