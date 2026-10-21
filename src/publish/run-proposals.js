// Runs proposed from a shared page (ADR 0025). A "Run agent" pick on a two-way artifact page is a
// proposal, never a run: it names the page editor (as the page reported them), the recipe and the
// access the run would get, and nothing queues until the owner approves it on the dashboard or with
// `quill approve --run`; there is no auto-approval. A run's own critical-change proposal (origin
// 'run', ADR 0028) is made only by the critical-proposal reducer and approved on the dashboard alone. These helpers are pure, so the worker's publish job and a session's
// `quill publish --result` turn the same edit into the same proposal.
import { editRequestId } from './artifact.js';

// An open proposal lapses after a week, or as soon as its ticket is done or gone.
export const PROPOSAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Resolved and lapsed proposals are dropped from state 30 days on, keeping replay small.
export const PROPOSAL_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
export const PROPOSAL_STATES = ['proposed', 'approved', 'dismissed'];

const READ_MODES = ['analyse', 'analyse-followups'];
const WRITE_PERMISSIONS = ['edit_source', 'commit', 'push_branch', 'open_draft_pr', 'edit_files', 'delete_files'];
const PERMISSION_KEYS = ['read_source', 'edit_source', 'commit', 'push_branch', 'open_draft_pr', 'edit_files', 'delete_files'];

// Read-only: an analysis that may at most read source. Only these are offered by default and only
// these can ever be queued without the owner.
// A recipe that requires an action pin or write scopes (ADR 0028) is never one of them.
export function isReadOnlyRecipe(r) {
  return !!r && !r.error && READ_MODES.includes(r.mode) && !WRITE_PERMISSIONS.some((k) => r.permissions && r.permissions[k]) && !(Array.isArray(r.requires) && r.requires.length);
}

// The recipe the page offers under a name: the valid one of the personal and built-in layers. A
// repository's recipes are never offered, because a page row may belong to any repository.
export function offeredRecipe(recipes, publisher, name) {
  if (!publisher || publisher.run_agent !== true || !recipes) return null;
  const r = recipes.forRepo(null).effective.get(name);
  if (!r || r.error || r.source === 'repo' || (Array.isArray(r.requires) && (r.requires.includes('action_pin') || r.requires.includes('run_diff')))) return null;
  return isReadOnlyRecipe(r) || (publisher.run_recipes ?? []).includes(name) ? r : null;
}

// What the page's Run agent select offers: every valid read-only recipe of the personal and
// built-in layers, plus the names in run_recipes that one of those layers has.
export function runChoices(recipes, publisher) {
  if (!publisher || publisher.run_agent !== true || !recipes) return [];
  const names = new Set();
  for (const r of recipes.forRepo(null).effective.values()) if (isReadOnlyRecipe(r)) names.add(r.name);
  for (const n of publisher.run_recipes ?? []) if (offeredRecipe(recipes, publisher, n)) names.add(n);
  return [...names].sort();
}

// The recipe a ticket would run under that name must be the very one the page offered: same layer
// and same text. A repository recipe of the same name shadows it and is refused.
export function shadowProblem(offered, resolved, name) {
  if (!resolved) return { code: 'recipe-unknown', message: `no recipe named ${name}` };
  if (resolved.error) return { code: 'recipe-invalid', message: `recipe ${name} is invalid: ${resolved.error}` };
  if (resolved.source !== offered.source) return { code: 'recipe-shadowed', message: `this ticket's repository's own ${name} recipe shadows the one the page offers; run it yourself if you want it` };
  if (offered.hash && resolved.hash !== offered.hash) return { code: 'recipe-changed', message: `recipe ${name} changed since it was offered on the page; review it and run it yourself` };
  return null;
}

// Page data is less trusted than anything the owner typed: one plain line, dash runs broken up.
export function editorLabel(by) {
  if (typeof by !== 'string') return null;
  const text = by.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/-{3,}/g, '–').replace(/\s+/g, ' ').trim().slice(0, 120);
  return text || null;
}

// Turns one page edit of the `run` field into { proposal }, { skip: true } for a cleared select, or
// { error } for a recipe the page does not offer or the ticket cannot run. A page can never ask for
// more than an isolated, standard-access run without commit, push or a pull request.
export function proposalFromEdit(publisher, e, { recipes, ticket, repoRegistered = false }) {
  const name = typeof e.value === 'string' ? e.value.trim() : '';
  if (!name) return { skip: true };
  const offered = runChoices(recipes, publisher).includes(name) ? offeredRecipe(recipes, publisher, name) : null;
  if (!offered) return { error: `${name.slice(0, 40)} is not offered on the ${publisher.name} page` };
  const recipe = recipes.get(name, (ticket && ticket.repo_id) ?? null, { fresh: true });
  const problem = shadowProblem(offered, recipe, name);
  if (problem) return { error: problem.message };
  const ceiling = recipe.permissions ?? {};
  const permissions = Object.fromEntries(PERMISSION_KEYS.map((k) => [k, false]));
  permissions.read_source = !!(ceiling.read_source && repoRegistered);
  permissions.edit_source = !!(ceiling.edit_source && repoRegistered);
  permissions.edit_files = !!ceiling.edit_files;
  permissions.delete_files = !!ceiling.delete_files;
  const readOnly = isReadOnlyRecipe(recipe);
  const editor = editorLabel(e.by);
  return {
    proposal: {
      id: editRequestId(publisher.name, e), ticket_id: e.ticket_id, publisher: publisher.name, editor, edited_at: typeof e.at === 'string' ? e.at : null,
      recipe: { name: recipe.name, source: recipe.source, hash: recipe.hash }, mode: recipe.mode, permissions, access: 'standard', read_only: readOnly,
      expected_revision: Number.isInteger(e.expected_revision) ? e.expected_revision : null,
    },
  };
}

// The proposal's state as of `now`: an open one lapses after PROPOSAL_TTL_MS, once its ticket is
// done or gone, and for good once its ticket was done after the pick (`lapsed_at`), even if the
// ticket is reopened. Approved and dismissed ones keep their state.
export function proposalState(p, ticket, now) {
  if (p.state !== 'proposed') return p.state;
  if (p.lapsed_at || !ticket || ticket.status === 'done') return 'expired';
  if (Date.parse(now) - Date.parse(p.proposed_at) > PROPOSAL_TTL_MS) return 'expired';
  return 'proposed';
}

// Where an approved run came from, kept beside the run and never as the owner's note: the editor
// is whatever the page reported, so it reaches a prompt only as labelled, untrusted data. A run's
// critical-change proposal (ADR 0028) names the run that proposed it instead of a page.
export function proposalProvenance(p) {
  if (p.origin === 'run') return { id: p.id, origin: 'run', from_handoff_id: p.from_handoff_id, recipe: p.recipe.name };
  // ADR 0039: a CI fix names the run whose pull request's CI failed.
  if (p.origin === 'ci') return { id: p.id, origin: 'ci', from_handoff_id: p.from_handoff_id, recipe: p.recipe.name };
  return { id: p.id, publisher: p.publisher, editor: p.editor ?? null, recipe: p.recipe.name };
}
