// Agents panel on ticket detail (ADR 0008): the recipes available for the ticket's repository,
// the permissions each may use, and every run with the suggestions it left.
import { esc, attr, icon, timeEl, handoffChip, keyEl, normalizeSnapshot, normalizeTicket } from '../components.js';

const SOURCE_LABELS = { builtin: 'built-in', personal: 'personal', repo: 'repository' };
const ACTIVE = new Set(['pending', 'applying']);

// Repository recipes replace global ones of the same name for that repository only.
export function effectiveRecipes(rawSnapshot, repoId) {
  const snapshot = normalizeSnapshot(rawSnapshot);
  const byName = new Map();
  for (const r of snapshot.recipes ?? []) if (r.repo_id === null || r.repo_id === undefined) byName.set(r.name, r);
  if (repoId) for (const r of snapshot.recipes ?? []) if (r.repo_id === repoId) byName.set(r.name, r);
  return [...byName.values()];
}

export function permissionSummary(p = {}) {
  const extra = [p.commit ? 'commit' : null, p.push_branch ? 'push a branch' : null, p.open_draft_pr ? 'open a draft PR' : null].filter(Boolean);
  const base = p.edit_source ? 'Edits source in an isolated checkout' : p.read_source ? 'Reads source' : 'Notes only';
  return extra.length ? `${base}; may ${extra.join(', ')}` : base;
}

function recipeRow(r, ticket, canRun) {
  const head = `<strong>${esc(r.name)}</strong> <span class="chip small" data-source="${attr(r.source)}">${esc(SOURCE_LABELS[r.source] ?? r.source)}</span>`;
  if (r.error) return `<li class="recipe" data-recipe-row="${attr(r.name)}">${head} <span class="small critical">${icon('alert')}Invalid: ${esc(r.error)}</span></li>`;
  const run = canRun ? ` <button type="button" class="btn small" data-action="run-recipe" data-ticket="${attr(ticket.id)}" data-recipe="${attr(r.name)}">${icon('play')}Run…</button>` : '';
  return `<li class="recipe" data-recipe-row="${attr(r.name)}">${head} <span class="small">${esc(r.description)}</span><div class="small muted">${esc(permissionSummary(r.permissions))} · ${esc(r.timeout_min)} min${r.legacy ? '' : ' · results are suggestions'}</div>${run}</li>`;
}

function suggestionText(s) {
  if (s.type === 'next-action') return `<span class="label">Next action</span> ${esc(s.text)}`;
  if (s.type === 'blocker') return `<span class="label">Blocker</span> ${esc(s.text)}`;
  if (s.type === 'followup') return `<span class="label">Follow-up</span> ${esc(s.title)}${s.next_action ? `. Next: ${esc(s.next_action)}` : ''}${s.description ? `<details class="small"><summary>Description</summary><pre class="preview">${esc(s.description)}</pre></details>` : ''}`;
  if (s.type === 'description') return `<span class="label">Description</span> <span class="muted small">replaces the ticket's description when accepted</span><pre class="preview">${esc(s.text)}</pre>`;
  if (s.type === 'deploy-evidence') return `<span class="label">Deployment evidence</span> ${(s.items ?? []).map((i) => `${esc(i.environment)}: ${esc(i.state)}${i.evidence ? ` (${esc(i.evidence)})` : ''}`).join('; ')}`;
  if (s.type === 'comment-draft') return `<span class="label">Comment draft</span> <span class="muted small">never posted for you</span><pre class="preview">${esc(s.text)}</pre>`;
  return esc(s.type);
}

function suggestionItem(s, h, ticket, { canEdit, pending }) {
  const req = pending.find((r) => (r.kind === 'accept-suggestion' || r.kind === 'dismiss-suggestion') && ACTIVE.has(r.state) && r.payload && r.payload.handoff_id === h.id && r.payload.suggestion_id === s.id);
  let controls = '';
  if (s.state !== 'proposed') controls = ` <span class="chip small" data-suggestion-state="${attr(s.state)}">${s.state === 'accepted' ? 'Accepted' : 'Dismissed'}</span>`;
  else if (req) controls = ` <span class="muted small">${req.kind === 'accept-suggestion' ? 'Accepting…' : 'Dismissing…'}</span>`;
  else if (canEdit) {
    const ids = `data-ticket="${attr(ticket.id)}" data-handoff="${attr(h.id)}" data-suggestion="${attr(s.id)}"`;
    const copy = s.type === 'comment-draft' ? ` <button type="button" class="btn small ghost" data-copy="${attr(s.text)}" data-copy-label="the comment draft">${icon('copy')}Copy</button>` : '';
    controls = `${copy} <button type="button" class="btn small" data-action="accept-suggestion" ${ids}>${s.type === 'comment-draft' ? 'Mark used' : 'Accept'}</button> <button type="button" class="btn small ghost" data-action="dismiss-suggestion" ${ids}>Dismiss</button>`;
  }
  return `<li class="suggestion" data-type="${attr(s.type)}">${suggestionText(s)}${controls}</li>`;
}

const CONFIDENCE_LABELS = { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence' };

// How sure the run is, what it relied on, and whether its reply needed repair or a self-check (ADR 0013).
function runQuality(h) {
  const parts = [];
  if (h.result_confidence) parts.push(`<span class="chip small" data-confidence="${attr(h.result_confidence)}">${esc(CONFIDENCE_LABELS[h.result_confidence] ?? h.result_confidence)}</span>`);
  const q = h.result_quality;
  if (q && q.self_checked) parts.push('<span class="chip small" title="The agent checked each claim against its cited source before finishing">Self-checked</span>');
  if (q && q.repaired) parts.push('<span class="chip small" title="The first reply broke the output format and was repaired in a follow-up turn">Repaired reply</span>');
  if (q && (q.problems ?? []).length) parts.push(`<span class="chip warning small" title="${attr(q.problems.join('; '))}">Reply incomplete</span>`);
  const sources = h.result_sources ?? [];
  const list = sources.length ? `<details class="sources small"><summary>${esc(sources.length)} source${sources.length === 1 ? '' : 's'}</summary><ul>${sources.map((x) => `<li><code>${esc(x)}</code></li>`).join('')}</ul></details>` : '';
  return parts.length || list ? `<div class="run-quality">${parts.join(' ')}${list}</div>` : '';
}

function runItem(h, ticket, snapshot, { now, tz, caps, pending }) {
  const name = h.recipe ? h.recipe.name : h.mode;
  const suggestions = h.suggestions ?? [];
  return `<li>${handoffChip(h)} <strong>${esc(name)}</strong> <span class="muted small">${h.recipe && h.recipe.name !== h.mode ? `${esc(h.mode)} · ` : ''}requested ${timeEl(h.requested_at, now, tz)}</span>${h.result_summary ? `<p class="prewrap small">${esc(h.result_summary)}</p>` : ''}${runQuality(h)}${h.changed_files && h.changed_files.length ? `<p class="small">Changed: ${h.changed_files.map((f) => `<code>${esc(f)}</code>`).join(' ')}</p>` : ''}${suggestions.length ? `<ul class="suggestions">${suggestions.map((s) => suggestionItem(s, h, ticket, { canEdit: !!caps.edit_tickets, pending })).join('')}</ul>` : ''}${h.result_ref ? `<button type="button" class="link small" data-action="load-content" data-hash="${attr(h.result_ref)}" data-generation="${attr(snapshot.generation_id)}">Partial/full result</button>` : ''}${caps.handoff && ['queued', 'running'].includes(h.state) ? ` <button type="button" class="btn small ghost" data-action="cancel-handoff" data-handoff="${attr(h.id)}">Cancel</button>` : ''}${caps.handoff && ['failed', 'timed-out', 'cancelled'].includes(h.state) ? ` <button type="button" class="btn small ghost" data-action="${h.recipe && h.legacy === false ? 'run-recipe' : 'handoff'}" data-ticket="${attr(ticket.id)}"${h.recipe && h.legacy === false ? ` data-recipe="${attr(h.recipe.name)}"` : ''} data-retry-of="${attr(h.id)}">Retry as new run</button>` : ''}</li>`;
}

export function renderAgentsSection(ticket, rawSnapshot, { now, pending = [] } = {}) {
  const snapshot = normalizeSnapshot(rawSnapshot);
  const caps = snapshot.capabilities ?? {};
  const tz = snapshot.meta.timezone;
  const runs = (ticket.handoff_ids ?? []).map((id) => snapshot.handoffs.find((h) => h.id === id)).filter(Boolean);
  const recipes = effectiveRecipes(snapshot, ticket.repo_id);
  const canRun = !!caps.handoff && ticket.status !== 'done';
  const busy = runs.some((h) => ['queued', 'running'].includes(h.state));
  return `<section class="detail-section agents"><h3>Agents <span class="count">${esc(runs.length)}</span></h3>
${recipes.length ? `<ul class="recipes">${recipes.map((r) => recipeRow(r, ticket, canRun && !busy)).join('')}</ul>${canRun && busy ? '<p class="muted small">One run per ticket: wait for the current run or cancel it.</p>' : ''}` : '<p class="muted small">No recipes found. Add one in <code>.quill/agents/</code> or <code>~/.claude/quill/agents/</code>.</p>'}
<h4 class="small">Runs</h4>${runs.length ? `<ul class="handoffs">${runs.map((h) => runItem(h, ticket, snapshot, { now, tz, caps, pending })).join('')}</ul>` : '<p class="muted small">No runs yet.</p>'}</section>`;
}

export function renderRecipeRunDialog(recipe, rawTicket, rawSnapshot, { retryOf = null } = {}) {
  const snapshot = normalizeSnapshot(rawSnapshot);
  const ticket = normalizeTicket(rawTicket);
  const p = recipe.permissions ?? {};
  const repo = (snapshot.repos ?? []).find((r) => r.id === ticket.repo_id) ?? null;
  const fix = recipe.mode === 'attempt-fix';
  const boxes = [];
  if (p.read_source) boxes.push(`<label><input type="checkbox" name="read_source" ${repo ? 'checked' : ''}${fix || !repo ? ' disabled' : ''}> Read source in an isolated checkout${repo ? '' : ' <span class="muted small">(no registered repository)</span>'}</label>`);
  if (p.edit_source) boxes.push(`<label><input type="checkbox" name="edit_source" ${repo ? 'checked' : ''} disabled> Edit source in that checkout <span class="muted small">(required by this recipe)</span></label>`);
  if (p.commit) boxes.push('<label><input type="checkbox" name="commit"> Commit locally</label>');
  if (p.push_branch) boxes.push('<label><input type="checkbox" name="push_branch"> Push a branch <span class="muted small">(never a default or protected branch)</span></label><label class="indent">Branch <input type="text" name="branch" placeholder="feat/agent-..." pattern="[A-Za-z0-9._/-]+"></label>');
  // The worker refuses a draft PR without a PR provider, so the box is offered only when one is set.
  const provider = !!(repo && repo.provider);
  if (p.open_draft_pr) boxes.push(`<label><input type="checkbox" name="open_draft_pr"${provider ? '' : ' disabled'}> Open a draft PR${provider ? '' : ' <span class="muted small">(no PR provider configured for this repository)</span>'}</label>`);
  return `<form class="handoff-form" data-form="recipe-run" data-ticket="${attr(ticket.id)}" data-revision="${attr(ticket.revision)}" data-recipe="${attr(recipe.name)}"${fix ? ' data-requires-edit="true"' : ''}${retryOf ? ` data-retry-of="${attr(retryOf)}"` : ''}>
<h2 id="dialog-title">${icon('play')}Run ${esc(recipe.name)} on ${keyEl(ticket.key)}</h2>
<p class="small">${esc(recipe.description)} <span class="muted">(${esc(SOURCE_LABELS[recipe.source] ?? recipe.source)} recipe, mode ${esc(recipe.mode)})</span></p>
${boxes.length ? `<fieldset><legend>Permissions for this run</legend>${boxes.join('\n')}<p class="muted small">The recipe allows at most what is listed here. Anything with a side effect stays off unless you tick it.</p></fieldset>` : '<p class="small">This run works from the ticket notes only: no source access and no side effects.</p>'}
<label class="label" for="recipe-note">Note <span class="muted">(max 280)</span></label>
<textarea id="recipe-note" name="note" maxlength="280" rows="2" placeholder="Anything the agent should focus on?"></textarea>
<p class="muted small">Capped at ${esc(recipe.timeout_min)} minutes. ${recipe.legacy ? 'This built-in recipe applies its next action and follow-ups directly, as the handoff form always has.' : `Results arrive as suggestions you accept or dismiss on this ticket${(recipe.outputs ?? []).length ? ` (${esc(recipe.outputs.join(', '))})` : ''}.`}</p>
<div class="dialog-actions"><button type="submit" class="btn primary">Queue run</button><button type="button" class="btn ghost" data-action="close-dialog">Cancel</button></div>
</form>`;
}
