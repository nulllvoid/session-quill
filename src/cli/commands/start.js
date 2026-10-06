import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { initialize } from './init.js';
import { ensureReady } from '../../runtime/readiness.js';
import { loadContext } from '../context.js';
import { samePath } from '../../config/repos.js';
import { runHook } from '../../hooks/adapter.js';
import { quillHome } from '../../lib/paths.js';
import { acquireLock } from '../../worker/lock.js';
import { TrackerError } from '../../lib/errors.js';

export async function run(options) {
  const until = Date.now() + 15000;
  let lock;
  while (!lock) {
    try { lock = await acquireLock('quill-setup', quillHome(options.env), options.env); }
    catch (err) {
      if (err.code !== 'lock-held' || Date.now() >= until) throw err;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try { return await enable(options); } finally { await lock.release(); }
}

async function enable({ flags, io, env }) {
  const requested = path.resolve(flags.repo ?? process.cwd());
  let repo = requested;
  try { repo = execFileSync('git', ['-C', requested, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 }).trim(); } catch { /* initialize reports an actionable error */ }
  const before = loadContext(env, { requireStore: false });
  if (before.initialized && before.storeMeta.owner_machine_id !== before.machineId) throw new TrackerError('not-owner', 'This store belongs to another machine. Its local copy remains read-only.');
  if (before.initialized && flags.store && !samePath(flags.store, before.config.store_path)) throw new TrackerError('store-change', 'Quill already has a store. Use quill init --store to explicitly change it.');
  const registered = Object.entries(before.config.repos).find(([, r]) => samePath(r.canonical_path, repo));
  const ctx = await initialize({
    env, io: { println() {} }, requireOwner: true,
    flags: { ...flags, repo, yes: true, private: flags['share-settings'] !== true,
      ...(registered ? { 'repo-id': registered[0], project: registered[1].project_id, 'project-name': before.config.projects[registered[1].project_id]?.name } : {}) },
  });
  await ensureReady(ctx, { resume: true });
  if (flags.session) {
    const result = runHook('SessionStart', { session_id: String(flags.session), cwd: repo, source: 'startup' }, { env });
    if (result.stderr) io.err(result.stderr);
    if (!result.persisted) throw new TrackerError('capture-unavailable', 'Quill started, but could not save this session. Run quill doctor to check capture storage.');
  }
  io.println(`Quill is ready in ${path.basename(repo)}.${flags.session ? ' This session is now being captured.' : ' Your next Claude session will be captured automatically.'}`);
  io.println('Keep working normally; no ticket or tracker connection is required.');
  io.println('Open your dashboard with /session-quill:ui (or quill ui).');
  return 0;
}
