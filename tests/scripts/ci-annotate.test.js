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

const CRASH_TAP = [
  'TAP version 13',
  '# node:internal/modules/esm/resolve:271',
  '#     throw new ERR_MODULE_NOT_FOUND(',
  "# Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'C:\\\\repo\\\\src\\\\gone.js' imported from C:\\\\repo\\\\tests\\\\crash.test.js",
  '#     at finalizeResolution (node:internal/modules/esm/resolve:271:11)',
  '# Node.js v24.19.0',
  '# Subtest: tests/crash.test.js',
  'not ok 1 - tests/crash.test.js',
  '  ---',
  "  location: 'C:\\\\repo\\\\tests\\\\crash.test.js:1:1'",
  "  failureType: 'testCodeFailure'",
  "  error: 'test failed'",
  '  ...',
  '# Subtest: later \\# thing',
  'not ok 2 - later \\# thing # TODO',
  '  ---',
  "  failureType: 'testCodeFailure'",
  "  error: 'not yet'",
  '  ...',
].join('\n');

test('review: a file that crashes before its tests run is annotated with the crash output; todo failures are not errors', () => {
  const lines = annotationsFromTap(CRASH_TAP);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^::error title=tests\/crash\.test\.js::/);
  assert.match(lines[0], /ERR_MODULE_NOT_FOUND\]: Cannot find module 'C:\\repo\\src\\gone\.js'/);
  assert.doesNotMatch(lines[0], /test failed/);
  assert.doesNotMatch(lines.join('\n'), /later/);
});

test('failed leaf tests become GitHub error annotations with their message and location; file rollups are skipped', () => {
  const lines = annotationsFromTap(TAP);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^::error title=adds numbers::/);
  assert.match(lines[0], /Expected values to be strictly equal:%0A%0A1 !== 2/);
  assert.match(lines[0], /a\.test\.js:5:1/);
  assert.deepEqual(annotationsFromTap('TAP version 13\nok 1 - fine\n'), []);
});
