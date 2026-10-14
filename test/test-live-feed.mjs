#!/usr/bin/env node
// Unit tests for server/live-feed.js (stable-word commit from interim transcripts).
import { LiveFeed, tokenize, norm } from '../server/live-feed.js';

let passed = 0, failed = 0;
const assert = (c, label) => { if (c) { console.log(`  ✅ ${label}`); passed++; } else { console.log(`  ❌ ${label}`); failed++; } };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('\n═══ Live feed ═══');
assert(eq(tokenize('  so welcome   to the\nmeeting '), ['so', 'welcome', 'to', 'the', 'meeting']), 'tokenize splits on any whitespace');
assert(norm('Brookline,') === 'brookline' && norm("don't") === "don't", 'norm drops case and punctuation, keeps apostrophes');

// A Gemini-style cumulative interim: words become stable after 3 identical observations, the last word is held back
let lf = new LiveFeed({ stable: 3, holdLastWords: 1 });
let t = 1000;
assert(eq(lf.interim('so welcome', t += 300), []), 'first interim commits nothing');
assert(eq(lf.interim('so welcome to', t += 300), []), 'second interim commits nothing');
assert(eq(lf.interim('so welcome to the', t += 300), ['so', 'welcome']), 'third interim commits the prefix shared by all three, minus the last word');
assert(eq(lf.interim('so welcome to the advisory', t += 300), ['to']), 'the next interim commits one more stable word');
assert(eq(lf.interim('so welcome to the advisory committee', t += 300), ['the']), 'and the next');
assert(lf.committedCount === 4, 'committed count tracks what went out');
let tail = lf.final('So welcome to the Advisory Committee meeting.');
assert(eq(tail, ['Advisory', 'Committee', 'meeting.']), 'the final sends the words beyond the committed prefix, with their punctuation');
assert(lf.committedCount === 0 && lf.stats.finals === 1 && lf.stats.mismatches === 0, 'the final closes the utterance');

// A revision inside the unstable tail never goes out; the growing word is held back
lf = new LiveFeed({ stable: 3, holdLastWords: 1 });
lf.interim('the town of bro', t += 300);
lf.interim('the town of brook', t += 300);
assert(eq(lf.interim('the town of brookline', t += 300), ['the', 'town', 'of']), 'a word that keeps changing is not committed while it grows');
assert(eq(lf.interim('the town of brookline is', t += 300), []), '"brookline" waits until it has been seen stable three times');
assert(eq(lf.interim('the town of brookline is here', t += 300), ['brookline']), 'then it goes out');

// A revision of an already-committed word is counted, not taken back
lf = new LiveFeed({ stable: 2, holdLastWords: 1 });
lf.interim('bernard green said', t += 300);
assert(eq(lf.interim('bernard green said that', t += 300), ['bernard', 'green', 'said']), 'stable=2 commits after two observations');
tail = lf.final('Bernard Greene said that.');
assert(eq(tail, ['that.']), 'the final tail is by position even when an earlier word was revised');

// A final with fewer words than committed sends nothing more
lf = new LiveFeed({ stable: 2, holdLastWords: 0 });
lf.interim('one two three four', t += 300);
lf.interim('one two three four', t += 300);
assert(eq(lf.final('one two'), []), 'a shorter final adds nothing');

// Idle gap starts a new utterance; a final without interims sends everything
lf = new LiveFeed({ stable: 2, holdLastWords: 1, maxIdleMs: 5000 });
lf.interim('hello there', t += 300);
lf.interim('hello there', t += 300);
assert(lf.committedCount === 1, 'one word committed before the gap');
lf.interim('new sentence here', t += 9000);
assert(lf.committedCount === 0, 'a long idle gap resets the utterance');
assert(eq(lf.final('Completely fresh words.'), ['Completely', 'fresh', 'words.']), 'a final with no committed words goes out whole');

// holdLastWords 0 commits everything that is stable
lf = new LiveFeed({ stable: 1, holdLastWords: 0 });
assert(eq(lf.interim('a b c'), ['a', 'b', 'c']), 'stable=1, hold=0 commits every interim word at once');
assert(eq(lf.interim('a b c d'), ['d']), 'and only the new ones next time');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
