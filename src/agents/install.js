// Shared recipes (ADR 0020): install recipe files from a Git repository or a folder into the
// personal recipes directory, after the owner has seen what each one may do. A recipe is a prompt
// plus a permission ceiling, so installing one is trusting its author; nothing installs silently.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { normalizeRecipe, personalRecipesDir, PERMISSION_KEYS } from './recipes.js';
import { readJsonIfExists, writeJsonAtomic, writeFileAtomic, ensureDir } from '../lib/atomic-fs.js';
import { TrackerError } from '../lib/errors.js';

const SEARCH_DIRS = ['.quill/agents', 'recipes', 'agents', '.'];
const MAX_FILES = 50;
const MAX_FILE_BYTES = 32 * 1024;
const REF_RE = /^[A-Za-z0-9._/-]{1,100}$/;
// Permissions that let a run change something; the preview calls these out.
export const CHANGING = ['edit_source', 'commit', 'push_branch', 'open_draft_pr', 'edit_files', 'delete_files'];

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
export const installedIndexPath = (env) => path.join(personalRecipesDir(env), '.installed.json');
export const readInstalled = (env) => readJsonIfExists(installedIndexPath(env)) ?? {};

// Shallow, https-only clone: no submodules, no other transport (ext::, file://, ssh), no prompts.
export function gitClone(url, ref, dest) {
  const args = ['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'core.hooksPath=/dev/null',
    'clone', '--quiet', '--depth', '1', '--no-recurse-submodules', ...(ref ? ['--branch', ref] : []), '--', url, dest];
  execFileSync('git', args, { stdio: ['ignore', 'ignore', 'pipe'], timeout: 60_000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  try { return execFileSync('git', ['-C', dest, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(); } catch { return null; }
}

// Materialise the source: a local folder is read in place; an https URL is cloned to a temp dir.
export function fetchSource(source, { ref = null, clone = gitClone } = {}) {
  if (ref !== null && !REF_RE.test(ref)) throw new TrackerError('usage', '--ref must be a branch, tag or commit name');
  if (/^https:\/\//i.test(source)) {
    let u;
    try { u = new URL(source); } catch { throw new TrackerError('source-invalid', `${source} is not a valid URL`); }
    if (u.username || u.password) throw new TrackerError('source-invalid', 'put no credentials in the URL');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quill-recipes-'));
    try {
      const commit = clone(source, ref, path.join(dir, 'src'));
      return { root: path.join(dir, 'src'), commit, cleanup: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) };
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      throw new TrackerError('fetch-failed', `could not clone ${source}${ref ? ` at ${ref}` : ''}: ${String(err.stderr ?? err.message).trim().split('\n')[0]}`);
    }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) throw new TrackerError('source-invalid', 'recipes install from an https:// Git URL or a local folder');
  const root = path.resolve(source);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new TrackerError('source-invalid', `${source} is not a folder or an https:// Git URL`);
  return { root, commit: null, cleanup: () => {} };
}

// Every *.md recipe in the first recipe folder the source has, validated as a personal recipe.
export function discoverRecipes(root) {
  for (const rel of SEARCH_DIRS) {
    const dir = path.join(root, rel);
    let names;
    try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && !/^(readme|changelog|license|contributing)\.md$/i.test(f)).sort(); } catch { continue; }
    if (!names.length) continue;
    return names.slice(0, MAX_FILES).map((file) => {
      const full = path.join(dir, file);
      const name = file.slice(0, -3);
      const st = fs.lstatSync(full);
      if (!st.isFile()) return { name, file: path.posix.join(rel, file), error: 'not a regular file' };
      if (st.size > MAX_FILE_BYTES) return { name, file: path.posix.join(rel, file), error: `larger than ${MAX_FILE_BYTES / 1024} KiB` };
      const text = fs.readFileSync(full, 'utf8');
      const recipe = normalizeRecipe({ name, text, source: 'personal' });
      return { name, file: path.posix.join(rel, file), text, recipe, error: recipe.error };
    });
  }
  return [];
}

export function describeRecipe(r) {
  const granted = PERMISSION_KEYS.filter((k) => r.permissions[k]);
  const changing = granted.filter((k) => CHANGING.includes(k));
  return { mode: r.mode, permissions: granted, changes: changing, tools: r.tools, timeout_min: r.timeout_min, description: r.description };
}

// What an install would do, without doing it: each candidate is new, a replacement of an installed
// recipe, blocked by a hand-written personal recipe of the same name, or invalid.
export function planInstall(found, { env, only = null, replace = false }) {
  const index = readInstalled(env);
  const dir = personalRecipesDir(env);
  return found.filter((f) => !only || only.includes(f.name)).map((f) => {
    if (f.error) return { ...f, action: 'skip', reason: f.error };
    const target = path.join(dir, `${f.name}.md`);
    const exists = fs.existsSync(target);
    if (exists && !index[f.name] && !replace) return { ...f, action: 'skip', reason: 'a personal recipe with this name exists (use --replace to overwrite it)' };
    if (exists && index[f.name] && !replace) return { ...f, action: 'skip', reason: `already installed from ${index[f.name].source} (use --replace to update)` };
    return { ...f, action: exists ? 'replace' : 'install', target };
  });
}

export function applyInstall(plan, { env, source, ref, commit, now }) {
  const index = readInstalled(env);
  ensureDir(personalRecipesDir(env));
  const done = [];
  for (const p of plan) {
    if (p.action !== 'install' && p.action !== 'replace') continue;
    writeFileAtomic(p.target, p.text);
    index[p.name] = { source, ref: ref ?? null, commit: commit ?? null, file: p.file, hash: sha(p.text), installed_at: now };
    done.push(p.name);
  }
  writeJsonAtomic(installedIndexPath(env), index);
  return done;
}

// Removes an installed recipe only while it is exactly what was installed.
export function uninstall(name, { env, force = false }) {
  const index = readInstalled(env);
  const entry = index[name];
  if (!entry) throw new TrackerError('not-installed', `${name} was not installed with quill agent install; personal recipes are yours to delete by hand`);
  const target = path.join(personalRecipesDir(env), `${name}.md`);
  const text = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
  if (text !== null && sha(text) !== entry.hash && !force) throw new TrackerError('recipe-modified', `${name}.md was edited after installing; keep it, or pass --force to delete it anyway`);
  if (text !== null) fs.rmSync(target);
  delete index[name];
  writeJsonAtomic(installedIndexPath(env), index);
  return entry;
}
