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
  if (chosen) return renderRecipeRunDialog(chosen, ticket, snapshot, { retryOf, note }).replace('</h2>', `<button type="button" class="btn ghost icon-only" data-action="close-dialog" aria-label="Close Run agent">${icon('x')}</button></h2><div class="composer-body">`).replace('<div class="dialog-actions">', '</div><div class="dialog-actions composer-footer">');
  return renderIntentComposer(ticket, snapshot, { retryOf, note, recipes });
}

export function intentPayload(fd) {
  const intent = fd.get('intent') || 'read-only';
  const edits = ['auto', 'full'].includes(intent), commit = edits && fd.get('commit') === 'on', push = commit && fd.get('push_branch') === 'on';
  return { ...(push && String(fd.get('branch') || '').trim() ? { branch: String(fd.get('branch')).trim() } : {}), intent, instructions: String(fd.get('instructions') || '').trim(), permissions: { commit, push_branch: push, open_draft_pr: push && fd.get('open_draft_pr') === 'on' } };
}
function renderIntentComposer(t, s, { retryOf, note, recipes }) {
  const repo = s.repos.find(r => r.id === t.repo_id), busy = s.handoffs.some(h => h.ticket_id === t.id && ['queued','running'].includes(h.state));
  const canEdit = !!repo && t.repo_state !== 'needs-clone';
  const modes = [['read-only','Read only','Inspect and report; no source edits or publishing.'],['plan','Plan','Produce a reviewable plan; no implementation.'],['auto','Auto','Edit and test in an isolated checkout; stop at the patch.'],['full','Full access','No Quill guard; production writes allowed. Your Claude Code deny rules still apply.']];
  return `<form class="dialog-form intent-composer" data-form="intent-run" data-ticket="${attr(t.id)}" data-revision="${t.revision}"${retryOf ? ` data-retry-of="${attr(retryOf)}"` : ''} data-can-edit="${canEdit}" data-busy="${busy}" data-has-provider="${!!(repo?.provider_configured ?? repo?.provider)}">
  <header class="composer-header"><h2 id="dialog-title">Run agent · ${esc(t.key)}</h2><button type="button" class="btn ghost icon-only" data-action="close-dialog" aria-label="Close Run agent">${icon('x')}</button></header>
  <div class="composer-body"><p>${esc(t.title)}</p><label>What should the agent accomplish?<textarea name="instructions" rows="4" maxlength="4000" required>${esc(note || t.next_action || '')}</textarea></label>
  <fieldset class="intent-modes"><legend>Mode</legend>${modes.map(([id,label,help]) => `<label><input type="radio" name="intent" value="${id}"${id === 'read-only' ? ' checked' : ''}> <strong>${label}</strong><span>${help}</span></label>`).join('')}</fieldset>
  <p class="small" data-intent-environment>${repo ? `${esc(repo.display_name || repo.id)} · ${repo.test_command ? `Test command: ${esc(repo.test_command)}` : 'No configured test command; changes cannot be test-verified.'}` : 'Task context only; no repository source is available.'}</p>
  <p class="critical small" data-intent-blocker${busy ? '' : ' hidden'}>${busy ? 'A run is already queued or running for this task.' : ''}</p>
  ${!canEdit ? '<p class="small">Auto needs a local repository. Link or clone a repository before requesting source edits.</p>' : ''}
  <fieldset data-intent-delivery hidden disabled><legend>Delivery for this run</legend><label><input type="checkbox" name="commit"> Commit locally</label><label><input type="checkbox" name="push_branch" disabled> Push branch</label><label><input type="checkbox" name="open_draft_pr" disabled> Open draft PR</label><label>Destination branch <input type="text" name="branch" placeholder="feat/agent-fix" pattern="[A-Za-z0-9._/-]+" disabled></label><p class="small">Publishing requires a non-default, unprotected destination branch.</p><p class="small" data-auto-delivery-note>Unchecked delivery steps are not authorized.</p><p class="small" data-full-delivery-note hidden>These choices control worker finalization. Full access can still commit, push or change external systems during the run.</p></fieldset>
  <details class="advanced"><summary>Advanced: templates and environment</summary><p class="small">Standard modes use pinned built-in templates. Legacy templates retain their own explicit permission controls.</p><label>Search templates <input type="search" data-template-search autocomplete="off" placeholder="Name or description"></label><p class="small muted" data-template-empty role="status" hidden>No templates match your search.</p><div class="legacy-template-list">${recipes.map(r => `<button type="button" class="btn small" data-action="run-agent-pick" data-ticket="${attr(t.id)}" data-recipe="${attr(r.name)}"${r.error ? ' disabled' : ''}>${esc(r.name)} <span class="small">${esc(r.description)} · ${esc(recipeCap(r))} min</span>${r.error ? ' · invalid' : ''}</button>`).join('')}</div></details></div>
  <footer class="dialog-actions composer-footer"><button type="button" class="btn ghost" data-action="close-dialog">Cancel</button><button type="submit" class="btn primary"${busy ? ' disabled' : ''}>Run</button></footer></form>`;
}
