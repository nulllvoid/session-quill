import { esc, attr, keyEl, icon, normalizeSnapshot, normalizeTicket } from '../components.js';

export function renderHandoffForm(rawTicket, rawSnapshot, { retryOf = null, prerequisites = {} } = {}) {
  const snapshot = normalizeSnapshot(rawSnapshot);
  const ticket = normalizeTicket(rawTicket);
  const repo = (snapshot.repos ?? []).find((r) => r.id === ticket.repo_id) ?? null;
  const providerConfigured = !!(repo && repo.provider);
  const issues = [];
  if (!repo) issues.push('No registered repository: source access and fixes are unavailable; note-only analysis still works.');
  if (prerequisites.claude === false) issues.push('Claude Code CLI not found on this machine; the worker will fail dispatch with a reason.');
  return `<form class="handoff-form" data-form="handoff" data-ticket="${attr(ticket.id)}" data-revision="${attr(ticket.revision)}" ${retryOf ? `data-retry-of="${attr(retryOf)}"` : ''}>
<h2 id="handoff-title">${icon('play')}Handoff ${keyEl(ticket.key)}</h2>
<p class="muted small">${esc(ticket.title)}. Permissions are explicit per request; approval text never grants them.</p>
${issues.length ? `<ul class="issues">${issues.map((i) => `<li>${icon('alert')}${esc(i)}</li>`).join('')}</ul>` : ''}
<fieldset><legend>Mode</legend>
  <label><input type="radio" name="mode" value="analyse"> Analyse — summarize and recommend; no children</label>
  <label><input type="radio" name="mode" value="analyse-followups" checked> Analyse with follow-ups — may create child tickets and suggest a next action</label>
  <label><input type="radio" name="mode" value="attempt-fix" ${repo ? '' : 'disabled'}> Attempt fix — isolated worktree; requires source read and edit</label>
</fieldset>
<label class="label" for="handoff-note">Note <span class="muted">(max 280)</span></label>
<textarea id="handoff-note" name="note" maxlength="280" rows="2" placeholder="What should the agent focus on?"></textarea>
<fieldset><legend>Source access</legend>
  <label><input type="checkbox" name="read_source" ${repo ? '' : 'disabled'}> Read source (registered repo on this machine)</label>
  <label><input type="checkbox" name="edit_source" ${repo ? '' : 'disabled'}> Edit source in an isolated checkout <span class="muted small">(requires read source; required for attempt fix)</span></label>
</fieldset>
<fieldset><legend>Actions (each a separate opt-in)</legend>
  <label><input type="checkbox" name="commit" ${repo ? '' : 'disabled'}> Commit locally <span class="muted small">(requires edit source)</span></label>
  <label><input type="checkbox" name="push_branch" ${repo ? '' : 'disabled'}> Push branch <span class="muted small">(requires commit; never a default or protected branch)</span></label>
  <label class="indent">Branch <input type="text" name="branch" placeholder="feat/handoff-..." pattern="[A-Za-z0-9._/-]+"></label>
  <label><input type="checkbox" name="open_draft_pr" ${providerConfigured ? '' : 'disabled'}> Open draft PR <span class="muted small">(requires push branch${providerConfigured ? '' : '; no PR provider configured'})</span></label>
</fieldset>
<p class="muted small">Without push or PR permission the result is a local diff and test output. Execution is capped at 20 minutes including sleep. One queued or running handoff per ticket.</p>
<div class="dialog-actions"><button type="submit" class="btn primary">Queue handoff</button><button type="button" class="btn ghost" data-action="close-dialog">Cancel</button></div>
</form>`;
}
