// Run snapshots (ADR 0035) against real temporary repositories: a temporary index, refs that
// survive gc, and a restore that never deletes uncommitted work it did not capture first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeRepo, git } from './helpers.js';
import { snapshotTree, restoreSnapshot, archiveRefs } from '../../src/handoff/snapshots.js';

const HID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8');
const write = (dir, f, text) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text); };

// A detached worktree of a fresh repository, as a run's checkout is.
function checkout() {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo.dir, '.gitignore'), '.env\nbuild/\n');
  git(repo.dir, 'add', '.gitignore');
  git(repo.dir, 'commit', '-q', '-m', 'ignore');
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'st-snapwt-')), HID);
  git(repo.dir, 'worktree', 'add', '-q', '--detach', dir, 'HEAD');
  return { repo: repo.dir, dir };
}

test('a snapshot captures tracked and untracked files under a ref, leaving the real index and HEAD alone', async () => {
  const { repo, dir } = checkout();
  write(dir, 'src.js', 'export const a = 2;\n');
  write(dir, 'new/file.txt', 'new\n');
  write(dir, '.env', 'TOKEN=keep-me\n');
  git(dir, 'add', 'src.js');
  const indexBefore = git(dir, 'diff', '--cached', '--name-only');
  const headBefore = git(dir, 'rev-parse', 'HEAD');
  const s = await snapshotTree(dir, { handoffId: HID, step: 'agent', n: 1 });
  assert.match(s.tree, /^[0-9a-f]{40}$/);
  assert.equal(s.ref, `refs/quill/snapshots/${HID}/01-agent`);
  assert.equal(git(repo, 'rev-parse', s.ref), s.commit, 'the ref lives in the shared repository');
  assert.equal(git(dir, 'rev-parse', `${s.commit}^`), headBefore, 'the snapshot commit sits on HEAD');
  assert.equal(git(dir, 'rev-parse', 'HEAD'), headBefore);
  assert.equal(git(dir, 'diff', '--cached', '--name-only'), indexBefore, 'the real index is untouched');
  assert.match(git(dir, 'status', '--porcelain'), /\?\? new\//, 'untracked files stay untracked');
  const files = git(dir, 'ls-tree', '-r', '--name-only', s.commit).split('\n');
  assert.ok(files.includes('new/file.txt') && files.includes('src.js'));
  assert.ok(!files.includes('.env'), 'ignored files are not captured');
  assert.equal(git(dir, 'show', `${s.commit}:src.js`), 'export const a = 2;');
  assert.equal(s.files_changed, 2, 'src.js and new/file.txt differ from HEAD');
});

test('files_changed counts against the previous snapshot; an existing ref is never overwritten', async () => {
  const { dir } = checkout();
  const a = await snapshotTree(dir, { handoffId: HID, step: 'start', n: 0 });
  assert.equal(a.files_changed, 0);
  write(dir, 'src.js', 'export const a = 3;\n');
  const b = await snapshotTree(dir, { handoffId: HID, step: 'agent', n: 1, against: a.tree });
  assert.equal(b.files_changed, 1);
  // The same name again (a crash between the ref and its event): a new name, the old ref kept.
  write(dir, 'src.js', 'export const a = 4;\n');
  const c = await snapshotTree(dir, { handoffId: HID, step: 'agent', n: 1 });
  assert.notEqual(c.ref, b.ref);
  assert.equal(git(dir, 'rev-parse', b.ref), b.commit);
});

test('snapshot refs survive git gc --prune=now', async () => {
  const { repo, dir } = checkout();
  write(dir, 'only-here.txt', 'uncommitted work\n');
  const s = await snapshotTree(dir, { handoffId: HID, step: 'agent', n: 1 });
  git(repo, 'gc', '--prune=now', '--quiet');
  assert.equal(git(repo, 'cat-file', '-t', s.commit), 'commit');
  assert.equal(git(repo, 'show', `${s.commit}:only-here.txt`), 'uncommitted work');
});

test('restore takes a pre-restore snapshot, writes the target files and removes only captured files', async () => {
  const { dir } = checkout();
  write(dir, 'src.js', 'export const a = 2;\n');
  const target = await snapshotTree(dir, { handoffId: HID, step: 'agent', n: 1 });
  // After the snapshot: an edit, a new untracked file, a deleted file and an ignored secret.
  write(dir, 'src.js', 'export const a = 99;\n');
  write(dir, 'later/added.txt', 'added later\n');
  fs.rmSync(path.join(dir, 'README.md'));
  write(dir, '.env', 'TOKEN=keep-me\n');
  write(dir, 'build/out.bin', 'artifact\n');
  git(dir, 'add', 'src.js');
  const index = fs.readFileSync(path.join(git(dir, 'rev-parse', '--absolute-git-dir'), 'index'));
  const out = restoreSnapshot(dir, target.commit, { handoffId: HID, n: 2 });
  assert.deepEqual(out.restored.sort(), ['README.md', 'src.js']);
  assert.deepEqual(out.removed, ['later/added.txt']);
  assert.deepEqual(out.skipped, []);
  assert.equal(read(dir, 'src.js'), 'export const a = 2;\n');
  assert.equal(read(dir, 'README.md'), '# demo\n');
  assert.equal(fs.existsSync(path.join(dir, 'later')), false, 'emptied directories go too');
  assert.equal(read(dir, '.env'), 'TOKEN=keep-me\n', 'an ignored file is never touched');
  assert.equal(read(dir, 'build/out.bin'), 'artifact\n');
  assert.ok(index.equals(fs.readFileSync(path.join(git(dir, 'rev-parse', '--absolute-git-dir'), 'index'))), 'the real index is untouched');
  // Everything the restore replaced is in the pre-restore snapshot.
  assert.equal(out.pre.ref, `refs/quill/snapshots/${HID}/02-pre-restore`);
  assert.equal(git(dir, 'show', `${out.pre.commit}:src.js`), 'export const a = 99;');
  assert.equal(git(dir, 'show', `${out.pre.commit}:later/added.txt`), 'added later');
  assert.ok(Number.isInteger(out.pre.files_changed));
});

test('restore never overwrites a file the pre-restore snapshot could not hold', async () => {
  const { dir } = checkout();
  write(dir, 'notes.local', 'v1\n');
  const target = await snapshotTree(dir, { handoffId: HID, step: 'agent', n: 1 });
  // The owner now ignores it and keeps writing there.
  fs.appendFileSync(path.join(dir, '.gitignore'), 'notes.local\n');
  write(dir, 'notes.local', 'my uncommitted notes\n');
  const out = restoreSnapshot(dir, target.commit, { handoffId: HID, n: 2 });
  assert.deepEqual(out.skipped, ['notes.local']);
  assert.equal(read(dir, 'notes.local'), 'my uncommitted notes\n');
  assert.ok(out.restored.includes('.gitignore'));
});

test('the pre-restore callback runs before anything is written, and a refusal stops the restore', async () => {
  const { dir } = checkout();
  const target = await snapshotTree(dir, { handoffId: HID, step: 'start', n: 0 });
  write(dir, 'src.js', 'changed\n');
  assert.throws(() => restoreSnapshot(dir, target.commit, { handoffId: HID, n: 1, onPreRestore: (pre) => { assert.equal(read(dir, 'src.js'), 'changed\n'); assert.match(pre.commit, /^[0-9a-f]{40}$/); throw new Error('not recorded'); } }), /not recorded/);
  assert.equal(read(dir, 'src.js'), 'changed\n');
  assert.throws(() => restoreSnapshot(dir, 'HEAD', { handoffId: HID, n: 2 }), (e) => e.code === 'snapshot-invalid');
});

test('archiveRefs moves a run\'s snapshot refs under refs/quill/archive and the commits stay reachable', async () => {
  const { repo, dir } = checkout();
  const a = await snapshotTree(dir, { handoffId: HID, step: 'start', n: 0 });
  const b = await snapshotTree(dir, { handoffId: HID, step: 'agent', n: 1 });
  const other = await snapshotTree(dir, { handoffId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', step: 'start', n: 0 });
  git(repo, 'worktree', 'remove', '--force', dir);
  const moved = await archiveRefs(repo, HID);
  assert.deepEqual(moved, { [a.ref]: `refs/quill/archive/${HID}/00-start`, [b.ref]: `refs/quill/archive/${HID}/01-agent` });
  assert.equal(git(repo, 'for-each-ref', '--format=%(refname)', `refs/quill/snapshots/${HID}/`), '');
  assert.equal(git(repo, 'rev-parse', `refs/quill/archive/${HID}/01-agent`), b.commit);
  assert.equal(git(repo, 'rev-parse', other.ref), other.commit, 'another run\'s refs stay');
  git(repo, 'gc', '--prune=now', '--quiet');
  assert.equal(git(repo, 'cat-file', '-t', a.commit), 'commit');
  assert.deepEqual(await archiveRefs(repo, HID), {}, 'nothing left to move');
});

test('restore skips a path whose parent is now an ignored file the pre-restore snapshot could not hold', async () => {
  const { dir } = checkout();
  write(dir, 'out/x.js', 'generated\n');
  const target = await snapshotTree(dir, { handoffId: HID, step: 'agent', n: 1 });
  // Later `out` is ignored and is a file with the owner's data in it.
  fs.rmSync(path.join(dir, 'out'), { recursive: true });
  fs.appendFileSync(path.join(dir, '.gitignore'), 'out\n');
  write(dir, 'out', 'my uncommitted data\n');
  const out = restoreSnapshot(dir, target.commit, { handoffId: HID, n: 2 });
  assert.ok(out.skipped.includes('out/x.js'), `skipped: ${out.skipped}`);
  assert.ok(!out.restored.includes('out/x.js'));
  assert.equal(read(dir, 'out'), 'my uncommitted data\n', 'the ignored file is still there');
  assert.ok(out.restored.includes('.gitignore'));
});

test('restore skips a path whose parent is now an ignored symlink', async (t) => {
  const { dir } = checkout();
  write(dir, 'lib/x.js', 'generated\n');
  const target = await snapshotTree(dir, { handoffId: HID, step: 'agent', n: 1 });
  fs.rmSync(path.join(dir, 'lib'), { recursive: true });
  fs.appendFileSync(path.join(dir, '.gitignore'), 'lib\n');
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'st-snaplink-'));
  write(elsewhere, 'keep.txt', 'outside\n');
  try { fs.symlinkSync(elsewhere, path.join(dir, 'lib'), 'junction'); } catch { t.skip('no symlink support'); return; }
  const out = restoreSnapshot(dir, target.commit, { handoffId: HID, n: 2 });
  assert.ok(out.skipped.includes('lib/x.js'), `skipped: ${out.skipped}`);
  assert.ok(fs.lstatSync(path.join(dir, 'lib')).isSymbolicLink(), 'the link stays');
  assert.equal(fs.existsSync(path.join(elsewhere, 'x.js')), false, 'nothing is written through the link');
  assert.equal(read(elsewhere, 'keep.txt'), 'outside\n');
});

test('restore of a file where a directory now holds unsaved files skips it; a directory of saved files gives way', async () => {
  const { dir } = checkout();
  write(dir, 'a', 'file a\n');
  write(dir, 'c', 'file c\n');
  const target = await snapshotTree(dir, { handoffId: HID, step: 'agent', n: 1 });
  fs.rmSync(path.join(dir, 'a'));
  fs.rmSync(path.join(dir, 'c'));
  write(dir, 'a/b', 'saved\n');
  write(dir, 'a/.cache', 'ignored, never saved\n');
  write(dir, 'c/d', 'saved too\n');
  fs.appendFileSync(path.join(dir, '.gitignore'), '.cache\n');
  const out = restoreSnapshot(dir, target.commit, { handoffId: HID, n: 2 });
  assert.ok(out.skipped.includes('a'), `skipped: ${out.skipped}`);
  assert.equal(read(dir, 'a/.cache'), 'ignored, never saved\n', 'the unsaved file is still there');
  assert.equal(git(dir, 'show', `${out.pre.commit}:a/b`), 'saved', 'what went is in the pre-restore snapshot');
  assert.ok(out.restored.includes('c'));
  assert.equal(read(dir, 'c'), 'file c\n');
});
