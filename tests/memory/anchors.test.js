// Anchored memory (ADR 0032): anchors at filing, the changed-ratio verdict, delivery and the
// worker's HEAD check that journals `staled`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { anchorCheckKey, symbolAt, declaredName, splitLines, changedRatio, anchorStaleRatio, staledEvent, anchorCandidates, makeAnchor, validAnchors, fileAnchors, SYMBOL_WINDOW, DEFAULT_ANCHOR_STALE_RATIO } from '../../src/memory/anchors.js';
import { fileLearnings, blobSha } from '../../src/memory/file.js';
import { anchorVerdicts, gatherMemory, SOURCE_CHANGED_HEADING, RECHECK_SUFFIX } from '../../src/memory/deliver.js';
import { memoryListing } from '../../src/core/memory.js';
import { newState, ev, createTicket } from '../core/helpers.js';
import { makeRepo, git, bootWorker } from '../handoff/helpers.js';

const dirs = [];
after(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* left for the temp root */ } } });
const AT = '2026-10-12T10:00:00Z';
const lines = (n, f = (i) => `const line${i} = ${i};`) => Array.from({ length: n }, (_, i) => f(i + 1));
const text = (arr) => `${arr.join('\n')}\n`;

test('a cite anchors to the nearest declaration within five lines, the line itself first, above before below', () => {
  const src = splitLines(['// header', 'export function retry(fn, attempts) {', '  let i = 0;', '  while (i < attempts) {', '    i += 1;', '  }', '}', '', '', '', '', '', '', 'class Queue {'].join('\n'));
  assert.equal(symbolAt(src, 2), 'retry', 'the cited line itself');
  assert.equal(symbolAt(src, 5), 'retry', 'three lines above');
  assert.equal(symbolAt(src, 7), 'retry', 'five lines above');
  assert.equal(symbolAt(src, 9), 'Queue', 'five lines below');
  assert.equal(symbolAt(['function up() {', '  x();', '  y();', '  z();', 'function down() {'], 3), 'up', 'equal distance: above wins');
  const far = splitLines(text(['function far() {', ...lines(6, () => '  x();'), '}']));
  assert.equal(symbolAt(far, 8), null, `nothing within ${SYMBOL_WINDOW} lines`);
  for (const [line, name] of [['def parse(self):', 'parse'], ['func (s *Server) Serve() error {', 'Serve'], ['  async load(id) {', 'load'], ['type Opts = {', 'Opts'], ['pub fn main() {', 'main'], ['if (x) {', null], ['  return compute(a);', null]]) {
    assert.equal(declaredName(line), name, line);
  }
  assert.deepEqual(makeAnchor({ file_path: 'a.js', blob_sha: 'a'.repeat(40), line: 3, text: Buffer.from('function a() {\n  x;\n  y;\n}\n') }), { file_path: 'a.js', blob_sha: 'a'.repeat(40), line: 3, symbol_name: 'a' });
});

test('changed ratio: 0 when the anchored region is intact or only moved, high when it is rewritten, 1 when its symbol is gone', () => {
  const fn = ['export function retry(fn, attempts) {', ...lines(8, (i) => `  step${i}();`), '}'];
  const old = text([...lines(30), ...fn, ...lines(30, (i) => `const tail${i} = ${i};`)]);
  const a = { line: 33, symbol_name: 'retry' };
  assert.equal(changedRatio(old, old, a), 0);
  // Twenty lines inserted above and an edit far below: the region moved, nothing in it changed.
  const moved = text([...lines(30), ...lines(20, (i) => `const extra${i} = ${i};`), ...fn, ...lines(30, (i) => `const tail${i} = ${i > 10 ? i * 2 : i};`)]);
  assert.equal(changedRatio(old, moved, a), 0);
  // One line of the body changed: a small share of the 21-line window.
  const small = old.replace('  step2();', '  step2(true);');
  const r1 = changedRatio(old, small, a);
  assert.ok(r1 > 0 && r1 < DEFAULT_ANCHOR_STALE_RATIO, `small edit: ${r1}`);
  // The whole body rewritten.
  const rewritten = old.replace(/ {2}step(\d)\(\);/g, '  other$1(await x);');
  const r2 = changedRatio(old, rewritten, a);
  assert.ok(r2 >= DEFAULT_ANCHOR_STALE_RATIO, `rewrite: ${r2}`);
  // The function renamed away.
  assert.equal(changedRatio(old, old.replace('function retry', 'function again'), a), 1);
  // No symbol: the anchored line's own text is followed.
  const plain = { line: 10, symbol_name: null };
  assert.equal(changedRatio(text(lines(40)), text([...lines(5, (i) => `const pre${i} = 0;`), ...lines(40)]), plain), 0);
  assert.equal(changedRatio(text(lines(40)), '', plain), 1);
  assert.equal(changedRatio(text(lines(5)), text(lines(5)), { line: 9 }), 1, 'an anchor past the end');
});

test('anchor_stale_ratio comes from [memory], 0.3 unless it is a number above 0 and at most 1', () => {
  assert.equal(anchorStaleRatio({}), 0.3);
  assert.equal(anchorStaleRatio({ memory: { anchor_stale_ratio: 0.5 } }), 0.5);
  assert.equal(anchorStaleRatio({ memory: { anchor_stale_ratio: 1 } }), 1);
  for (const bad of [0, -1, 2, '0.5', null, Number.NaN]) assert.equal(anchorStaleRatio({ memory: { anchor_stale_ratio: bad } }), 0.3, String(bad));
});

test('staledEvent has the payload and source identity the contract names', () => {
  const e = staledEvent('m1', { file_path: 'a.js', blob_sha: 'a'.repeat(40), current_blob_sha: 'b'.repeat(40), changed_ratio: 0.5 });
  assert.deepEqual(e, { kind: 'memory-tx', payload: { op: 'staled', entry: { id: 'm1' }, reason: 'anchor-changed', anchor: { file_path: 'a.js', blob_sha: 'a'.repeat(40), current_blob_sha: 'b'.repeat(40), changed_ratio: 0.5 } }, source_identity: `memory-tx:anchor:m1:${'b'.repeat(40)}` });
  assert.equal(staledEvent('m1', { file_path: 'a.js', blob_sha: 'a'.repeat(40), current_blob_sha: null, changed_ratio: 1 }).source_identity, 'memory-tx:anchor:m1:missing');
});

// A repository with src/retry.js whose retry() sits at lines 31-40.
function anchoredRepo() {
  const repo = makeRepo();
  dirs.push(repo.dir);
  const fn = ['export function retry(fn, attempts) {', ...lines(8, (i) => `  step${i}();`), '}'];
  fs.writeFileSync(path.join(repo.dir, 'retry.js'), text([...lines(30), ...fn, ...lines(10, (i) => `const tail${i} = ${i};`)]));
  git(repo.dir, 'add', '.');
  git(repo.dir, 'commit', '-qm', 'retry');
  return { ...repo, base: git(repo.dir, 'rev-parse', 'HEAD') };
}
const commitFile = (dir, name, body) => { fs.writeFileSync(path.join(dir, name), body); git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'change'); return git(dir, 'rev-parse', 'HEAD'); };

test('filing a sourced learning records its anchors: file, blob at the base commit, line and symbol', () => {
  const repo = anchoredRepo();
  const s = newState();
  const t = createTicket(s);
  const run = { id: 'run-anchor-1', ticket_id: t.id, repo_id: 'demo', base_commit: repo.base, changed_files: [] };
  const learnings = [{ scope: 'repo', section: 'Pitfalls', kind: 'pitfall', text: 'retry() counts from zero', evidence: ['retry.js:34', 'src.js:1'], derived_from: 'repo-file' }];
  const events = fileLearnings({ learnings, run, checkout: repo.dir, existing: s.memory.entries, now: AT });
  const filed = events.find((e) => e.payload.op === 'filed').payload.entry;
  assert.equal(filed.trust, 'sourced');
  assert.deepEqual(filed.anchors, [
    { file_path: 'retry.js', blob_sha: git(repo.dir, 'rev-parse', `${repo.base}:retry.js`), line: 34, symbol_name: 'retry' },
    { file_path: 'src.js', blob_sha: blobSha(Buffer.from('export const a = 1;\n')), line: 1, symbol_name: 'a' },
  ]);
  assert.match(filed.evidence[0], / @blob:[0-9a-f]{40}$/, 'evidence keeps its pins');
  for (const e of events) ev(s, e.kind, e.payload, { source_identity: e.source_identity, occurred_at: AT });
  assert.deepEqual(s.memory.entries.get(filed.id).anchors, filed.anchors, 'the reducer keeps them');
  // A learning that does not verify is quarantined with no anchors.
  const bad = fileLearnings({ learnings: [{ ...learnings[0], evidence: ['retry.js:999'] }], run: { ...run, id: 'run-anchor-2' }, checkout: repo.dir, existing: [], now: AT });
  assert.equal(bad[0].payload.entry.anchors, undefined);
  // A later run that confirms the learning re-anchors it at the version it checked.
  const head = commitFile(repo.dir, 'retry.js', `// moved\n${fs.readFileSync(path.join(repo.dir, 'retry.js'), 'utf8')}`);
  const again = fileLearnings({ learnings: [{ ...learnings[0], evidence: ['retry.js:35'] }], run: { ...run, id: 'run-anchor-3', base_commit: head }, checkout: repo.dir, existing: s.memory.entries, now: AT });
  const confirmed = again.find((e) => e.payload.op === 'confirmed');
  assert.equal(confirmed.payload.entry.id, filed.id);
  assert.deepEqual(confirmed.payload.entry.anchors.map((a) => [a.file_path, a.line, a.blob_sha]), [['retry.js', 35, git(repo.dir, 'rev-parse', `${head}:retry.js`)]]);
});

function seedAnchored(s, repo, { id = 'anc', pinned = false, trust = 'sourced', scope = 'repo', line = 34, symbol = 'retry' } = {}) {
  const blob = git(repo.dir, 'rev-parse', `${repo.base}:retry.js`);
  const entry = { id, scope, section: 'pitfalls', kind: 'pitfall', text: `anchored ${id}`, evidence: [`retry.js:${line} @blob:${blob}`], derived_from: 'repo-file', trust, pinned, created_at: AT, anchors: [{ file_path: 'retry.js', blob_sha: blob, line, symbol_name: symbol }] };
  if (scope === 'repo') entry.repo_id = 'demo';
  assert.equal(ev(s, 'memory-tx', { op: 'filed', entry }, { occurred_at: AT }).rejected, undefined);
  return blob;
}

test('verdicts: same when the region is intact, re-check below the ratio, stale at or above it; pinned and machine entries are never stale; a git failure stales nothing', async () => {
  const repo = anchoredRepo();
  const s = newState();
  seedAnchored(s, repo);
  seedAnchored(s, repo, { id: 'pin', pinned: true });
  seedAnchored(s, repo, { id: 'mach', scope: 'machine' });
  const opts = { checkout: repo.dir };
  const entries = () => [...s.memory.entries.values()];
  assert.deepEqual([...(await anchorVerdicts(entries(), opts))].map(([id, v]) => [id, v.verdict]), [['anc', 'same'], ['pin', 'same'], ['mach', 'same']]);
  const original = fs.readFileSync(path.join(repo.dir, 'retry.js'), 'utf8');
  commitFile(repo.dir, 'retry.js', original.replace('  step2();', '  step2(true);'));
  assert.equal((await anchorVerdicts(entries(), opts)).get('anc').verdict, 'recheck');
  const head = commitFile(repo.dir, 'retry.js', original.replace(/ {2}step(\d)\(\);/g, '  other$1(await x);'));
  const v = await anchorVerdicts(entries(), opts);
  assert.equal(v.get('anc').verdict, 'stale');
  assert.equal(v.get('anc').anchor.current_blob_sha, git(repo.dir, 'rev-parse', `${head}:retry.js`));
  assert.ok(v.get('anc').anchor.changed_ratio >= 0.3);
  assert.equal(v.get('pin').verdict, 'recheck', 'R27: pinned is never stale');
  assert.equal(v.get('mach').verdict, 'recheck');
  assert.equal((await anchorVerdicts(entries(), { ...opts, ratio: 1 })).get('anc').verdict, 'recheck', 'a higher ratio tolerates it');
  // The base commit decides, not the working tree's HEAD.
  assert.equal((await anchorVerdicts(entries(), { ...opts, commit: repo.base })).get('anc').verdict, 'same');
  // A deleted file is fully changed.
  commitFile(repo.dir, 'retry.js', '');
  fs.rmSync(path.join(repo.dir, 'retry.js'));
  git(repo.dir, 'commit', '-qam', 'gone');
  assert.equal((await anchorVerdicts(entries(), opts)).get('anc').anchor.current_blob_sha, null);
  // git cannot run here: nothing is called stale.
  const logs = [];
  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'st-norepo-'));
  dirs.push(notRepo);
  const failed = await anchorVerdicts(entries(), { checkout: notRepo, log: (l) => logs.push(l) });
  assert.deepEqual([...failed.values()].map((x) => x.verdict), ['recheck', 'recheck', 'recheck']);
  assert.equal(logs.length, 1);
});

test('delivery leaves out an entry whose anchored source changed and counts it, with the entries the worker already staled', async () => {
  const repo = anchoredRepo();
  const s = newState();
  const t = createTicket(s);
  seedAnchored(s, repo, { id: 'big' });
  seedAnchored(s, repo, { id: 'small', line: 10, symbol: null });
  seedAnchored(s, repo, { id: 'was' });
  ev(s, 'memory-tx', { op: 'staled', entry: { id: 'was' }, reason: 'anchor-changed', anchor: { file_path: 'retry.js', blob_sha: 'a'.repeat(40), current_blob_sha: 'b'.repeat(40), changed_ratio: 0.9 } }, { occurred_at: AT });
  const original = fs.readFileSync(path.join(repo.dir, 'retry.js'), 'utf8');
  commitFile(repo.dir, 'retry.js', original.replace(/ {2}step(\d)\(\);/g, '  other$1(await x);').replace('const line12 = 12;', 'const line12 = 120;'));
  const m = await gatherMemory(s, t, { repoCfg: { id: 'demo' }, checkout: repo.dir, now: AT });
  assert.doesNotMatch(m.inline, /anchored big/);
  assert.doesNotMatch(m.inline, /anchored was/);
  assert.ok(m.inline.split('\n').find((l) => l.includes('anchored small')).endsWith(RECHECK_SUFFIX));
  assert.match(m.inline, new RegExp(`Left out here \\(heading: items\\): ${SOURCE_CHANGED_HEADING}: 2\\.$`));
  assert.equal(SOURCE_CHANGED_HEADING, 'Source changed since recorded, not delivered');
});

test('the worker checks anchors against HEAD when it moves and journals staled once per file version; pinned entries are left alone', async () => {
  const repo = anchoredRepo();
  const b = await bootWorker({ repo, runtimeAvailable: true });
  try {
    const blob = git(repo.dir, 'rev-parse', `${repo.base}:retry.js`);
    const file = (id, extra = {}) => b.w.emit('memory-tx', { op: 'filed', entry: { id, scope: 'repo', repo_id: 'demo', section: 'pitfalls', kind: 'pitfall', text: `anchored ${id}`, evidence: [`retry.js:34 @blob:${blob}`], derived_from: 'repo-file', trust: 'sourced', anchors: [{ file_path: 'retry.js', blob_sha: blob, line: 34, symbol_name: 'retry' }], ...extra } }, { source_identity: `test:${id}` });
    file('w1');
    file('w2', { pinned: true });
    assert.deepEqual(anchorCandidates(b.w.state, 'demo').map((e) => e.id), ['w1'], 'R27: a pinned entry is not a candidate');
    await b.hext.checkAnchors();
    assert.equal(b.w.state.memory.entries.get('w1').state, 'active', 'unchanged source');
    const original = fs.readFileSync(path.join(repo.dir, 'retry.js'), 'utf8');
    const head = commitFile(repo.dir, 'retry.js', original.replace(/ {2}step(\d)\(\);/g, '  other$1(await x);'));
    await b.hext.checkAnchors();
    const e = b.w.state.memory.entries.get('w1');
    assert.deepEqual([e.state, e.stale_reason, e.stale_anchor.current_blob_sha], ['stale', 'anchor-changed', git(repo.dir, 'rev-parse', `${head}:retry.js`)]);
    assert.equal(b.w.state.memory.entries.get('w2').state, 'active');
    assert.equal(memoryListing(b.w.state, Date.parse(AT)).entries.find((x) => x.id === 'w1').stale_reason, 'anchor-changed');
    // A run confirms it again (without re-anchoring): the same file version never stales it twice.
    b.w.emit('memory-tx', { op: 'confirmed', entry: { id: 'w1' } }, { source_identity: 'test:confirm' });
    assert.equal(b.w.state.memory.entries.get('w1').state, 'active');
    commitFile(repo.dir, 'README.md', '# demo again\n');
    await b.hext.checkAnchors();
    assert.equal(b.w.state.memory.entries.get('w1').state, 'active', 'the source identity of that version is already journaled');
    // The tick runs it too, throttled.
    b.w.tick();
    b.w.tick();
  } finally { await b.w.stop(); }
});

// ADR 0041: a run-env anchor sits beside file anchors; every file-anchor reader skips it.
test('a run-env anchor is kept beside the file anchors, one per entry; file checks and candidates ignore it', async () => {
  const repo = anchoredRepo();
  const blob = git(repo.dir, 'rev-parse', `${repo.base}:retry.js`);
  const fileA = { file_path: 'retry.js', blob_sha: blob, line: 34, symbol_name: 'retry' };
  const envA = { kind: 'run-env', env_fingerprint: 'c'.repeat(16) };
  const many = Array.from({ length: 12 }, (_, i) => ({ ...fileA, line: i + 1 }));
  const kept = validAnchors([...many, envA, { kind: 'run-env', env_fingerprint: 'd'.repeat(16) }, { kind: 'run-env', env_fingerprint: 'not hex' }, { kind: 'other' }]);
  assert.equal(kept.filter((a) => !a.kind).length, 10, 'ten file anchors at most');
  assert.deepEqual(kept.filter((a) => a.kind), [envA], 'one run-env anchor, the first valid one');
  assert.deepEqual(fileAnchors([fileA, envA]), [fileA]);
  const s = newState();
  const base = { scope: 'repo', repo_id: 'demo', section: 'pitfalls', kind: 'pitfall', evidence: [`retry.js:34 @blob:${blob}`], derived_from: 'repo-file', trust: 'sourced', created_at: AT };
  ev(s, 'memory-tx', { op: 'filed', entry: { ...base, id: 'both', text: 'both', anchors: [fileA, envA] } }, { occurred_at: AT });
  ev(s, 'memory-tx', { op: 'filed', entry: { ...base, id: 'env', text: 'env only', anchors: [envA] } }, { occurred_at: AT });
  assert.deepEqual(s.memory.entries.get('both').anchors, [fileA, envA]);
  assert.deepEqual(anchorCandidates(s, 'demo').map((e) => e.id), ['both'], 'an entry with only a run-env anchor has no file to check');
  const v = await anchorVerdicts([...s.memory.entries.values()], { checkout: repo.dir });
  assert.equal(v.get('both').verdict, 'same');
  // A sourced confirmation re-anchors the files and keeps the run-env anchor.
  const moved = { ...fileA, line: 35 };
  ev(s, 'memory-tx', { op: 'confirmed', entry: { id: 'both', anchors: [moved] } }, { occurred_at: AT });
  assert.deepEqual(s.memory.entries.get('both').anchors, [moved, envA]);
});

test('the worker re-checks when one anchored entry is swapped for another at the same HEAD', async () => {
  const repo = anchoredRepo();
  const b = await bootWorker({ repo, runtimeAvailable: true });
  try {
    const original = fs.readFileSync(path.join(repo.dir, 'retry.js'), 'utf8');
    const head = commitFile(repo.dir, 'retry.js', original.replace(/ {2}step(\d)\(\);/g, '  other$1(await x);'));
    const old = git(repo.dir, 'rev-parse', `${repo.base}:retry.js`);
    const now = git(repo.dir, 'rev-parse', `${head}:retry.js`);
    const file = (id, blob) => b.w.emit('memory-tx', { op: 'filed', entry: { id, scope: 'repo', repo_id: 'demo', section: 'pitfalls', kind: 'pitfall', text: `anchored ${id}`, evidence: [`retry.js:34 @blob:${blob}`], derived_from: 'repo-file', trust: 'sourced', anchors: [{ file_path: 'retry.js', blob_sha: blob, line: 34, symbol_name: 'retry' }] } }, { source_identity: `test:${id}` });
    file('current', now);
    await b.hext.checkAnchors();
    assert.equal(b.w.state.memory.entries.get('current').state, 'active');
    // Same HEAD, same number of candidates, a different entry anchored to the old version.
    b.w.emit('memory-tx', { op: 'retired', entry: { id: 'current' } }, { source_identity: 'test:retire' });
    file('older', old);
    assert.deepEqual(anchorCandidates(b.w.state, 'demo').map((e) => e.id), ['older']);
    await b.hext.checkAnchors();
    assert.equal(b.w.state.memory.entries.get('older').state, 'stale', 'the swapped-in entry was checked');
    // A confirmation that re-anchors the same entry at the same HEAD is a new check too; order does not matter.
    const at = (id, blob) => ({ id, anchors: [{ file_path: 'retry.js', blob_sha: blob, line: 34, symbol_name: 'retry' }] });
    assert.notEqual(anchorCheckKey(head, [at('x', old)]), anchorCheckKey(head, [at('x', now)]));
    assert.equal(anchorCheckKey(head, [at('x', old), at('y', now)]), anchorCheckKey(head, [at('y', now), at('x', old)]));
  } finally { await b.w.stop(); }
});
