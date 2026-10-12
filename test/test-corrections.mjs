#!/usr/bin/env node
// Tests for shared/corrections.js — phonetic keys, correction passes, edit diffs.
import { phoneticKey, phraseKey, buildCorrectionIndex, applyCorrections, diffForRules } from '../shared/corrections.js';

let passed = 0, failed = 0;
const assert = (cond, label, extra = '') => { if (cond) { passed++; console.log(`  ✅ ${label}`); } else { failed++; console.log(`  ❌ ${label} ${extra}`); } };
const same = (a, b, label) => assert(phoneticKey(a) === phoneticKey(b), `${label}: "${a}" ≈ "${b}"`, `(${phoneticKey(a)} vs ${phoneticKey(b)})`);
const diff = (a, b, label) => assert(phoneticKey(a) !== phoneticKey(b), `${label}: "${a}" ≠ "${b}"`, `(${phoneticKey(a)} vs ${phoneticKey(b)})`);

console.log('\n═══ Phonetic keys ═══');
same('Greene', 'green', 'surname vs colour');
same('Pearlman', 'Perlman', 'dropped vowel');
same('Rubenstein', 'Rubinstein', 'e/i');
same('Buono', 'Bono', 'double vowel');
same('Moghtader', 'Mohtader', 'silent gh');
same('Gallentine', 'Galentine', 'double l');
same('Pham', 'fam', 'ph → f');
same('Zimmerman', 'Zimmermann', 'double n');
same('Brookline', 'Brooklyn', 'ine/yn');
same('Frias', 'Freeze', 'vowel shift');
assert(phraseKey('Weintraub') === phraseKey('wine troub'), 'phrase key ignores word splits');
diff('Pearlman', 'Freeman', 'different names');
diff('Smith', 'Jones', 'different names');
assert(phoneticKey('') === '' && phoneticKey('123') === '', 'empty / numeric → empty key');

console.log('\n═══ applyCorrections ═══');
const dict = [
    { original: 'bernard green', replacement: 'Bernard Greene', type: 'proper_noun' },
    { original: 'david pearlman', replacement: 'David Pearlman', type: 'proper_noun' },
    { original: 'dpw', replacement: 'DPW', type: 'acronym' },
    { original: 'coolidge corner', replacement: 'Coolidge Corner', type: 'place' },
    { original: 'moghtader', replacement: 'Moghtader', type: 'proper_noun' },
    { original: 'buono', replacement: 'Buono', type: 'proper_noun' },
    { original: 'greene', replacement: 'Greene', type: 'proper_noun' },
];
const idx = buildCorrectionIndex(dict);
let r = applyCorrections('chair david perlman recognized bernard green', idx);
assert(r.text === 'chair David Pearlman recognized Bernard Greene', 'exact + phonetic multi-word', r.text);
assert(r.applied.some(a => a.mode === 'phonetic') && r.applied.some(a => a.mode === 'exact'), 'reports both modes');

r = applyCorrections('the dpw truck parked at coolidge corner.', idx);
assert(r.text === 'the DPW truck parked at Coolidge Corner.', 'exact replacements keep punctuation', r.text);

r = applyCorrections('the green space near the park', idx);
assert(r.text === 'the green space near the park', 'common word "green" is never phonetically replaced', r.text);

r = applyCorrections('councilor mohtader and mister bono spoke', idx, { sensitivity: 80 });
assert(r.text === 'councilor Moghtader and mister Buono spoke', 'single-word phonetic at high sensitivity', r.text);

r = applyCorrections('councilor mohtader spoke', idx, { sensitivity: 50 });
assert(r.text === 'councilor mohtader spoke', 'single-word phonetic disabled at medium sensitivity', r.text);

r = applyCorrections('bernard grene arrived', idx, { sensitivity: 10 });
assert(r.text === 'bernard grene arrived', 'phonetic disabled at low sensitivity', r.text);

r = applyCorrections('David Pearlman and Bernard Greene.', idx);
assert(r.text === 'David Pearlman and Bernard Greene.', 'already-correct text is untouched', r.text);
assert(r.applied.filter(a => a.mode === 'phonetic').length === 0, 'no phonetic hits on correct text');

r = applyCorrections('the d p w truck and the dpw yard', idx);
assert(!/DPW w/.test(r.text) && r.text.includes('the DPW yard'), 'spelled-out acronym is never half-replaced', r.text);

const idx2 = buildCorrectionIndex([{ original: 'bernard w. greene', replacement: 'Bernard W. Greene', type: 'proper_noun' }, { original: 'd p w', replacement: 'DPW', type: 'acronym' }]);
r = applyCorrections('bernard w greene thanked the d p w crew', idx2);
assert(r.text === 'Bernard W. Greene thanked the DPW crew', 'initials and spelled-out acronyms match', r.text);

r = applyCorrections('', idx);
assert(r.text === '' && r.applied.length === 0, 'empty text');

console.log('\n═══ diffForRules ═══');
let rules = diffForRules('chair david perlman recognized bernard green', 'chair David Pearlman recognized Bernard Greene');
assert(rules.length === 2, 'two replaced spans', JSON.stringify(rules));
assert(rules[0].original === 'david perlman' && rules[0].replacement === 'David Pearlman', 'first rule', JSON.stringify(rules[0]));
assert(rules[1].original === 'bernard green' && rules[1].replacement === 'Bernard Greene', 'second rule', JSON.stringify(rules[1]));

rules = diffForRules('we moved the item to next week', 'we moved the item to next month');
assert(rules.length === 0, 'single common-word edits are not rules', JSON.stringify(rules));

rules = diffForRules('the sea pea budget', 'the CIP budget');
assert(rules.length === 1 && rules[0].original === 'sea pea' && rules[0].replacement === 'CIP', 'acronym heard as words', JSON.stringify(rules));

rules = diffForRules('same text here', 'same text here');
assert(rules.length === 0, 'identical text → no rules');

console.log(`\n${'═'.repeat(40)}\nResults: ${passed} passed, ${failed} failed\n${'═'.repeat(40)}`);
process.exit(failed ? 1 : 0);
