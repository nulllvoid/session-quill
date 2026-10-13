// Handoff permissions are an explicit per-request object, never inferred from approval text
// (TRD §Handoff execution).
import { TrackerError } from '../lib/errors.js';

// `files` (ADR 0015) works on a ticket's attached files, outside any repository.
export const MODES = ['analyse', 'analyse-followups', 'attempt-fix', 'files'];
export const NOTE_MAX = 280;
// How much of Claude Code a run may use (ADR 0017, ADR 0026): `standard` is Quill's narrow tool
// profile, `settings` the owner's own Claude Code permission rules and connectors, `autonomous`
// every tool and connector with the per-run guard deciding each call and credentials redirected,
// `full` no permission checks at all. A request that names none stays standard, as schedules,
// page proposals and older requests do; the dashboard and the CLI ask for autonomous.
export const ACCESS = ['standard', 'settings', 'autonomous', 'full'];
// Write scopes (spec §4.3) a run may be granted: `name` or `name:target`, autonomous only. They
// are names here; the scope catalog resolves them at dispatch (Task 11).
export const SCOPE_RE = /^[a-z][a-z0-9._-]{0,63}(?::[A-Za-z0-9._/@-]{1,128})?$/;
export const MAX_SCOPES = 20;
// A run may set its own turn and spend caps (spec §8, `--max-turns`, `--budget`); they win over
// the recipe and the config, within these bounds.
export const MAX_RUN_TURNS = 1000;
export const MAX_RUN_BUDGET_USD = 1000;
// Runs queued together from the dashboard share a client-chosen batch id (ADR 0023).
export const BATCH_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
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
  const access = payload.access ?? 'standard';
  if (!ACCESS.includes(access)) throw new TrackerError('access-invalid', `access must be one of ${ACCESS.join(', ')}`);
  if (access !== 'standard' && mode === 'files') throw new TrackerError('access-invalid', 'a files run always uses standard access: its staging and undo rely on the agent never reaching the originals');
  if (payload.batch_id !== undefined && payload.batch_id !== null && !(typeof payload.batch_id === 'string' && BATCH_ID_RE.test(payload.batch_id))) throw new TrackerError('batch-invalid', 'batch_id must be 1 to 64 letters, digits, dots, colons, underscores or dashes');
  const batch = typeof payload.batch_id === 'string' ? { batch_id: payload.batch_id } : {};
  const scopes = scopeList(payload.scopes, access);
  const limits = runLimits(payload);
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
    return { recipe: { name: recipe.name, source: recipe.source, hash: recipe.hash }, mode, note, permissions, access, branch: permissions.push_branch ? branch : null, ...(payload.suggest === true ? { suggest: true } : {}), ...batch, ...scopes, ...limits };
  }
  return { mode, note, permissions, access, branch: permissions.push_branch ? branch : null, ...batch, ...scopes, ...limits };
}

// `{ scopes }` when the request names any, else {}. Scopes cover prod and external writes only and
// exist only under autonomous access, where the guard enforces them.
function scopeList(raw, access) {
  if (raw === undefined || raw === null) return {};
  if (!Array.isArray(raw) || raw.length > MAX_SCOPES || !raw.every((s) => typeof s === 'string' && SCOPE_RE.test(s))) {
    throw new TrackerError('scope-invalid', `scopes must be a list of at most ${MAX_SCOPES} names such as jira.write or k8s.write:staging`);
  }
  if (!raw.length) return {};
  if (access !== 'autonomous') throw new TrackerError('scope-needs-autonomous', 'write scopes need autonomous access: only its guard can hold a run to them');
  return { scopes: [...new Set(raw)] };
}

function runLimits(payload) {
  const out = {};
  if (payload.max_turns !== undefined && payload.max_turns !== null) {
    if (!Number.isInteger(payload.max_turns) || payload.max_turns < 1 || payload.max_turns > MAX_RUN_TURNS) throw new TrackerError('budget-invalid', `max_turns must be a whole number from 1 to ${MAX_RUN_TURNS}`);
    out.max_turns = payload.max_turns;
  }
  if (payload.max_budget_usd !== undefined && payload.max_budget_usd !== null) {
    const v = payload.max_budget_usd;
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > MAX_RUN_BUDGET_USD) throw new TrackerError('budget-invalid', `max_budget_usd must be a number above 0 and at most ${MAX_RUN_BUDGET_USD}`);
    out.max_budget_usd = v;
  }
  return out;
}
