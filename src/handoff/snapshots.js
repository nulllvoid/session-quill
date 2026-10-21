// Run snapshots (ADR 0035, FR-1.2): the worker snapshots a fix run's checkout at step boundaries,
// and the owner can restore one from run detail. A snapshot is a commit of the checkout's files
// (tracked, and untracked files that are not ignored) built with a temporary index, so the run's
// real index, HEAD and branch are never touched; a ref under refs/quill/snapshots/<run id>/ keeps it
// alive through `git gc`. When the checkout is removed the refs move to refs/quill/archive/<run id>/.
//
// A restore first snapshots the checkout as it is now (pre-restore), then writes the target's files
// and deletes only files the pre-restore snapshot holds that the target lacks. Ignored files are
// never captured, so they are never deleted or overwritten; a target file whose path, or a folder on
// its way, is now taken by something the pre-restore snapshot could not hold is skipped. Nothing the
// restore replaces is lost.
//
// Every git call runs without inherited GIT_* overrides, replace refs or grafts (cleanGitEnv), with
// hooks and the fsmonitor off: the checkout's configuration is the agent's to edit.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { TrackerError } from '../lib/errors.js';
import { deterministicId } from '../lib/ids.js';
import { handoffsDir } from '../lib/paths.js';
import { cleanGitEnv } from '../memory/file.js';
import { isUnder } from './worktree.js';
import { SNAPSHOT_CAP, SNAPSHOT_STEPS, STEP_LABELS, SNAPSHOT_REF_ROOT, ARCHIVE_REF_ROOT } from '../core/reduce/snapshots.js';

export { SNAPSHOT_CAP, SNAPSHOT_STEPS, STEP_LABELS, SNAPSHOT_REF_ROOT, ARCHIVE_REF_ROOT };

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const GIT_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 64 * 1024 * 1024;
const NO_HOOKS = path.join(os.tmpdir(), 'quill-no-hooks-here');
const PREFIX = ['-c', `core.hooksPath=${NO_HOOKS}`, '-c', 'core.fsmonitor=false', '--no-replace-objects'];
const IDENTITY = { GIT_AUTHOR_NAME: 'Session Quill snapshot', GIT_AUTHOR_EMAIL: 'quill@localhost', GIT_COMMITTER_NAME: 'Session Quill snapshot', GIT_COMMITTER_EMAIL: 'quill@localhost' };
const ACTIVE = new Set(['queued', 'running']);

const pad = (n) => String(n).padStart(2, '0');
const failed = (err, args) => new TrackerError('snapshot-failed', String((err && err.stderr) || (err && err.message) || 'git failed').trim().split('\n')[0], { args });
const optionsFor = (cwd, step) => ({ cwd, env: { ...cleanGitEnv(), ...(step.env ?? {}) }, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true, encoding: 'utf8' });
const output = (stdout, step) => (step.raw ? stdout : stdout.trim());

function gitSync(cwd, step) {
  try {
    return output(execFileSync('git', [...PREFIX, ...step.args], { ...optionsFor(cwd, step), input: step.input ?? '', stdio: ['pipe', 'pipe', 'pipe'] }), step);
  } catch (err) { throw failed(err, step.args); }
}

function gitAsync(cwd, step) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', [...PREFIX, ...step.args], optionsFor(cwd, step), (err, stdout, stderr) => (err ? reject(failed({ stderr, message: err.message }, step.args)) : resolve(output(stdout, step))));
    child.stdin.end(step.input ?? '');
  });
}

// The git work is written once, as generators yielding { args, env, input, raw }, and driven
// asynchronously (a run's step snapshots) or synchronously (a restore, applied inside the request
// loop like undo-file-effect). A failed call is thrown back into the generator, so its own
// try/finally (the temporary index) always runs.
function drive(gen, run) {
  let r = gen.next();
  while (!r.done) {
    let out;
    try { out = run(r.value); } catch (err) { r = gen.throw(err); continue; }
    r = gen.next(out);
  }
  return r.value;
}

async function driveAsync(gen, run) {
  let r = gen.next();
  while (!r.done) {
    let out;
    try { out = await run(r.value); } catch (err) { r = gen.throw(err); continue; }
    r = gen.next(out);
  }
  return r.value;
}

const tempIndex = () => path.join(os.tmpdir(), `quill-snapshot-${randomUUID()}.index`);
const dropIndex = (file) => { for (const f of [file, `${file}.lock`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } };
const names = (raw) => raw.split('\0').filter(Boolean);

function* snapshotSteps(dir, { handoffId, step, n, indexPath = null, against = null, atHead = false }) {
  if (typeof handoffId !== 'string' || !SAFE_ID.test(handoffId)) throw new TrackerError('snapshot-invalid', 'a snapshot needs the run id');
  if (!SNAPSHOT_STEPS.includes(step)) throw new TrackerError('snapshot-invalid', `unknown snapshot step ${step}`);
  if (!Number.isInteger(n) || n < 0) throw new TrackerError('snapshot-invalid', 'a snapshot needs its number');
  if (against !== null && !FULL_SHA.test(against)) throw new TrackerError('snapshot-invalid', 'against must be a full object id');
  const tmp = indexPath ?? tempIndex();
  const idx = { GIT_INDEX_FILE: tmp };
  try {
    const [realIndex, head, headTree] = (yield { args: ['rev-parse', '--git-path', 'index', 'HEAD^{commit}', 'HEAD^{tree}'] }).split(/\r?\n/);
    if (!FULL_SHA.test(head ?? '') || !FULL_SHA.test(headTree ?? '')) throw new TrackerError('snapshot-failed', 'the checkout has no HEAD commit');
    let tree = headTree;
    let commit = head;
    // A checkout the caller knows is clean (just created at its base commit) is HEAD itself.
    if (!atHead) {
      // A copy of the real index lends its stat cache, so `add -A` hashes only what changed; the
      // entries themselves are reset to HEAD's tree, as a plain `read-tree HEAD` would.
      try { fs.copyFileSync(path.resolve(dir, realIndex), tmp); } catch { /* no index yet */ }
      try { yield { args: ['read-tree', '-m', head], env: idx }; } catch { dropIndex(tmp); yield { args: ['read-tree', head], env: idx }; }
      yield { args: ['add', '-A'], env: idx };
      tree = yield { args: ['write-tree'], env: idx };
      commit = yield { args: ['commit-tree', tree, '-p', head, '-m', `quill snapshot ${handoffId.slice(0, 8)} ${pad(n)}-${step}`], env: IDENTITY };
    }
    // Created, never moved: a ref left by an earlier attempt keeps what it holds, and this one takes the next free name.
    let ref = null;
    for (let i = 1; i <= 10 && !ref; i += 1) {
      const name = `${SNAPSHOT_REF_ROOT}/${handoffId}/${pad(n)}-${step}${i > 1 ? `-${i}` : ''}`;
      try { yield { args: ['update-ref', name, commit, ''] }; ref = name; } catch { /* taken */ }
    }
    if (!ref) throw new TrackerError('snapshot-failed', `no free snapshot ref for ${pad(n)}-${step}`);
    const base = against ?? headTree;
    const changed = base === tree ? [] : names(yield { args: ['diff-tree', '-r', '-z', '--no-renames', '--name-only', base, tree], raw: true });
    return { tree, commit, ref, files_changed: changed.length };
  } finally { dropIndex(tmp); }
}

/**
 * Snapshots the checkout at `dir`: { tree, commit, ref, files_changed } (files changed vs `against`,
 * else HEAD). With `atHead` the checkout is known to be clean and the snapshot is HEAD itself.
 */
export function snapshotTree(dir, opts) {
  return driveAsync(snapshotSteps(dir, opts), (step) => gitAsync(dir, step));
}

const lexists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const within = (root, p) => p === root || isUnder(root, p);

// True when a folder on the way to `rel` exists as anything but a real directory (a file, a symlink,
// a junction): writing `rel` would replace it.
function blockedParent(root, rel) {
  const parts = rel.split('/');
  let at = root;
  for (const part of parts.slice(0, -1)) {
    at = path.join(at, part);
    let stat;
    try { stat = fs.lstatSync(at); } catch { return false; }
    if (!stat.isDirectory()) return true;
  }
  return false;
}

function* restoreSteps(dir, commit, { handoffId, n, against = null, onPreRestore = null }) {
  if (typeof commit !== 'string' || !FULL_SHA.test(commit)) throw new TrackerError('snapshot-invalid', 'restore needs the snapshot commit id');
  const target = yield { args: ['rev-parse', '--verify', `${commit}^{tree}`] };
  const pre = yield* snapshotSteps(dir, { handoffId, step: 'pre-restore', n, against });
  // The caller records the pre-restore snapshot before anything changes; a refusal stops here.
  if (onPreRestore) onPreRestore(pre);
  const fields = names(yield { args: ['diff-tree', '-r', '-z', '--no-renames', '--name-status', pre.tree, target], raw: true });
  const root = fs.realpathSync(dir);
  const candidates = [];
  const removed = [];
  const skipped = [];
  const deletions = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [status, rel] = [fields[i], fields[i + 1]];
    if (status === 'D') deletions.push(rel);
    else candidates.push({ status, rel });
  }
  // Deletions go first: each removes only a file the pre-restore snapshot holds, so a path the target
  // turns from a directory into a file (or back) is free afterwards unless something unsaved is in it.
  for (const rel of deletions) {
    const abs = path.join(root, rel);
    let parent = null;
    try { parent = fs.realpathSync(path.dirname(abs)); } catch { continue; }
    let stat = null;
    try { stat = fs.lstatSync(abs); } catch { continue; }
    if (!within(root, parent) || stat.isDirectory()) { skipped.push(rel); continue; }
    fs.rmSync(abs, { force: true });
    removed.push(rel);
    // Directories the removal emptied go too, as a checkout would leave them.
    for (let d = path.dirname(abs); isUnder(root, d); d = path.dirname(d)) { try { fs.rmdirSync(d); } catch { break; } }
  }
  // A path the target adds that is taken now (an ignored file, a directory still holding ignored
  // files), or whose parent is now something other than a directory (an ignored file or symlink), is
  // not the pre-restore snapshot's to give back: checkout-index would unlink it. It stays as it is.
  const restored = [];
  for (const { status, rel } of candidates) {
    if ((status === 'A' && lexists(path.join(root, rel))) || blockedParent(root, rel)) skipped.push(rel);
    else restored.push(rel);
  }
  if (restored.length) {
    const tmp = tempIndex();
    try {
      yield { args: ['read-tree', target], env: { GIT_INDEX_FILE: tmp } };
      yield { args: ['checkout-index', '-f', '-z', '--stdin'], env: { GIT_INDEX_FILE: tmp }, input: `${restored.join('\0')}\0` };
    } finally { dropIndex(tmp); }
  }
  return { restored, removed, skipped, pre };
}

/**
 * Restores the checkout at `dir` to the snapshot `commit`, synchronously: { restored, removed,
 * skipped, pre } (repository-relative paths; `pre` the pre-restore snapshot, numbered `n`).
 */
export function restoreSnapshot(dir, commit, opts) {
  return drive(restoreSteps(dir, commit, opts), (step) => gitSync(dir, step));
}

/** Moves every ref under refs/quill/snapshots/<id>/ to refs/quill/archive/<id>/ in one transaction: { old: new }. */
export async function archiveRefs(repoPath, handoffId) {
  if (typeof handoffId !== 'string' || !SAFE_ID.test(handoffId)) throw new TrackerError('snapshot-invalid', 'archiving needs the run id');
  const run = (step) => gitAsync(repoPath, step);
  const listing = await run({ args: ['for-each-ref', '--format=%(refname) %(objectname)', `${SNAPSHOT_REF_ROOT}/${handoffId}/`] });
  const refs = listing.split(/\r?\n/).map((l) => l.trim().split(' ')).filter(([ref, sha]) => ref && FULL_SHA.test(sha ?? ''));
  if (!refs.length) return {};
  const moved = {};
  let input = '';
  for (const [ref, sha] of refs) {
    const to = `${ARCHIVE_REF_ROOT}/${ref.slice(SNAPSHOT_REF_ROOT.length + 1)}`;
    moved[ref] = to;
    input += `update ${to} ${sha}\ndelete ${ref} ${sha}\n`;
  }
  await run({ args: ['update-ref', '--stdin'], input });
  return moved;
}

// ---- Worker side: the run's step snapshots, archiving and the restore request ----

// A repair turn follows the agent's turn directly, and the self-check follows it when no repair ran.
const NOTHING_RAN_SINCE = { 'before-repair': ['agent'], 'before-self-check': ['agent'] };
const isFix = (h) => !!(h && h.permissions && h.permissions.edit_source);
const worktreesRoot = (env) => path.join(handoffsDir(env), 'worktrees');

/**
 * Snapshots a fix run's checkout at a step boundary and journals it (`snapshot-tx` created). Never
 * fails the run: a run without a checkout, at the cap, or whose snapshot fails is only logged.
 */
export async function takeSnapshot(worker, id, step) {
  try {
    const h = worker.state.handoffs.get(id);
    if (!isFix(h) || !h.worktree_path || h.worktree_removed_at || !fs.existsSync(h.worktree_path)) return null;
    const list = h.snapshots ?? [];
    if (list.length >= SNAPSHOT_CAP) return null;
    const n = list.length;
    const prev = list[n - 1];
    // Nothing runs between these boundaries and the previous snapshot: it already holds the checkout.
    if (prev && (NOTHING_RAN_SINCE[step] ?? []).includes(prev.step)) return null;
    const s = await snapshotTree(h.worktree_path, { handoffId: h.id, step, n, against: prev ? prev.tree : null, atHead: step === 'start' && n === 0 });
    const payload = { op: 'created', id: deterministicId(`${h.id}:snapshot:${n}`), handoff_id: h.id, ticket_id: h.ticket_id, step, label: STEP_LABELS[step], tree: s.tree, commit: s.commit, ref: s.ref, files_changed: s.files_changed };
    const { result } = worker.emit('snapshot-tx', payload, { source_identity: `snapshot-tx:${h.id}:${n}` });
    return result.rejected ? null : payload;
  } catch (err) {
    worker.log(`snapshot ${step} not taken for ${id}: ${err.message}`);
    return null;
  }
}

/** When a run's checkout is removed, its snapshot refs move to the archive and each snapshot says so. */
export async function archiveSnapshots(worker, id) {
  try {
    const h = worker.state.handoffs.get(id);
    const live = h ? (h.snapshots ?? []).filter((s) => !s.archived_at) : [];
    const repos = (worker.config && worker.config.repos) || {};
    const repoPath = h && repos[h.repo_id] ? repos[h.repo_id].canonical_path : null;
    if (!live.length || !repoPath || !fs.existsSync(repoPath)) return;
    const moved = await archiveRefs(repoPath, h.id);
    for (const s of live) {
      if (!moved[s.ref]) continue;
      worker.emit('snapshot-tx', { op: 'archived', id: s.id, handoff_id: h.id, ticket_id: h.ticket_id, ref: moved[s.ref] }, { source_identity: `snapshot-tx:${s.id}:archived` });
    }
  } catch (err) {
    worker.log(`snapshots not archived for ${id}: ${err.message}`);
  }
}

/**
 * The run and snapshot a `restore-snapshot` request names, or a TrackerError: the snapshot belongs
 * to a run of the ticket, the run has finished, and its checkout is still there (under this store's
 * worktrees folder, when `env` is given) with room for the pre-restore snapshot.
 */
export function restoreTarget(state, ticket, payload, { env = null } = {}) {
  const h = payload && typeof payload.handoff_id === 'string' ? state.handoffs.get(payload.handoff_id) : null;
  if (!h || h.ticket_id !== ticket.id) throw new TrackerError('handoff-unknown', 'handoff_id must name a run of the target ticket');
  const snap = (h.snapshots ?? []).find((s) => s.id === payload.snapshot_id);
  if (!snap) throw new TrackerError('snapshot-unknown', 'snapshot_id must name a snapshot of that run');
  if (ACTIVE.has(h.state)) throw new TrackerError('run-active', `the run is ${h.state}; its checkout can be restored once it has finished`);
  if (snap.archived_at || !h.worktree_path || h.worktree_removed_at) throw new TrackerError('checkout-removed', "the run's checkout was removed; its snapshots are archived in the repository and can no longer be restored here");
  if (env && (!isUnder(worktreesRoot(env), h.worktree_path) || !fs.existsSync(h.worktree_path))) throw new TrackerError('checkout-removed', "the run's checkout is not in this store's worktrees folder any more");
  if ((h.snapshots ?? []).length >= SNAPSHOT_CAP) throw new TrackerError('snapshot-limit', `the run already has ${SNAPSHOT_CAP} snapshots, so the restore could not save the checkout first`);
  return { h, snap };
}

/**
 * Applies a `restore-snapshot` request (called from evaluateRequest, synchronously, once). The
 * owner's dashboard alone may restore. The pre-restore snapshot is journaled before any file
 * changes, and the restore itself (`snapshot-tx` restored) before the request transaction, so a
 * crash in between never restores twice.
 */
export function evaluateRestore(worker, req, ticket, { owner }) {
  const fail = (code, message) => ({ outcome: 'failed', error: { code, message, retryable: false, current_revision: ticket.revision } });
  if (!owner) return fail('snapshot-restore-dashboard-only', "restoring a run's checkout is a dashboard action by the owner: open the run with quill ui");
  let found;
  try { found = restoreTarget(worker.state, ticket, req.payload, { env: worker.env }); } catch (err) { return fail(err.code ?? 'snapshot-invalid', err.message); }
  const { h, snap } = found;
  const mutation = { type: 'snapshot-restore', handoff_id: h.id, snapshot_id: snap.id };
  const doneSource = `snapshot-tx:restored:${req.id}`;
  if (worker.journal && worker.journal.hasSource(doneSource)) {
    const r = snap.restore ?? {};
    return { outcome: 'applied', mutation: { ...mutation, pre_restore_id: r.pre_restore_id ?? null }, result: { snapshot_id: snap.id, pre_restore_id: r.pre_restore_id ?? null, restored: r.restored ?? null, removed: r.removed ?? null, skipped: r.skipped ?? null } };
  }
  const list = h.snapshots ?? [];
  const n = list.length;
  const preId = deterministicId(`${h.id}:snapshot:${n}`);
  let out;
  let saved = false;
  try {
    out = restoreSnapshot(h.worktree_path, snap.commit, {
      handoffId: h.id, n, against: list[n - 1] ? list[n - 1].tree : null,
      onPreRestore: (pre) => {
        const { result } = worker.emit('snapshot-tx', { op: 'created', id: preId, handoff_id: h.id, ticket_id: h.ticket_id, step: 'pre-restore', label: `Before restoring snapshot ${pad(snap.n + 1)}`, tree: pre.tree, commit: pre.commit, ref: pre.ref, files_changed: pre.files_changed, request_id: req.id, restores: snap.id }, { source_identity: `snapshot-tx:${h.id}:${n}` });
        if (result.rejected || result.duplicate) throw new TrackerError('snapshot-failed', `the pre-restore snapshot was not recorded (${result.rejected ?? 'duplicate'}); nothing was restored`);
        saved = true;
      },
    });
  } catch (err) {
    // Past the pre-restore snapshot the checkout may be partly restored; that snapshot holds it as it was.
    return fail(err.code ?? 'snapshot-failed', saved ? `${err.message}; the checkout may be partly restored, and snapshot ${pad(n + 1)} (before this restore) holds its files as they were` : err.message);
  }
  const counts = { restored: out.restored.length, removed: out.removed.length, skipped: out.skipped.length };
  worker.emit('snapshot-tx', { op: 'restored', id: snap.id, handoff_id: h.id, ticket_id: h.ticket_id, request_id: req.id, pre_restore_id: preId, ...counts }, { source_identity: doneSource });
  return { outcome: 'applied', mutation: { ...mutation, pre_restore_id: preId }, result: { snapshot_id: snap.id, pre_restore_id: preId, ...counts } };
}
