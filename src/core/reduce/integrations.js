// Integrations: tracker sync, artifact comments, publisher and schedule runs.
import { timelineEntry } from './common.js';
import { editorLabel, proposalState, PROPOSAL_KEEP_MS } from '../../publish/run-proposals.js';

export const SCHEDULE_HISTORY = 20;

export const PUBLISH_HISTORY = 20;

// Remote tracker data for linked tickets (ADR 0011). Recorded beside the ticket, never in its own
// fields, and without a revision bump, so a sync can never make an owner's edit conflict.
export function applyTrackerSync(state, ev, result) {
  const p = ev.payload;
  if (!p || !Array.isArray(p.results)) return { rejected: 'tracker-sync-invalid' };
  for (const r of p.results) {
    const t = state.tickets.get(r.ticket_id);
    if (!t || !t.external || t.external.key !== r.key) continue;
    const ext = { ...t.external, error: r.error ?? null };
    if (r.validation) { ext.validation = r.validation; ext.validated_at = p.synced_at ?? ev.occurred_at; }
    if (r.remote) ext.remote = { title: r.remote.title ?? null, status: r.remote.status ?? null, assignee: r.remote.assignee ?? null, fix_versions: Array.isArray(r.remote.fix_versions) ? r.remote.fix_versions.slice(0, 10) : [], fetched_at: p.synced_at ?? ev.occurred_at };
    t.external = ext;
    if (t.jira && t.jira.key === r.key && r.validation) t.jira = { ...t.jira, validation: r.validation, validated_at: ext.validated_at, error: ext.error };
    result.changed.add(t.id);
  }
  // Repository resolutions (ADR 0024), also beside the ticket and without a revision bump. Linking
  // itself is a separate ticket-update; this records what the resolver found and when.
  for (const r of Array.isArray(p.resolutions) ? p.resolutions : []) {
    const t = r && state.tickets.get(r.ticket_id);
    if (!t) continue;
    const checkedAt = p.synced_at ?? ev.occurred_at;
    // A failed read of the issue's hints keeps what was known, moves the ticket to the back of the
    // queue and, when the tracker said not found or forbidden, waits before asking again.
    if (r.failed === true) {
      const prev = t.repo_resolution ?? { state: 'none', repo_id: null, remote: null, existing_path: null, rule: null, via: null };
      const failures = (prev.failures ?? 0) + 1;
      const backoff = r.error_kind === 'not-found' || r.error_kind === 'forbidden' ? Math.min(RESOLVE_BACKOFF_MS * 2 ** (failures - 1), RESOLVE_BACKOFF_MAX_MS) : 0;
      t.repo_resolution = { ...prev, checked_at: checkedAt, error: String(r.error ?? 'unknown error').slice(0, 300), error_kind: r.error_kind ?? 'error', failures, retry_after: backoff ? new Date(Date.parse(checkedAt) + backoff).toISOString().replace(/\.\d{3}Z$/, 'Z') : null };
      result.changed.add(t.id);
      continue;
    }
    if (!RESOLUTION_STATES.includes(r.state)) continue;
    const next = { state: r.state, repo_id: r.repo_id ?? null, remote: r.remote ?? null, existing_path: r.existing_path ?? null, rule: r.rule ?? null, via: r.via ?? null, checked_at: checkedAt, error: null, error_kind: null, failures: 0, retry_after: null };
    const prev = t.repo_resolution ?? null;
    const same = prev && prev.state === next.state && prev.repo_id === next.repo_id && prev.remote === next.remote && prev.existing_path === next.existing_path;
    t.repo_resolution = next;
    if (same) continue;
    if (next.state === 'needs-clone') t.timeline.push(timelineEntry(ev, 'tracker', next.existing_path ? `Repository ${next.remote} has a clone on this computer to register` : `Repository ${next.remote} needs a clone (${next.rule === 'repo_map' ? `repo_map ${next.via}` : 'linked from the issue'})`));
    else if (next.state === 'linked') t.timeline.push(timelineEntry(ev, 'tracker', `Repository ${next.repo_id} found (${next.rule === 'repo_map' ? `repo_map ${next.via}` : 'linked from the issue'})`));
    result.changed.add(t.id);
  }
  return {};
}

export const RESOLUTION_STATES = ['linked', 'needs-clone', 'none'];
// Back-off after a hint read the tracker answered with not found or forbidden: 1 day, doubling, at most 7.
export const RESOLVE_BACKOFF_MS = 24 * 3_600_000;
export const RESOLVE_BACKOFF_MAX_MS = 7 * 24 * 3_600_000;

// A confirmed write to the ticket's tracker issue (ADR 0018), or its failure. Only the timeline
// records it: the ticket's own fields and revision are untouched.
export function applyTrackerPush(state, ev, result) {
  const p = ev.payload;
  const t = p && state.tickets.get(p.ticket_id);
  if (!t) return { rejected: 'ticket-unknown' };
  const what = [p.to ? `status ${p.from ? `${p.from} → ` : ''}${p.to}` : null, p.comment ? 'a comment' : null].filter(Boolean).join(' and ');
  const text = p.ok ? `Pushed ${what} to ${p.system} ${p.key}` : `Push to ${p.system} ${p.key} failed: ${String(p.error ?? 'unknown error').slice(0, 160)}`;
  t.timeline.push(timelineEntry(ev, 'tracker', text));
  if (p.ok && p.to && t.external && t.external.key === p.key) t.external = { ...t.external, remote: { ...(t.external.remote ?? {}), status: p.to, fetched_at: ev.occurred_at } };
  result.changed.add(t.id);
  return {};
}

// A comment left on a two-way artifact page, matched to a ticket by its key (ADR 0011). It joins the
// ticket's timeline as data; the journal's source identity keeps each comment to one entry.
export function applyArtifactComment(state, ev, result) {
  const p = ev.payload;
  const t = p && state.tickets.get(p.ticket_id);
  if (!t || typeof p.text !== 'string') return { rejected: 'comment-invalid' };
  // Commenters are less trusted than anything else on the timeline: the text is kept to one line
  // with dash runs broken up, so it cannot pose as a prompt's data delimiter, and it is marked.
  const text = p.text.replace(/\s+/g, ' ').replace(/-{3,}/g, '–').trim().slice(0, 500);
  t.timeline.push(timelineEntry(ev, 'comment', `Comment from a page viewer on the ${p.publisher} page: ${text}`));
  result.changed.add(t.id);
  return {};
}

// A run proposed from a two-way page (ADR 0025). It is only recorded: nothing queues until the
// owner approves it. Like a comment it sits on the timeline without a revision bump, so a page
// pick can never make an owner's edit conflict. A second pick of the same recipe for the same
// ticket while one is open adds nothing. Resolved and lapsed proposals are dropped 30 days on.
const PERMISSION_KEYS = ['read_source', 'edit_source', 'commit', 'push_branch', 'open_draft_pr', 'edit_files', 'delete_files'];
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function applyRunProposal(state, ev, result) {
  const p = ev.payload;
  if (!p || typeof p.id !== 'string' || !p.recipe || typeof p.recipe.name !== 'string' || !NAME_RE.test(p.recipe.name) || typeof p.publisher !== 'string' || !NAME_RE.test(p.publisher)) return { rejected: 'proposal-invalid' };
  // A run-origin proposal (ADR 0028) comes only from a validated critical-proposal event
  // (reduce/critical.js); a page proposal can never carry a run origin, scopes or an action pin.
  if ((p.origin !== undefined && p.origin !== 'page') || p.from_handoff_id !== undefined || p.action_pin !== undefined || p.scopes !== undefined) return { rejected: 'proposal-origin-invalid' };
  const t = state.tickets.get(p.ticket_id);
  if (!t) return { rejected: 'ticket-unknown' };
  if (state.runProposals.has(p.id)) return { duplicate: true };
  pruneProposals(state, ev.occurred_at);
  const open = [...state.runProposals.values()].find((x) => x.ticket_id === t.id && x.recipe.name === p.recipe.name && proposalState(x, t, ev.occurred_at) === 'proposed');
  if (open) return { rejected: 'run-already-proposed' };
  const editor = editorLabel(p.editor);
  const permissions = Object.fromEntries(PERMISSION_KEYS.map((k) => [k, !!(p.permissions && p.permissions[k] === true)]));
  state.runProposals.set(p.id, {
    id: p.id, ticket_id: t.id, publisher: p.publisher, editor, edited_at: typeof p.edited_at === 'string' ? p.edited_at : null,
    recipe: { name: p.recipe.name, source: p.recipe.source ?? null, hash: p.recipe.hash ?? null }, mode: p.mode ?? null, permissions, access: 'standard', read_only: p.read_only === true,
    expected_revision: Number.isInteger(p.expected_revision) ? p.expected_revision : null, proposed_at: ev.occurred_at, lapsed_at: null, state: 'proposed', resolved_at: null, resolved_by: null, request_id: null, handoff_id: null,
  });
  // The editor id stays on the proposal, out of the timeline and so out of digests and prompts.
  t.timeline.push(timelineEntry(ev, 'proposal', `Run of ${p.recipe.name} proposed on the ${p.publisher} page; it waits for your approval`));
  result.changed.add(t.id);
  return {};
}

// Resolved and expired proposals are dropped PROPOSAL_KEEP_MS after they last changed.
export function pruneProposals(state, now) {
  for (const [id, x] of state.runProposals) {
    const last = x.resolved_at && x.resolved_at > x.proposed_at ? x.resolved_at : x.proposed_at;
    if (proposalState(x, state.tickets.get(x.ticket_id), now) !== 'proposed' && Date.parse(now) - Date.parse(last) > PROPOSAL_KEEP_MS) state.runProposals.delete(id);
  }
}

// A ticket that becomes done lapses its open proposals for good (ADR 0025): reopening it later does
// not bring a stale page pick back.
export function lapseProposals(state, ev, result) {
  if (!state.runProposals || !state.runProposals.size) return;
  for (const p of state.runProposals.values()) {
    if (p.state !== 'proposed' || p.lapsed_at || !result.changed.has(p.ticket_id)) continue;
    const t = state.tickets.get(p.ticket_id);
    if (t && t.status === 'done') p.lapsed_at = ev.occurred_at;
  }
}

// One finished publish of one publisher (ADR 0010). `confirmed` records the owner's consent to that
// destination, which later publishes to the same destination rely on.
export function applyPublishRun(state, ev) {
  const p = ev.payload;
  if (!p || typeof p.publisher !== 'string' || typeof p.run_id !== 'string' || typeof p.outcome !== 'string') return { rejected: 'publish-invalid' };
  let rec = state.publishers.get(p.publisher);
  if (!rec) {
    rec = { name: p.publisher, url: null, confirmed: [], last_published_at: null, last_outcome: null, last_error: null, last_summary: null, runs: [] };
    state.publishers.set(p.publisher, rec);
  }
  if (p.confirmed === true && typeof p.destination === 'string' && !rec.confirmed.includes(p.destination)) rec.confirmed.push(p.destination);
  if (typeof p.url === 'string' && p.url) rec.url = p.url;
  if (p.outcome === 'ok') rec.last_published_at = ev.occurred_at;
  rec.last_outcome = p.outcome;
  rec.last_error = p.error ?? null;
  rec.last_summary = p.summary ?? null;
  rec.runs.unshift({ run_id: p.run_id, at: ev.occurred_at, trigger: p.trigger ?? 'manual', outcome: p.outcome, summary: p.summary ?? null, error: p.error ?? null });
  if (rec.runs.length > PUBLISH_HISTORY) rec.runs.length = PUBLISH_HISTORY;
  return {};
}

// Every scheduled or manual job run is journaled, so the Schedules panel and replay agree (ADR 0007).
export function applyScheduleRun(state, ev) {
  const p = ev.payload;
  if (!p || typeof p.schedule !== 'string' || typeof p.run_id !== 'string' || !['started', 'finished'].includes(p.phase)) return { rejected: 'schedule-invalid' };
  let rec = state.schedules.get(p.schedule);
  if (!rec) {
    rec = { name: p.schedule, job: p.job ?? null, last_started_at: null, last_finished_at: null, last_outcome: null, last_error: null, last_summary: null, running_run_id: null, runs: [] };
    state.schedules.set(p.schedule, rec);
  }
  if (p.phase === 'started') {
    rec.job = p.job ?? rec.job;
    rec.last_started_at = ev.occurred_at;
    rec.running_run_id = p.run_id;
    rec.runs.unshift({ run_id: p.run_id, trigger: p.trigger ?? 'schedule', started_at: ev.occurred_at, finished_at: null, outcome: 'running', summary: null, error: null });
    if (rec.runs.length > SCHEDULE_HISTORY) rec.runs.length = SCHEDULE_HISTORY;
    return {};
  }
  const runRec = rec.runs.find((r) => r.run_id === p.run_id);
  if (runRec) Object.assign(runRec, { finished_at: ev.occurred_at, outcome: p.outcome ?? 'ok', summary: p.summary ?? null, error: p.error ?? null });
  rec.last_finished_at = ev.occurred_at;
  rec.last_outcome = p.outcome ?? 'ok';
  rec.last_error = p.error ?? null;
  rec.last_summary = p.summary ?? null;
  if (rec.running_run_id === p.run_id) rec.running_run_id = null;
  return {};
}
