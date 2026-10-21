// Planned files (ADR 0037): paths a plan names, and the writes outside them that count as drift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  extractPlannedPaths, matchesPlanned, normalizePlanned, outsidePlan, applyPlannedPaths, recordSessionDrift,
  driftOfCall, countRunDrift, driftSuffix, MAX_PLANNED,
} from '../../src/core/planned-paths.js';

test('extractPlannedPaths takes repo-relative paths and globs from prose, code spans and links', () => {
  const plan = [
    '# Plan',
    '1. Create `src/core/planned-paths.js` and its test tests/core/planned-paths.test.js.',
    '2. Modify src/hooks/adapter.js (ExitPlanMode) and `src/core/reduce/*`.',
    '3. Run `node --test tests/hooks/*.test.js`; see [the ADR](docs/decisions/0037-planned-files-drift.md).',
    '4. Touch ./ui/views/run-detail.js, then README.md and the whole docs/design-system/ folder.',
  ].join('\n');
  assert.deepEqual(extractPlannedPaths(plan), [
    'src/core/planned-paths.js', 'tests/core/planned-paths.test.js', 'src/hooks/adapter.js', 'src/core/reduce/*',
    'tests/hooks/*.test.js', 'docs/decisions/0037-planned-files-drift.md', 'ui/views/run-detail.js', 'README.md', 'docs/design-system',
  ]);
});

test('extractPlannedPaths ignores URLs, absolute paths, home paths, climbs, flags and version numbers', () => {
  const plan = [
    'See https://github.com/acme/demo/blob/main/src/x.js and www.example.com/a/b.js.',
    'Not /etc/passwd, C:\\Users\\me\\secret.txt, C:/Windows/win.ini, ~/.ssh/config or \\\\server\\share\\a.js.',
    'Never ../outside/file.js or src/../../etc/x.js. Flags: --planned, -x. Versions 1.1.1 and 2.0.0. e.g. i.e.',
  ].join('\n');
  assert.deepEqual(extractPlannedPaths(plan), []);
  assert.deepEqual(extractPlannedPaths(null), []);
  assert.deepEqual(extractPlannedPaths(''), []);
});

test(`extractPlannedPaths keeps at most ${MAX_PLANNED} unique entries in first-seen order`, () => {
  const plan = Array.from({ length: 80 }, (_, i) => `src/f${i % 70}.js`).join(' ');
  const out = extractPlannedPaths(plan);
  assert.equal(out.length, MAX_PLANNED);
  assert.equal(out[0], 'src/f0.js');
  assert.equal(new Set(out).size, out.length);
});

test('normalizePlanned keeps only valid entries; it never throws on junk', () => {
  assert.deepEqual(normalizePlanned(['src\\a.js', './b/c.js', 'src/a.js', '/abs.js', 'x/../y.js', 'https://h/x.js', 7, null, '', 'src/dir/']), ['src/a.js', 'b/c.js', 'src/dir']);
  assert.deepEqual(normalizePlanned('src/a.js'), []);
  assert.deepEqual(normalizePlanned(undefined), []);
  assert.equal(normalizePlanned(['a'.repeat(201) + '.js']).length, 0);
});

test('matchesPlanned: exact files, directories, globs and bare names at any depth', () => {
  const globs = ['src/core/planned-paths.js', 'src/hooks', 'tests/**/*.test.js', 'ui/*.css', 'README.md'];
  for (const p of ['src/core/planned-paths.js', 'src/hooks/adapter.js', 'src/hooks/deep/x.js', 'tests/core/a.test.js', 'tests/a.test.js', 'ui/styles.css', 'README.md', 'docs/README.md', './src/hooks/nudge.js', 'SRC\\Hooks\\Nudge.js']) {
    assert.equal(matchesPlanned(p, globs), true, p);
  }
  for (const p of ['src/core/reducer.js', 'src/hooksx/a.js', 'tests/core/a.js', 'ui/views/a.css', 'README.txt', '', null]) {
    assert.equal(matchesPlanned(p, globs), false, String(p));
  }
  assert.equal(matchesPlanned('a.js', []), false);
});

test('outsidePlan lists repo-relative writes the plan does not name; absolute paths are outside the project, not drift', () => {
  const globs = ['src/a.js'];
  assert.deepEqual(outsidePlan(['src/a.js', 'src/b.js', 'C:/Users/me/.claude/plans/p.md', '/home/me/x.md', 'src/b.js'], globs), ['src/b.js']);
  assert.deepEqual(outsidePlan(['src/b.js'], []), [], 'no planned files: nothing to drift from');
  assert.deepEqual(outsidePlan('src/b.js', globs), []);
});

test('session drift: a plan sets planned files and resets drift; later writes outside count', () => {
  const s = {};
  assert.equal(recordSessionDrift(s, ['src/b.js'], 't0'), false, 'no plan yet');
  assert.equal(applyPlannedPaths(s, ['src/a.js', '/abs.js']), true);
  assert.deepEqual(s.planned_paths, ['src/a.js']);
  assert.equal(recordSessionDrift(s, ['src/a.js'], 't1'), false);
  assert.equal(recordSessionDrift(s, ['src/b.js', 'src/c.js'], 't2'), true);
  assert.deepEqual(s.drift, { count: 2, last_path: 'src/c.js', at: 't2' });
  assert.equal(recordSessionDrift(s, ['src/d.js'], 't3'), true);
  assert.equal(s.drift.count, 3);
  assert.equal(applyPlannedPaths(s, ['src/b.js']), true, 'a new plan replaces the old one');
  assert.equal(s.drift, null);
  assert.equal(applyPlannedPaths(s, []), true, 'a plan that names no files clears them');
  assert.deepEqual(s.planned_paths, []);
  assert.equal(recordSessionDrift(s, ['src/x.js'], 't4'), false);
  assert.equal(applyPlannedPaths(s, []), false, 'unchanged');
});

test('driftOfCall flags a file write inside the checkout that the planned files do not cover', () => {
  const cwd = process.platform === 'win32' ? 'C:\\co' : '/co';
  const at = (...p) => [cwd, ...p].join(process.platform === 'win32' ? '\\' : '/');
  const grant = { checkoutRoot: cwd, plannedPaths: ['src/a.js', 'docs'] };
  assert.equal(driftOfCall('Edit', { file_path: at('src', 'a.js') }, grant, cwd), false);
  assert.equal(driftOfCall('Write', { file_path: at('docs', 'x.md') }, grant, cwd), false);
  assert.equal(driftOfCall('Edit', { file_path: at('src', 'b.js') }, grant, cwd), true);
  assert.equal(driftOfCall('Write', { file_path: 'src/c.js' }, grant, cwd), true, 'a relative path resolves against the cwd');
  assert.equal(driftOfCall('NotebookEdit', { notebook_path: at('n.ipynb') }, grant, cwd), true);
  assert.equal(driftOfCall('MultiEdit', { file_path: at('src', 'a.js'), edits: [{ file_path: at('src', 'z.js') }] }, grant, cwd), true);
  assert.equal(driftOfCall('Write', { file_path: process.platform === 'win32' ? 'C:\\tmp\\x.txt' : '/tmp/x.txt' }, grant, cwd), false, 'outside the checkout: the writable roots govern it');
  assert.equal(driftOfCall('Bash', { command: 'echo > src/b.js' }, grant, cwd), false, 'only file write tools are measured');
  assert.equal(driftOfCall('Edit', { file_path: at('src', 'b.js') }, { checkoutRoot: cwd }, cwd), false, 'no planned files');
  assert.equal(driftOfCall('Edit', null, grant, cwd), false);
  assert.equal(driftOfCall('Edit', { file_path: at('src', 'b.js') }, null, cwd), false);
});

test('countRunDrift counts allowed guard lines marked drift, once per call', () => {
  const lines = [
    { kind: 'guard', decision: 'allow', drift: true, tool_use_id: 'a' },
    { kind: 'guard', decision: 'allow', drift: true, tool_use_id: 'a' },
    { kind: 'guard', decision: 'allow', drift: true },
    { kind: 'guard', decision: 'deny', drift: true, tool_use_id: 'b' },
    { kind: 'guard', decision: 'allow', tool_use_id: 'c' },
    { kind: 'tool_use', drift: true, tool_use_id: 'd' },
    null,
  ];
  assert.equal(countRunDrift(lines), 2);
  assert.equal(countRunDrift([]), 0);
  assert.equal(countRunDrift(undefined), 0);
});

test('driftSuffix is the status line segment, only for a positive count', () => {
  assert.equal(driftSuffix(3), ' ⚠ drift 3');
  for (const v of [0, -1, null, undefined, '3', 1.5]) assert.equal(driftSuffix(v), '');
});

// Agent-supplied plan text reaches the matcher on every captured write (reducer replay, hook, run
// guard), so matching and extraction must stay linear whatever the entries and the text hold.
test('matchesPlanned stays linear on a pathological glob (no backtracking)', () => {
  const globs = ['src/*a*a*a*a*a*a*a*a*a*a*a*a*b', '**a**a**a**a**a**a**a**b', 'src/' + '*a'.repeat(40) + 'b'];
  const p = 'src/' + 'a'.repeat(40) + '.js';
  const t = performance.now();
  assert.equal(matchesPlanned(p, globs), false);
  assert.equal(matchesPlanned('src/' + 'a'.repeat(2000), globs), false);
  assert.ok(performance.now() - t < 50, `took ${performance.now() - t} ms`);
});

test('matchesPlanned glob semantics: * and ? stay in a level, ** crosses, **/ may be empty, a directory covers below', () => {
  const yes = [
    ['src/*.js', 'src/a.js'], ['src/*.js', 'src/.js'], ['src/?.js', 'src/a.js'], ['src/**', 'src/a/b/c.js'], ['src/**/x.js', 'src/x.js'],
    ['src/**/x.js', 'src/a/b/x.js'], ['**/x.js', 'x.js'], ['**/x.js', 'a/x.js'], ['src/a*b/c', 'src/aXXb/c/d.js'], ['*.md', 'docs/a/README.md'],
    ['src/**.js', 'src/a/b.js'], ['src/a*', 'src/a/deep.js'], ['SRC/A.JS', 'src/a.js'], ['src/a+b(1).js', 'src/a+b(1).js'],
  ];
  const no = [
    ['src/*.js', 'src/a/b.js'], ['src/?.js', 'src/ab.js'], ['src/?.js', 'src//.js'], ['src/**/x.js', 'src/ax.js'], ['src/a*b/c', 'src/a/b/c'],
    ['src/a.js', 'src/a.jsx'], ['src/a.js', 'src/aajs'], ['src', 'srcx/a.js'], ['*.md', 'docs/a.mdx'], ['src/a+b.js', 'src/aab.js'],
  ];
  for (const [g, p] of yes) assert.equal(matchesPlanned(p, [g]), true, `${g} ~ ${p}`);
  for (const [g, p] of no) assert.equal(matchesPlanned(p, [g]), false, `${g} !~ ${p}`);
});

test('planned entries are capped: at most 4 wildcards, runs of * collapse to **', () => {
  assert.deepEqual(normalizePlanned(['src/***/a.js', 'src/****x*.js']), ['src/**/a.js', 'src/**x*.js']);
  assert.deepEqual(normalizePlanned(['src/*a*a*a*a*a*a*a*b', 'a?b?c?d?e?f.js', 'src/*/*/*/*.js']), ['src/*/*/*/*.js']);
  assert.deepEqual(extractPlannedPaths('edit src/*a*a*a*a*a*a*a*b and src/ok.js'), ['src/ok.js']);
});

test('the reducer drift path never throws on junk planned entries or write paths', () => {
  for (const planned of [[7, null, {}, ['x'], 'src/' + '*a'.repeat(100)], 'src/a.js', { 0: 'a' }, null]) {
    const s = { planned_paths: planned };
    assert.doesNotThrow(() => recordSessionDrift(s, ['src/b.js', 7, null, {}, '', 'x'.repeat(5000)], 't'));
    assert.doesNotThrow(() => applyPlannedPaths(s, planned));
  }
  assert.doesNotThrow(() => recordSessionDrift({ planned_paths: ['src'] }, null, 't'));
});

test('extractPlannedPaths stays linear on long scheme-like text and caps the plan text', () => {
  let t = performance.now();
  assert.deepEqual(extractPlannedPaths('a.'.repeat(100_000)), []);
  assert.ok(performance.now() - t < 50, `a.a.a… took ${performance.now() - t} ms`);
  t = performance.now();
  extractPlannedPaths('ab-'.repeat(70_000) + '://x');
  assert.ok(performance.now() - t < 50, `scheme run took ${performance.now() - t} ms`);
  for (const run of ['.'.repeat(60_000) + 'a', 'a' + '.'.repeat(60_000) + 'a', '/'.repeat(60_000) + 'a']) {
    t = performance.now();
    extractPlannedPaths(run);
    assert.ok(performance.now() - t < 50, `a run of ${run[1]} took ${performance.now() - t} ms`);
  }
  assert.deepEqual(extractPlannedPaths('Edit src/a.js... then docs/b.md.'), ['src/a.js', 'docs/b.md'], 'trailing dots end a sentence, not a path');
  assert.deepEqual(extractPlannedPaths(' '.repeat(70 * 1024) + 'src/late.js'), [], 'text past the 64 KB cap is not read');
  assert.deepEqual(extractPlannedPaths('see https://x.example/src/a.js and src/b.js'), ['src/b.js']);
});

test('driftOfCall compares real paths when the checkout is reached through a symlink (macOS /var → /private/var)', (t) => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'quill-drift-real-'));
  const link = `${real}-link`;
  try { fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir'); } catch { t.skip('symlinks unavailable'); return; }
  try {
    const grant = { plannedPaths: ['src.js'], checkoutRoot: link };
    assert.equal(driftOfCall('Write', { file_path: 'other.js' }, grant, real), true, 'cwd is the real path, the grant names the link');
    assert.equal(driftOfCall('Write', { file_path: 'src.js' }, grant, real), false);
    assert.equal(driftOfCall('Write', { file_path: path.join(os.tmpdir(), 'elsewhere.js') }, grant, real), false, 'outside the checkout is not drift');
  } finally {
    fs.rmSync(link, { recursive: true, force: true });
    fs.rmSync(real, { recursive: true, force: true });
  }
});
