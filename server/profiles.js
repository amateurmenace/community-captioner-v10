/**
 * Named Context Engine profiles, stored server-side as JSON files so every
 * operator machine on the LAN sees the same "Brookline Select Board" profile.
 *
 *   <DATA_DIR>/profiles/<id>.json  →  { id, name, municipality?, notes?, entries[], createdAt, updatedAt }
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { DATA_DIR } from './context-learner.js';

const PROFILES_DIR = join(DATA_DIR, 'profiles');

function ensureDir() {
    if (!existsSync(PROFILES_DIR)) mkdirSync(PROFILES_DIR, { recursive: true });
}

export function slugify(name) {
    return String(name || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_-]+/g, '-').slice(0, 60) || 'profile';
}

function readProfile(file) {
    try {
        const p = JSON.parse(readFileSync(file, 'utf-8'));
        if (!p || !Array.isArray(p.entries)) return null;
        return p;
    } catch { return null; }
}

/** Summaries only (no entries) for listing. */
export function listProfiles() {
    ensureDir();
    return readdirSync(PROFILES_DIR)
        .filter(f => f.endsWith('.json'))
        .map(f => readProfile(join(PROFILES_DIR, f)))
        .filter(Boolean)
        .map(({ entries, ...meta }) => ({ ...meta, entryCount: entries.length }))
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export function getProfile(id) {
    ensureDir();
    const file = join(PROFILES_DIR, `${slugify(id)}.json`);
    return existsSync(file) ? readProfile(file) : null;
}

/**
 * Create or overwrite a profile. `entries` replaces the stored list unless
 * merge=true, which adds only new original→replacement pairs.
 */
export function saveProfile({ name, entries, municipality, notes, merge = false }) {
    ensureDir();
    const id = slugify(name);
    const now = Date.now();
    const existing = getProfile(id);
    let finalEntries = (entries || []).filter(e => e && e.original && e.replacement);
    if (merge && existing) {
        const seen = new Set(existing.entries.map(e => `${e.original.toLowerCase()}→${e.replacement.toLowerCase()}`));
        finalEntries = [...existing.entries, ...finalEntries.filter(e => !seen.has(`${e.original.toLowerCase()}→${e.replacement.toLowerCase()}`))];
    }
    const profile = {
        id,
        name: String(name).trim(),
        municipality: municipality ?? existing?.municipality ?? '',
        notes: notes ?? existing?.notes ?? '',
        entries: finalEntries,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
    };
    writeFileSync(join(PROFILES_DIR, `${id}.json`), JSON.stringify(profile, null, 2), 'utf-8');
    return profile;
}

export function deleteProfile(id) {
    ensureDir();
    const file = join(PROFILES_DIR, `${slugify(id)}.json`);
    if (!existsSync(file)) return false;
    unlinkSync(file);
    return true;
}
