// Handoff permissions are an explicit per-request object, never inferred from approval text
// (TRD §Handoff execution).
import { TrackerError } from '../lib/errors.js';

// `files` (ADR 0015) works on a ticket's attached files, outside any repository.
export const MODES = ['analyse', 'analyse-followups', 'attempt-fix', 'files'];
export const NOTE_MAX = 280;
const PERMISSION_KEYS = ['read_source', 'edit_source', 'commit', 'push_branch', 'open_draft_pr', 'edit_files', 'delete_files'];

export function isProtectedBranch(branch, repo) {
  const protectedNames = new Set(['main', 'master', 'trunk', 'develop', repo && repo.default_branch].filter(Boolean));
  return protectedNames.has(branch) || /^release\//.test(branch);
}

// With a recipe (ADR 0008) the mode comes from the recipe and its frontmatter permissions are a
// ceiling: a request may ask for less, never more.
export function validateHandoffRequest(payload = {}, { repo = null, providerConfigured, recipe = null, attachedFileCount = null } = {}) {
  if (recipe && payload.mode !== undefined && payload.mode !== null && payload.recipe !== undefined && payload.mode !== recipe.mode) throw new TrackerError('mode-mismatch', `recipe ${recipe.name} runs in mode ${recipe.mode}`);
  const mode = recipe ? recipe.mode : payload.mode ?? 'analyse-followups';
  if (!MODES.includes(mode)) throw new TrackerError('mode-invalid', `handoff mode must be one of ${MODES.join(', ')}`);
  const note = typeof payload.note === 'string' ? payload.note.trim() : '';
  if (note.length > NOTE_MAX) throw new TrackerError('note-too-long', `handoff note exceeds ${NOTE_MAX} characters`);
  const raw = payload.permissions ?? {};
  const permissions = {};
  for (const k of PERMISSION_KEYS) permissions[k] = raw[k] === true;
  if (recipe) {
    const beyond = PERMISSION_KEYS.filter((k) => permissions[k] && !(recipe.permissions && recipe.permissions[k]));
    if (beyond.length) throw new TrackerError('permission-beyond-recipe', `recipe ${recipe.name} does not allow ${beyond.join(', ')}`);
  }
  const branch = typeof payload.branch === 'string' && payload.branch.trim() ? payload.branch.trim() : (typeof raw.branch === 'string' && raw.branch.trim() ? raw.branch.trim() : null);
  const hasProvider = providerConfigured ?? !!(repo && repo.provider);

  if (mode === 'attempt-fix' && !(permissions.read_source && permissions.edit_source)) {
    throw new TrackerError('permission-required', 'attempt-fix requires read_source and edit_source (isolated checkout)');
  }
  if (permissions.edit_source && !permissions.read_source) throw new TrackerError('permission-dependency', 'edit_source requires read_source');
  if (permissions.edit_source && mode !== 'attempt-fix') throw new TrackerError('permission-dependency', 'edit_source is only meaningful for attempt-fix');
  if (permissions.commit && !permissions.edit_source) throw new TrackerError('permission-dependency', 'commit requires edit_source');
  if (permissions.push_branch && !permissions.commit) throw new TrackerError('permission-dependency', 'push_branch requires commit');
  if (permissions.push_branch) {
    if (!branch) throw new TrackerError('branch-required', 'push_branch requires an explicit non-default destination branch');
    if (isProtectedBranch(branch, repo)) throw new TrackerError('branch-protected', `refusing to push to protected/default branch ${branch}`);
  }
  if (permissions.open_draft_pr && !permissions.push_branch) throw new TrackerError('permission-dependency', 'open_draft_pr requires push_branch');
  if (permissions.open_draft_pr && !hasProvider) throw new TrackerError('provider-required', 'open_draft_pr requires a configured PR provider for the repository');
  if ((permissions.edit_files || permissions.delete_files) && mode !== 'files') throw new TrackerError('permission-dependency', 'edit_files and delete_files are only meaningful for mode files');
  if (mode === 'files') {
    const repoAccess = ['read_source', 'edit_source', 'commit', 'push_branch', 'open_draft_pr'].filter((k) => permissions[k]);
    if (repoAccess.length) throw new TrackerError('permission-dependency', `a files run works on staged copies of attached files and cannot use ${repoAccess.join(', ')}`);
    if (attachedFileCount === 0) throw new TrackerError('files-required', 'this ticket has no attached files outside a repository for a files run to work on');
  }
  if ((permissions.read_source || permissions.edit_source) && !repo) throw new TrackerError('repo-required', 'source access requires a registered repository on the owner machine');
  if (recipe) {
    return { recipe: { name: recipe.name, source: recipe.source, hash: recipe.hash }, mode, note, permissions, branch: permissions.push_branch ? branch : null, ...(payload.suggest === true ? { suggest: true } : {}) };
  }
  return { mode, note, permissions, branch: permissions.push_branch ? branch : null };
}
