// File runs (ADR 0015): a recipe in mode `files` works on a ticket's attached files without a
// repository. The agent only ever sees copies staged into its sandbox; the worker applies its
// edits and deletions to the originals, only for attached files unchanged since staging, and keeps
// what it replaced or removed in a Quill trash folder so each change can be undone.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { quillHome } from '../lib/paths.js';
import { TrackerError } from '../lib/errors.js';

export const MAX_FILES = 25;
export const MAX_FILE_BYTES = 1024 * 1024;

export function trashDir(env, handoffId) {
  return path.join(quillHome(env), 'trash', handoffId);
}

function sha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function shaOf(file) {
  try { return sha(fs.readFileSync(file)); } catch { return null; }
}

// The attached files a file run may reach: absolute paths recorded on the ticket. Repository
// tickets record paths relative to their repository and are worked on through a checkout instead.
export function attachedFiles(ticket) {
  const seen = new Set();
  const out = [];
  for (const f of ticket.files_touched ?? []) {
    const p = typeof f === 'string' ? f : f.relative_path;
    if (typeof p !== 'string' || !path.isAbsolute(p)) continue;
    const key = path.resolve(p).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(path.resolve(p));
  }
  return out.slice(0, MAX_FILES);
}

// Copies each attached file that exists as a regular file into `<sandbox>/files/`. A missing file
// is listed so the agent can report it; a symlink, directory or oversized file is refused.
export function stageFiles(ticket, sandbox) {
  const dir = path.join(sandbox, 'files');
  fs.mkdirSync(dir, { recursive: true });
  const staged = [];
  attachedFiles(ticket).forEach((original, i) => {
    const id = `f${i + 1}`;
    const name = `${id}-${path.basename(original).replace(/[^A-Za-z0-9._-]/g, '_')}`;
    let st = null;
    try { st = fs.lstatSync(original); } catch { /* missing */ }
    if (!st) { staged.push({ id, path: original, staged: null, state: 'missing', size: 0, sha: null }); return; }
    if (!st.isFile()) { staged.push({ id, path: original, staged: null, state: 'not-a-file', size: 0, sha: null }); return; }
    if (st.size > MAX_FILE_BYTES) { staged.push({ id, path: original, staged: null, state: 'too-large', size: st.size, sha: null }); return; }
    const buf = fs.readFileSync(original);
    fs.writeFileSync(path.join(dir, name), buf);
    staged.push({ id, path: original, staged: `files/${name}`, state: 'staged', size: st.size, sha: sha(buf) });
  });
  if (!staged.some((f) => f.state === 'staged')) throw new TrackerError('files-unavailable', `none of the ticket's attached files can be staged: ${staged.map((f) => `${f.path} (${f.state})`).join('; ') || 'no attached files'}`);
  return staged;
}

function move(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try { fs.renameSync(from, to); } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
  }
}

// Applies the run's outcome to the originals. Every change is checked against the content staged
// for it, so a file someone changed during the run is left alone and reported instead.
export function applyFileRun({ env, handoffId, sandbox, files, permissions = {}, deleteIds = [], now }) {
  const effects = [];
  const skipped = [];
  const trash = trashDir(env, handoffId);
  const wanted = new Set(deleteIds);
  for (const f of files) {
    if (f.state !== 'staged') continue;
    const stagedPath = path.join(sandbox, f.staged);
    const current = shaOf(f.path);
    const del = wanted.has(f.id);
    const after = shaOf(stagedPath);
    const edited = !del && after !== null && after !== f.sha;
    if (!del && !edited) continue;
    if (del && !permissions.delete_files) { skipped.push(`${f.path}: deletion not permitted for this run`); continue; }
    if (edited && !permissions.edit_files) { skipped.push(`${f.path}: edits not permitted for this run`); continue; }
    if (current !== f.sha) { skipped.push(`${f.path}: changed or removed during the run, left as it is`); continue; }
    const backup = path.join(trash, f.id, path.basename(f.path));
    try {
      if (del) {
        move(f.path, backup);
        effects.push({ id: `e${effects.length + 1}`, file_id: f.id, path: f.path, action: 'deleted', backup, before_sha: f.sha, after_sha: null, at: now, undone_at: null });
      } else {
        fs.mkdirSync(path.dirname(backup), { recursive: true });
        fs.copyFileSync(f.path, backup);
        fs.writeFileSync(f.path, fs.readFileSync(stagedPath));
        effects.push({ id: `e${effects.length + 1}`, file_id: f.id, path: f.path, action: 'edited', backup, before_sha: f.sha, after_sha: after, at: now, undone_at: null });
      }
    } catch (err) {
      skipped.push(`${f.path}: ${err.message}`);
    }
  }
  return { effects, skipped };
}

// Reverses one change, only when the file is still as the run left it.
export function undoFileEffect(effect) {
  if (effect.undone_at) throw new TrackerError('effect-undone', 'this change was already undone');
  if (!fs.existsSync(effect.backup)) throw new TrackerError('backup-missing', `the saved copy at ${effect.backup} is gone; nothing to restore`);
  if (effect.action === 'deleted') {
    if (fs.existsSync(effect.path)) throw new TrackerError('path-occupied', `${effect.path} exists again; move it away to restore the deleted file`);
    move(effect.backup, effect.path);
    return;
  }
  if (shaOf(effect.path) !== effect.after_sha) throw new TrackerError('file-changed', `${effect.path} changed after the run; restore ${effect.backup} by hand if you still want it`);
  fs.copyFileSync(effect.backup, effect.path);
}
