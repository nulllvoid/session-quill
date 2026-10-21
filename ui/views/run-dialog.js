// Run agent (spec §5): one dialog for every recipe, built-in modes included. Step 1 picks what to
// run; step 2 is the recipe form with a plain summary of what the run will do.
import { esc, attr, icon, keyEl, normalizeSnapshot, normalizeTicket } from '../components.js';
import { effectiveRecipes, offeredRecipe, attachedFilePaths, permissionSummary, renderRecipeRunDialog, recipeCap, SOURCE_LABELS } from './agents.js';

export function renderRunAgentDialog(rawTicket, rawSnapshot, { recipe = null, retryOf = null, note = null } = {}) {
  const snapshot = normalizeSnapshot(rawSnapshot);
  const ticket = normalizeTicket(rawTicket);
  const hasFiles = attachedFilePaths(ticket).length > 0;
  const recipes = effectiveRecipes(snapshot, ticket.repo_id).filter((r) => offeredRecipe(r) && (r.mode !== 'files' || hasFiles));
  const chosen = recipe ? recipes.find((r) => r.name === recipe && !r.error) : null;
  if (chosen) return renderRecipeRunDialog(chosen, ticket, snapshot, { retryOf, note });
  const cards = recipes.map((r) => {
    if (r.error) return `<li class="recipe-card" data-invalid="true"><strong>${esc(r.name)}</strong> <span class="small critical">${icon('alert')}Invalid: ${esc(r.error)}</span></li>`;
    const p = r.permissions ?? {};
    const access = p.edit_source ? 'Edits source' : p.edit_files || p.delete_files ? 'Changes files' : p.read_source ? 'Reads source' : 'Notes only';
    const edits = !!(p.edit_source || p.edit_files || p.delete_files);
    return `<li><button type="button" class="recipe-card" data-action="run-agent-pick" data-ticket="${attr(ticket.id)}" data-recipe="${attr(r.name)}"${retryOf ? ` data-retry-of="${attr(retryOf)}"` : ''}><span class="recipe-card-head"><strong>${esc(r.name)}</strong> <span class="chip small">${esc(SOURCE_LABELS[r.source] ?? r.source)}</span> <span class="chip small${edits ? ' warning' : ''}">${access}</span></span><span class="small">${esc(r.description)}</span><span class="small muted">${esc(permissionSummary(r.permissions))} · ${esc(recipeCap(r))} min</span></button></li>`;
  }).join('');
  return `<div class="dialog-form run-agent"><h2 id="dialog-title">${icon('play')}Run agent on ${keyEl(ticket.key)}</h2>
<p class="muted small">${esc(ticket.title)}. Pick what to run; you choose its permissions next.</p>
${cards ? `<ul class="recipe-cards">${cards}</ul>` : '<p class="muted small">No recipes found. Add one in <code>.quill/agents/</code> or <code>~/.claude/quill/agents/</code>.</p>'}
<div class="dialog-actions"><button type="button" class="btn ghost" data-action="close-dialog">Cancel</button></div></div>`;
}
