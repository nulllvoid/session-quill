import { test } from 'node:test';
import assert from 'node:assert/strict';
import { annotationsFromTap } from '../../scripts/ci-annotate.mjs';

const TAP = [
  'TAP version 13',
  '# Subtest: tests/a.test.js',
  '    not ok 1 - adds numbers',
  '      ---',
  '      duration_ms: 1.2',
  "      location: 'C:\\\\repo\\\\tests\\\\a.test.js:5:1'",
  "      failureType: 'testCodeFailure'",
  '      error: |-',
  '        Expected values to be strictly equal:',
  '        ',
  '        1 !== 2',
  "      code: 'ERR_ASSERTION'",
  '      ...',
  '    ok 2 - passes',
  'not ok 1 - tests/a.test.js',
  '  ---',
  "  failureType: 'subtestsFailed'",
  '  ...',
].join('\n');

test('failed leaf tests become GitHub error annotations with their message and location; file rollups are skipped', () => {
  const lines = annotationsFromTap(TAP);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^::error title=adds numbers::/);
  assert.match(lines[0], /Expected values to be strictly equal:%0A%0A1 !== 2/);
  assert.match(lines[0], /a\.test\.js:5:1/);
  assert.deepEqual(annotationsFromTap('TAP version 13\nok 1 - fine\n'), []);
});
