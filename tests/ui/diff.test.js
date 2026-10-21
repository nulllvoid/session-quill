// The run detail's grouped diff (ADR 0040): a pure parse of the run's patch, grouped by a path table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDiff, diffGroup, groupFiles, hunkRetryNote, DIFF_GROUPS, NOTE_MAX } from '../../ui/lib/diff.js';

const PATCH = [
  'diff --git a/src/core/reduce/tickets.js b/src/core/reduce/tickets.js',
  'index 1111111..2222222 100644',
  '--- a/src/core/reduce/tickets.js',
  '+++ b/src/core/reduce/tickets.js',
  '@@ -10,7 +10,8 @@ export function reduceTicket(state, ev) {',
  '   const t = state.tickets.get(id);',
  '-  t.status = ev.status;',
  '+  if (!t) return;',
  '+  t.status = ev.status;',
  '   return t;',
  '\\ No newline at end of file',
  '@@ -40,3 +41,3 @@',
  '-old',
  '+new',
  ' same',
  'diff --git a/tests/core/tickets.test.js b/tests/core/tickets.test.js',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/tests/core/tickets.test.js',
  '@@ -0,0 +1,2 @@',
  "+import test from 'node:test';",
  '+test("x", () => {});',
  'diff --git a/ui/logo.png b/ui/logo.png',
  'new file mode 100644',
  'index 0000000..4444444',
  'GIT binary patch',
  'literal 12',
  'TcmZ?wbhEHbRA5kG00961',
  '',
  'literal 0',
  'HcmV?d00001',
  '',
  'diff --git a/src/old name.js b/src/new name.js',
  'similarity index 90%',
  'rename from src/old name.js',
  'rename to src/new name.js',
  'index 5555555..6666666 100644',
  '--- a/src/old name.js',
  '+++ b/src/new name.js',
  '@@ -1 +1 @@',
  '-a',
  '+b',
  'diff --git a/docs/gone.md b/docs/gone.md',
  'deleted file mode 100644',
  'index 7777777..0000000',
  '--- a/docs/gone.md',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-# Gone',
  '-text',
  'diff --git a/assets/blob.bin b/assets/blob.bin',
  'index 8888888..9999999 100644',
  'Binary files a/assets/blob.bin and b/assets/blob.bin differ',
].join('\n');

test('parseDiff: files, statuses, hunks with ranges and section, line kinds and counts', () => {
  const files = parseDiff(PATCH);
  assert.deepEqual(files.map((f) => [f.path, f.status, f.binary]), [
    ['src/core/reduce/tickets.js', 'modified', false],
    ['tests/core/tickets.test.js', 'added', false],
    ['ui/logo.png', 'added', true],
    ['src/new name.js', 'renamed', false],
    ['docs/gone.md', 'deleted', false],
    ['assets/blob.bin', 'modified', true],
  ]);
  const [reduce, test1, png, renamed, gone] = files;
  assert.equal(reduce.hunks.length, 2);
  assert.deepEqual([reduce.hunks[0].header, reduce.hunks[0].oldStart, reduce.hunks[0].oldLines, reduce.hunks[0].newStart, reduce.hunks[0].newLines], ['@@ -10,7 +10,8 @@', 10, 7, 10, 8]);
  assert.equal(reduce.hunks[0].section, 'export function reduceTicket(state, ev) {');
  assert.deepEqual(reduce.hunks[0].lines.map((l) => l.kind), ['context', 'del', 'add', 'add', 'context', 'meta']);
  assert.equal(reduce.hunks[0].lines[2].text, '  if (!t) return;', 'the +/- marker is not part of the text');
  assert.equal(reduce.hunks[1].section, '');
  assert.deepEqual([reduce.additions, reduce.deletions], [3, 2]);
  assert.deepEqual([test1.additions, test1.deletions], [2, 0]);
  assert.deepEqual(png.hunks, [], 'binary content is never kept');
  assert.equal(renamed.oldPath, 'src/old name.js');
  assert.deepEqual([renamed.hunks[0].oldLines, renamed.hunks[0].newLines], [1, 1], 'an omitted count is 1');
  assert.deepEqual([gone.deletions, gone.hunks[0].newStart, gone.hunks[0].newLines], [2, 0, 0]);
  assert.ok(!JSON.stringify(files).includes('TcmZ'), 'no base85 binary data survives');
});

test('parseDiff: empty, junk and CRLF input; quoted paths', () => {
  assert.deepEqual(parseDiff(''), []);
  assert.deepEqual(parseDiff(null), []);
  assert.deepEqual(parseDiff('not a diff\n+x\n'), []);
  const crlf = parseDiff('diff --git a/x.js b/x.js\r\n--- a/x.js\r\n+++ b/x.js\r\n@@ -1 +1 @@\r\n-a\r\n+b\r\n');
  assert.equal(crlf[0].hunks[0].lines[1].text, 'b');
  const quoted = parseDiff('diff --git "a/sp ace\\"q.js" "b/sp ace\\"q.js"\n--- "a/sp ace\\"q.js"\n+++ "b/sp ace\\"q.js"\n@@ -1 +1 @@\n-a\n+b\n');
  assert.equal(quoted[0].path, 'sp ace"q.js');
});

test('diffGroup: the path table, by whole path segment, tests first', () => {
  const cases = {
    'tests/core/tickets.test.js': 'Tests', 'src/a.test.js': 'Tests', 'ui/__tests__/x.js': 'Tests', 'test/ui/routes.js': 'Tests', 'spec/reduce_spec.rb': 'Tests',
    'src/core/reduce/tickets.js': 'Schema and state', 'src/core/state.js': 'Schema and state', 'db/migrations/001.sql': 'Schema and state', 'src/core/events.js': 'Schema and state', 'schema/x.json': 'Schema and state', 'src/core/reducer.js': 'Schema and state',
    'src/cli/commands/run.js': 'CLI, routes and UI', 'src/server/http.js': 'CLI, routes and UI', 'ui/app.js': 'CLI, routes and UI', 'app/routes/index.js': 'CLI, routes and UI',
    'src/handoff/extension.js': 'Core logic', 'README.md': 'Core logic', 'src/build/guide.js': 'Core logic', 'src/statement.js': 'Core logic', 'src/quill.js': 'Core logic',
  };
  for (const [p, g] of Object.entries(cases)) assert.equal(diffGroup(p), g, p);
  assert.deepEqual(DIFF_GROUPS, ['Core logic', 'Schema and state', 'CLI, routes and UI', 'Tests']);
});

test('groupFiles: groups in table order, empty groups left out, files kept in patch order', () => {
  const groups = groupFiles(parseDiff(PATCH));
  assert.deepEqual(groups.map((g) => [g.name, g.files.map((f) => f.path)]), [
    ['Core logic', ['src/new name.js', 'docs/gone.md', 'assets/blob.bin']],
    ['Schema and state', ['src/core/reduce/tickets.js']],
    ['CLI, routes and UI', ['ui/logo.png']],
    ['Tests', ['tests/core/tickets.test.js']],
  ]);
});

test('hunkRetryNote: names the file and the hunk range only, within 280 characters', () => {
  const [file] = parseDiff(PATCH);
  const note = hunkRetryNote(file, file.hunks[0]);
  assert.equal(note, 'Rework the change to src/core/reduce/tickets.js at @@ -10,7 +10,8 @@ from the earlier run; keep the rest of the change as it was.');
  assert.doesNotMatch(note, /reduceTicket/, 'the hunk section is source text: never carried into the note');
  const long = { path: `src/${'deep/'.repeat(80)}file.js` };
  const n2 = hunkRetryNote(long, { header: '@@ -1000000,7 +1000000,8 @@' });
  assert.ok(n2.length <= NOTE_MAX, `${n2.length}`);
  assert.equal(NOTE_MAX, 280);
  assert.match(n2, /@@ -1000000,7 \+1000000,8 @@/);
  assert.match(n2, /file\.js/, 'the file name survives a cut path');
  const weird = hunkRetryNote({ path: 'a\nb\u202e.js' }, { header: '@@ -1 +1 @@' });
  assert.doesNotMatch(weird, /[\n\u202e]/, 'one plain line');
});
