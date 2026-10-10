// Integrations: tracker sync, artifact comments, publisher and schedule runs.
import { timelineEntry } from './common.js';

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
  return {};
}

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
