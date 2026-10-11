// Runs proposed from a shared page (ADR 0025). A "Run agent" pick on a two-way artifact page is a
// proposal, never a run: it names the page editor (as the page reported them), the recipe and the
// access the run would get, and nothing queues until the owner approves it on the dashboard or with
// `quill approve --run`. These helpers are pure, so the worker's publish job and a session's
// `quill publish --result` turn the same edit into the same proposal.
import { editRequestId } from './artifact.js';
import { deterministicId } from '../lib/ids.js';

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
export function isReadOnlyRecipe(r) {
  return !!r && !r.error && READ_MODES.includes(r.mode) && !WRITE_PERMISSIONS.some((k) => r.permissions && r.permissions[k]);
}

// What the page's Run agent select offers: every valid read-only recipe of the personal and
// built-in layers, plus the names the owner listed in run_recipes.
export function runChoices(recipes, publisher) {
  if (!publisher || publisher.run_agent !== true || !recipes) return [];
  const names = new Set();
  for (const r of recipes.forRepo(null).effective.values()) if (isReadOnlyRecipe(r)) names.add(r.name);
  for (const n of publisher.run_recipes ?? []) names.add(n);
  return [...names].sort();
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
  if (!runChoices(recipes, publisher).includes(name)) return { error: `${name.slice(0, 40)} is not offered on the ${publisher.name} page` };
  const recipe = recipes.get(name, (ticket && ticket.repo_id) ?? null, { fresh: true });
  if (!recipe) return { error: `no recipe named ${name}` };
  if (recipe.error) return { error: `recipe ${name} is invalid: ${recipe.error}` };
  const ceiling = recipe.permissions ?? {};
  const permissions = Object.fromEntries(PERMISSION_KEYS.map((k) => [k, false]));
  permissions.read_source = !!(ceiling.read_source && repoRegistered);
  permissions.edit_source = !!(ceiling.edit_source && repoRegistered);
  permissions.edit_files = !!ceiling.edit_files;
  permissions.delete_files = !!ceiling.delete_files;
  const readOnly = isReadOnlyRecipe(recipe);
  const editor = editorLabel(e.by);
  const auto = readOnly && !permissions.edit_source && !!editor && (publisher.auto_run_editors ?? []).includes(e.by) && (publisher.auto_run_recipes ?? []).includes(name);
  return {
    proposal: {
      id: editRequestId(publisher.name, e), ticket_id: e.ticket_id, publisher: publisher.name, editor, edited_at: typeof e.at === 'string' ? e.at : null,
      recipe: { name: recipe.name, source: recipe.source, hash: recipe.hash }, mode: recipe.mode, permissions, access: 'standard', read_only: readOnly, auto,
      expected_revision: Number.isInteger(e.expected_revision) ? e.expected_revision : null,
    },
  };
}

// The request id under which an auto-queued proposal is approved: one per proposal, so a retry
// after a crash approves it once.
export function autoApprovalId(proposalId) {
  return deterministicId(`auto-run:${proposalId}`);
}

// The proposal's state as of `now`: an open one lapses after PROPOSAL_TTL_MS or once its ticket is
// done or gone. Approved and dismissed ones keep their state.
export function proposalState(p, ticket, now) {
  if (p.state !== 'proposed') return p.state;
  if (!ticket || ticket.status === 'done') return 'expired';
  if (Date.parse(now) - Date.parse(p.proposed_at) > PROPOSAL_TTL_MS) return 'expired';
  return 'proposed';
}

// The note an approved run carries, so the run itself says where it came from.
export function proposalNote(p) {
  return `proposed on the ${p.publisher} page${p.editor ? ` by ${p.editor}` : ''}`.slice(0, 280);
}
