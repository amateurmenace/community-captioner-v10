#!/usr/bin/env node
// Unit tests for server/live-feed.js (stable-word commit from interim transcripts, final alignment).
import { LiveFeed, tokenize, norm } from '../server/live-feed.js';

let passed = 0, failed = 0;
const assert = (c, label) => { if (c) { console.log(`  ✅ ${label}`); passed++; } else { console.log(`  ❌ ${label}`); failed++; } };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('\n═══ Live feed ═══');
assert(eq(tokenize('  so welcome   to the\nmeeting '), ['so', 'welcome', 'to', 'the', 'meeting']), 'tokenize splits on any whitespace');
assert(norm('Brookline,') === 'brookline' && norm("don't") === "don't", 'norm drops case and punctuation, keeps apostrophes');

// A cumulative interim: words become stable after 3 identical observations, the last word is held back (no age gate here)
let lf = new LiveFeed({ stable: 3, holdLastWords: 1, minAgeMs: 0 });
let t = 1000;
assert(eq(lf.interim('so welcome', t += 300), []), 'first interim commits nothing');
assert(eq(lf.interim('so welcome to', t += 300), []), 'second interim commits nothing');
assert(eq(lf.interim('so welcome to the', t += 300), ['so', 'welcome']), 'third interim commits the prefix shared by all three, minus the last word');
assert(eq(lf.interim('so welcome to the advisory', t += 300), ['to']), 'the next interim commits one more stable word');
assert(eq(lf.interim('so welcome to the advisory committee', t += 300), ['the']), 'and the next');
assert(lf.committedCount === 4, 'committed count tracks what went out');
let r = lf.final('So welcome to the Advisory Committee meeting.');
assert(eq(r.words, ['Advisory', 'Committee', 'meeting.']) && r.completeLastWord === null, 'the final sends the words beyond the committed ones, with their punctuation');
assert(lf.committedCount === 0 && lf.stats.finals === 1 && lf.stats.mismatches === 0, 'the final closes the utterance');

// The word being spoken is held back while it grows
lf = new LiveFeed({ stable: 3, holdLastWords: 1, minAgeMs: 0 });
lf.interim('the town of bro', t += 300);
lf.interim('the town of brook', t += 300);
assert(eq(lf.interim('the town of brookline', t += 300), ['the', 'town', 'of']), 'a word that keeps changing is not committed while it grows');
assert(eq(lf.interim('the town of brookline is', t += 300), []), '"brookline" waits until it has been seen stable three times');
assert(eq(lf.interim('the town of brookline is here', t += 300), ['brookline']), 'then it goes out');

// The age gate: a word must have stood at its position for minAgeMs, even when the interims agree
lf = new LiveFeed({ stable: 2, holdLastWords: 0, minAgeMs: 1000 });
t = 10000;
lf.interim('one two', t);
assert(eq(lf.interim('one two', t + 300), []), 'two agreeing interims 300 ms apart commit nothing with a 1 s age gate');
assert(eq(lf.interim('one two', t + 1100), ['one', 'two']), 'after a second at the same position both words go out');
lf.interim('one two three', t + 1200);
assert(eq(lf.interim('one two three', t + 1400), []), 'a new word waits for its own age');
assert(eq(lf.interim('one two three', t + 2300), ['three']), 'and goes out when it has stood long enough');

// A reading that flips ("we'll accept" / "well except") is not committed while it flips
lf = new LiveFeed({ stable: 3, holdLastWords: 1, minAgeMs: 0 });
t = 20000;
lf.interim("we'll accept that so", t += 200);
lf.interim("well except that's so", t += 200);
lf.interim("we'll accept that so steep", t += 200);
assert(eq(lf.interim("well except that's so steeped", t += 200), []), 'alternating readings never agree three times, nothing goes out');
lf.interim("we'll accept that so steeped in", t += 200);
lf.interim("we'll accept that so steeped in the", t += 200);
assert(eq(lf.interim("we'll accept that so steeped in the history", t += 200), ["we'll", 'accept', 'that', 'so', 'steeped', 'in']), 'once the reading settles for three interims it goes out');

// A committed fragment is completed on air by the final ("co" → "could": the rest of the word, no space)
lf = new LiveFeed({ stable: 2, holdLastWords: 0, minAgeMs: 0 });
lf.interim('or you co', t += 300);
assert(eq(lf.interim('or you co', t += 300), ['or', 'you', 'co']), 'the fragment went out (hold 0 for the test)');
r = lf.final('Or you could look at the map.');
assert(r.completeLastWord === 'uld' && eq(r.words, ['look', 'at', 'the', 'map.']), `the final completes the fragment and sends the rest: ${JSON.stringify(r)}`);
assert(lf.stats.completed === 1, 'completion counted');

// A final that revised an earlier word: the committed word stays, the alignment continues after it
lf = new LiveFeed({ stable: 2, holdLastWords: 1, minAgeMs: 0 });
lf.interim('bernard green said that', t += 300);
assert(eq(lf.interim('bernard green said that', t += 300), ['bernard', 'green', 'said']), 'stable=2 commits after two observations');
r = lf.final('Bernard Greene said that.');
assert(eq(r.words, ['that.']) && lf.stats.skipped === 1, 'a revised word is skipped in the alignment, the tail is still right');

// A final with a word the interim never had: aligned by content, not by position
lf = new LiveFeed({ stable: 2, holdLastWords: 0, minAgeMs: 0 });
lf.interim('need to be put on a map', t += 300);
lf.interim('need to be put on a map', t += 300);
r = lf.final('We need to be put on a map or you could.');
assert(eq(r.words, ['or', 'you', 'could.']), `an extra leading word in the final does not shift the tail: ${JSON.stringify(r.words)}`);

// A final with fewer words than committed sends nothing more
lf = new LiveFeed({ stable: 2, holdLastWords: 0, minAgeMs: 0 });
lf.interim('one two three four', t += 300);
lf.interim('one two three four', t += 300);
r = lf.final('one two');
assert(eq(r.words, []), 'a shorter final adds nothing');

// Idle gap starts a new utterance; a final without interims sends everything
lf = new LiveFeed({ stable: 2, holdLastWords: 1, minAgeMs: 0, maxIdleMs: 5000 });
lf.interim('hello there', t += 300);
lf.interim('hello there', t += 300);
assert(lf.committedCount === 1, 'one word committed before the gap');
lf.interim('new sentence here', t += 9000);
assert(lf.committedCount === 0, 'a long idle gap resets the utterance');
r = lf.final('Completely fresh words.');
assert(eq(r.words, ['Completely', 'fresh', 'words.']) && r.completeLastWord === null, 'a final with no committed words goes out whole');

// Defaults
lf = new LiveFeed();
assert(lf.stable === 4 && lf.holdLastWords === 2 && lf.minAgeMs === 1200, 'defaults: 4 stable interims, 2 held words, 1.2 s age');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
