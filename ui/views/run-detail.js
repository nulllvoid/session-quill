// Run detail (spec §3): what a run did, what the worker verified, where it is, and what is left for
// the owner to decide. Sections an export stripped are omitted, never shown empty.
// Autonomous runs (FEAT-12 spec §5.3, §5.4, §8) add the run's own record — plan, attempts checked
// against the tool ledger, the agent's verification, critical changes — read from its result blob
// on the owner's dashboard only, plus what the worker recorded: the stage it observed, the
// learnings it filed, turns and cost. Every word of a record is agent or tool text: all escaped.
import { esc, attr, icon, timeEl, handoffChip, ticketById, normalizeSnapshot, contentViewer, keyEl, trustChip, repoName } from '../components.js';
import { testGateChip, accessBadge, runTimings, runQuality, suggestionItem, fileEffects, SOURCE_LABELS } from './agents.js';
import { supersededBy } from '../lib/runs.js';

// The worker's own rule (src/handoff/resume.js resumeProblem): interrupted, with a session id that
// Claude Code reported (a UUID).
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const resumable = (h) => h.state === 'failed' && !!h.error && h.error.code === 'interrupted' && typeof h.session_id === 'string' && SESSION_ID_RE.test(h.session_id);

// Planned files (ADR 0037): writes the run's guard saw land outside them. Observed, never refused,
// so the chip is amber and says it was recorded; an export carries the count without the paths.
function driftChip(h) {
  const n = h.scope_drift;
  if (!Number.isInteger(n) || n <= 0) return '';
  return ` <span class="chip warning small" title="Writes inside the checkout to files the run's planned files do not cover: recorded, not blocked">${icon('alert')}${esc(`${n} write${n === 1 ? '' : 's'} outside planned files`)}</span>`;
}

const section = (title, body) => (body ? `<section class="detail-section"><h3>${esc(title)}</h3>${body}</section>` : '');

// Record values are whatever the agent wrote: only strings (and finite numbers) are shown.
const recordText = (v) => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
const recordRows = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object' && !Array.isArray(x)) : []);

/** The run's result blob as the dashboard reads it: a JSON object, else null. */
export function parseRunRecord(text) {
  if (typeof text !== 'string') return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

// The stages of src/handoff/stage.js, lowest first. The worker records only what it observed; the
// agent's own stage is a claim, and a claim above the record says it was not recorded (§6).
const STAGE_ORDER = ['investigated', 'planned', 'changed', 'tested', 'committed', 'pushed', 'pr_opened', 'ci_checked', 'deployed', 'verified'];
const STAGE_WORDS = { pr_opened: 'PR opened', ci_checked: 'CI checked' };
const stageWord = (s) => STAGE_WORDS[s] ?? s;

// recordedStage() returns 'investigated' when it saw no evidence at all: that floor is a default,
// not an observation, so it is never shown as "Recorded" (R51).
const STAGE_FLOOR = 'investigated';

function stageLine(h) {
  const claim = STAGE_ORDER.includes(h.stage_reached) ? h.stage_reached : null;
  if (!STAGE_ORDER.includes(h.recorded_stage) || h.recorded_stage === STAGE_FLOOR) {
    return claim ? `<p>${esc(`Agent reports: ${stageWord(claim)} (not recorded)`)}</p><p class="small muted">The worker saw no test gate pass, commit, push or pull request for this run.</p>` : '';
  }
  const rec = h.recorded_stage;
  let text = `Recorded: ${stageWord(rec)}`;
  if (claim && claim !== rec) text += ` · agent reports: ${stageWord(claim)}${STAGE_ORDER.indexOf(claim) > STAGE_ORDER.indexOf(rec) ? ' (not recorded)' : ''}`;
  return `<p>${esc(text)}</p><p class="small muted">The recorded stage is what the worker saw for itself: the test gate passing, a commit, a push, a pull request.</p>`;
}

// Measured turns and cost. Under a claude.ai subscription the cost is an estimate (spec §5.2).
function turnsAndCost(h) {
  const parts = [];
  if (Number.isInteger(h.num_turns) && h.num_turns >= 0) parts.push(`${h.num_turns} turn${h.num_turns === 1 ? '' : 's'}`);
  if (Number.isFinite(h.cost_usd) && h.cost_usd >= 0) {
    const usd = `$${h.cost_usd > 0 && h.cost_usd < 0.01 ? h.cost_usd.toFixed(4) : h.cost_usd.toFixed(2)}`;
    parts.push(h.cost_estimated === false ? usd : `≈ ${usd} (estimated)`);
  }
  return parts.length ? `<p>${esc(parts.join(' · '))}</p>` : '';
}

// What an attempt's outcome means, in words (spec §8); a tone only repeats it, and an outcome the
// agent reports is never shown as a success.
export function attemptLabel(a) {
  const outcome = recordText(a.outcome);
  const why = `${recordText(a.reason)} ${recordText(a.evidence)}`;
  if (outcome === 'refused') return [/QUILL_CRITICAL_CHANGE|\bscopes?\b/i.test(why) ? 'Refused (no scope)' : 'Refused', 'warning'];
  if (outcome === 'unavailable') return [/needs?[- ]?auth|authenticat|unauthori[sz]ed|\blog(?:ged)? ?in\b|sign(?:ed)?[- ]?in|\b401\b/i.test(why) ? 'Unavailable (needs auth)' : /polic/i.test(why) ? 'Unavailable (policy)' : 'Unavailable', 'warning'];
  if (outcome === 'failed') return ['Failed', 'critical'];
  if (outcome === 'worked') return ['Worked', ''];
  if (outcome === 'skipped') return ['Skipped', ''];
  return ['Outcome not stated', ''];
}

/** One attempt (a run's reconciled list, or a Run note's): outcome, ledger check, route, tool, target, reason, evidence. */
export function attemptItem(a) {
  const [label, tone] = attemptLabel(a);
  const route = recordText(a.route);
  const tool = recordText(a.tool);
  const target = recordText(a.target);
  const reason = recordText(a.reason);
  const evidence = recordText(a.evidence);
  const chips = [`<span class="chip small${tone ? ` ${tone}` : ''}">${esc(label)}</span>`];
  if (a.verified === 'claimed-no-call') chips.push('<span class="chip warning small" title="The agent names this tool, but the run\'s tool ledger shows no call of it">Claimed, no tool call seen</span>');
  if (a.added === true) chips.push('<span class="chip small" title="The run\'s tool ledger recorded this refusal; the agent did not report it">Added from the run ledger</span>');
  return `<li class="attempt" data-outcome="${attr(recordText(a.outcome))}"><span class="attempt-chips">${chips.join(' ')}</span> <span class="attempt-route">${esc(route || '(route not given)')}</span>${tool ? ` <code>${esc(tool)}</code>` : ''}${target ? ` <span class="muted">on</span> <code>${esc(target)}</code>` : ''}${reason ? `<p class="small">${esc(reason)}</p>` : ''}${evidence ? `<p class="small muted">Evidence: ${esc(evidence)}</p>` : ''}</li>`;
}

// The agent's own checks. Only the worker's test gate (in the header) is Quill's verification.
const VERIFY_WORDS = { passed: ['Passed (agent\'s check)', ''], failed: ['Failed', 'critical'], 'not-run': ['Not verified', 'warning'] };

function runVerification(rows) {
  if (!rows.length) return '';
  const items = rows.map((r) => {
    const [label, tone] = VERIFY_WORDS[recordText(r.result)] ?? ['Result not stated', ''];
    const method = recordText(r.method);
    const command = recordText(r.command);
    const detail = recordText(r.detail);
    return `<li><span class="chip small${tone ? ` ${tone}` : ''}">${esc(label)}</span> ${esc(recordText(r.claim) || '(claim not given)')}${method ? ` <span class="muted small">by ${esc(method)}</span>` : ''}${command ? `<p class="small"><code>${esc(command)}</code></p>` : ''}${detail ? `<p class="small muted">${esc(detail)}</p>` : ''}</li>`;
  });
  return `<p class="small muted">${esc('What the agent reports it checked. Only "Tests passed (worker)" is Quill\'s own check.')}</p><ul class="run-verification">${items.join('')}</ul>`;
}

// The tools the attempts name, each checked against the run's tool ledger (spec §5.4).
function toolsUsed(attempts) {
  const tools = new Map();
  for (const a of attempts) {
    const name = recordText(a.tool).trim();
    if (!name) continue;
    const t = tools.get(name) ?? { name, count: 0, seen: false, claimedOnly: true };
    t.count += 1;
    if (a.verified === 'seen') t.seen = true;
    if (a.verified !== 'claimed-no-call') t.claimedOnly = false;
    tools.set(name, t);
  }
  if (!tools.size) return '';
  const items = [...tools.values()].map((t) => `<li><code>${esc(t.name)}</code> <span class="muted small">${esc(`${t.count} attempt${t.count === 1 ? '' : 's'}`)}</span>${t.claimedOnly ? ' <span class="chip warning small">Claimed, no tool call seen</span>' : t.seen ? ' <span class="chip small">Call in the run ledger</span>' : ''}</li>`);
  return `<p class="small muted">The tools the attempts name, checked against the run's tool ledger.</p><ul class="run-tools">${items.join('')}</ul>`;
}

// Where critical change i of this run stands (spec §7): its proposal, found through the child
// ticket's critical_spec, or why it was not proposed (critical_notes, owner only). Approval itself
// stays in Runs → Needs you.
function criticalState(h, i, snapshot, caps) {
  let child = null;
  const p = (snapshot.run_proposals ?? []).find((x) => {
    if (!x || x.origin !== 'run' || x.from_handoff_id !== h.id) return false;
    const c = ticketById(snapshot, x.ticket_id);
    if (!(c && c.critical_spec && c.critical_spec.index === i)) return false;
    child = c;
    return true;
  });
  if (p) {
    const link = `<button type="button" class="link" data-open="${attr(child.id)}">${keyEl(child.key)}</button>`;
    if (p.state === 'proposed') return `Proposed as ${link}; it waits for your decision in Needs you.${caps.handoff ? ' <button type="button" class="btn small ghost" data-action="open-needs-you">Open Needs you</button>' : ''}`;
    if (p.state === 'approved') return `Approved; queued as a run on ${link}.`;
    if (p.state === 'dismissed') return `Dismissed (${link}).`;
    return `Expired without a decision (${link}).`;
  }
  const note = caps.handoff ? recordRows(h.critical_notes).find((n) => n.index === i) : null;
  if (note) return `Not proposed: ${esc(recordText(note.reason) || 'no reason recorded')}`;
  if (h.state !== 'done') return 'Not proposed: only a run that finishes done proposes its critical changes.';
  return '';
}

function runCriticalChanges(h, changes, snapshot, caps) {
  const line = (label, v) => { const s = recordText(v); return s ? `<p class="small">${label}: ${esc(s)}</p>` : ''; };
  return changes.map((c, i) => {
    const scope = recordText(c.scope);
    const target = recordText(c.target);
    const scopeText = scope && target && !scope.includes(':') ? `${scope}:${target}` : scope;
    const risk = recordText(c.risk);
    const action = recordText(c.action);
    const state = criticalState(h, i, snapshot, caps);
    return `<li class="critical-change"><strong>${esc(recordText(c.title) || 'Untitled change')}</strong>${scopeText ? ` <span class="chip warning small">${icon('alert')}Needs write scope ${esc(scopeText)}</span>` : ''}${risk ? ` <span class="chip small">Risk: ${esc(risk)}</span>` : ''}${action ? `<p class="small">Action: <code class="critical-action">${esc(action)}</code></p>` : ''}${line('Why', c.why)}${line('Evidence', c.evidence)}${line('Verify', c.verify)}${line('Rollback', c.rollback)}${state ? `<p class="small critical-state">${state}</p>` : ''}</li>`;
  }).join('');
}

// The production writes a full-access run's observe-mode guard allowed (spec §7, R52; final review M3:
// the calls it let through, not their outcomes):
// owner only (exports drop prod_effects), each as a warning in words. The ledger keeps the tool,
// scope, target and time, not the command line.
function productionWrites(h, caps, { now, tz }) {
  if (!caps.handoff) return '';
  const effects = recordRows(h.prod_effects);
  if (!effects.length) return '';
  const items = effects.map((e) => {
    const scope = recordText(e.scope);
    const target = recordText(e.target);
    const where = scope ? `${scope}${target ? `:${target}` : e.ambiguous === true ? ' · target not pinned to one' : ''}` : 'scope not recorded';
    const when = typeof e.t === 'string' && e.t ? ` ${timeEl(e.t, now, tz)}` : '';
    return `<li><span class="chip warning small">${icon('alert')}Production write allowed (outcome not recorded)</span> <code>${esc(recordText(e.tool) || 'tool not recorded')}</code> <span class="small">${esc(where)}</span>${when}</li>`;
  });
  return `<p class="small muted">Full access lifts the guard: it allowed these production writes and did not stop them; whether each one succeeded is not recorded.</p><ul class="run-prod-writes">${items.join('')}</ul>`;
}

// What the worker filed from this run (spec §6.2): memory entries that name it (repo, machine and
// quarantined ones, from the owner's memory listing) and the task lessons in the ticket's Run note.
function learningsFiled(h, snapshot, memory) {
  const out = [];
  const seen = new Set();
  for (const e of recordRows(memory && memory.entries)) {
    if (e.run_id !== h.id || seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  const t = ticketById(snapshot, h.ticket_id);
  const note = t ? recordRows(t.run_notes).find((n) => n.run_id === h.id) : null;
  for (const l of recordRows(note && note.lessons)) {
    if (typeof l.entry_id === 'string' && seen.has(l.entry_id)) continue;
    if (typeof l.entry_id === 'string') seen.add(l.entry_id);
    out.push({ id: l.entry_id ?? null, text: l.text, trust: l.trust, scope: 'task', task: true });
  }
  return out;
}

function learningItemOfRun(e, snapshot, caps) {
  const scope = recordText(e.scope);
  const where = e.task ? 'task lesson on this ticket' : scope === 'repo' ? `repo ${repoName(snapshot, e.repo_id) ?? recordText(e.repo_id)}` : scope;
  const tab = e.trust === 'quarantined' ? 'quarantine' : scope === 'repo' ? 'repo' : 'machine';
  const open = caps.handoff && !e.task && typeof e.id === 'string' ? ` <button type="button" class="btn small ghost" data-action="open-memory" data-tab="${tab}" data-entry="${attr(e.id)}"${tab === 'repo' && e.repo_id ? ` data-repo="${attr(e.repo_id)}"` : ''}>Open in Memory</button>` : '';
  return `<li>${trustChip(recordText(e.trust) || 'unknown')} ${esc(recordText(e.text))} <span class="muted small">${esc(where)}</span>${open}</li>`;
}

// The run record is fetched on the owner's dashboard only; while it loads or after a failure the
// panel says so (with Retry) instead of looking as if the run had nothing to show.
function recordStatusLine(h, status, generation) {
  if (!h.result_ref || !status) return '';
  if (status === 'loading') return '<p class="small muted run-record-status" aria-busy="true">Loading the run\'s plan, attempts and checks…</p>';
  if (status.error) return `<p class="small run-record-status"><span class="critical" role="alert">Could not load the run's plan, attempts and checks: ${esc(status.error)}</span> <button type="button" class="btn small ghost" data-action="load-run-record" data-hash="${attr(h.result_ref)}" data-generation="${attr(generation)}">Retry</button></p>`;
  return '';
}

function closeRow(t) {
  return `<div class="detail-nav"><button type="button" class="btn icon-only" data-action="close-run" aria-label="Close run (Escape)">${icon('x')}</button>${t ? `<button type="button" class="btn small ghost" data-action="open-ticket-from-run" data-ticket="${attr(t.id)}">Open ticket</button>` : ''}<span class="detail-nav-keys"><button type="button" class="btn small ghost icon-only prev" data-action="run-prev" aria-label="Previous run">${icon('chevron')}</button><button type="button" class="btn small ghost icon-only" data-action="run-next" aria-label="Next run">${icon('chevron')}</button></span></div>`;
}

export function renderRunNotFound(id) {
  return `<article class="detail run-detail" data-run="${attr(id)}"><header class="detail-head"><div class="detail-nav"><button type="button" class="btn icon-only" data-action="close-run" aria-label="Close (Escape)">${icon('x')}</button></div><h2 id="detail-title">Run not found</h2><p class="muted small">This run is not in the current snapshot. It may be older than the snapshot keeps or belong to another store.</p></header></article>`;
}

// `record` is the parsed result blob (parseRunRecord) when the owner's dashboard has it, and
// `recordStatus` 'loading' or { error } while it does not; `memory` is the owner's memory listing.
export function renderRunDetail(h, rawSnapshot, { now, pending = [], content = {}, contentStatus = {}, record = null, recordStatus = null, memory = null } = {}) {
  const snapshot = normalizeSnapshot(rawSnapshot);
  const caps = snapshot.capabilities ?? {};
  const tz = snapshot.meta.timezone;
  const t = ticketById(snapshot, h.ticket_id);
  const name = h.recipe ? h.recipe.name : h.mode;
  const source = h.recipe && h.recipe.source ? ` <span class="chip small">${esc(SOURCE_LABELS[h.recipe.source] ?? h.recipe.source)}</span>` : '';
  const next = supersededBy(snapshot, h);

  const head = `<header class="detail-head run-head">${closeRow(t)}
  <div class="detail-keys">${t ? keyEl(t.key) : '<span class="muted">Ticket not in view</span>'}</div>
  <h2 id="detail-title">${t ? esc(t.title) : esc(name)}</h2>
  <div class="detail-chips">${handoffChip({ ...h, error: null })} <strong>${esc(name)}</strong>${source}${h.recipe && h.recipe.name !== h.mode ? ` <span class="muted small">${esc(h.mode)}</span>` : ''} ${accessBadge(h)} ${testGateChip(h.test_gate)}${driftChip(h)}</div>
  ${runTimings(h)}
  <p class="small muted">Requested ${timeEl(h.requested_at, now, tz)}${h.batch_id ? ` · Batch ${esc(h.batch_id.slice(0, 8))}` : ''}${h.retry_of ? ' · Retry of an earlier run' : ''}${next ? ` · ${next.retried ? 'Retried as a new run' : 'Superseded by a later run'}` : ''}</p>
</header>`;

  const result = [
    h.error && h.error.message ? `<p class="small critical">${esc(h.error.message)}</p>` : '',
    h.result_summary ? `<p class="prewrap">${esc(h.result_summary)}</p>` : '',
    h.result_ref ? contentViewer(h.result_ref, { content, status: contentStatus, generation: snapshot.generation_id, label: h.state === 'done' ? 'Show full result' : 'Show partial result' }) : '',
    runQuality(h, { gate: false }),
  ].join('');

  const changes = [
    (h.changed_files ?? []).length ? `<p class="small">${h.changed_files.map((f) => `<code>${esc(f)}</code>`).join(' ')}</p>` : '',
    caps.handoff && Array.isArray(h.planned_paths) && h.planned_paths.length ? `<p class="small muted">Planned files: ${h.planned_paths.map((f) => `<code>${esc(f)}</code>`).join(' ')}</p>` : '',
    h.commit_sha ? `<p class="small">Commit <code>${esc(h.commit_sha.slice(0, 7))}</code> <button type="button" class="btn small ghost icon-only" data-copy="${attr(h.commit_sha)}" data-copy-label="the commit" aria-label="Copy the commit">${icon('copy')}</button></p>` : '',
    (h.test_results ?? []).length ? `<ul class="small test-results">${h.test_results.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : '',
    fileEffects(h, t ?? { id: h.ticket_id }, { canEdit: !!caps.edit_tickets, pending }),
  ].join('');

  // possible_writes (an interrupted run's allowed writes, R55) reach only the owner's snapshot.
  const unconfirmed = [...(h.uncertain_effects ?? []), ...(Array.isArray(h.possible_writes) ? h.possible_writes : [])];
  const uncertain = unconfirmed.length ? `<div class="run-uncertain" role="note">${icon('alert')}<div><strong>The worker could not confirm:</strong><ul>${unconfirmed.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div></div>` : '';
  const delivery = [
    h.pr_url ? (/^https?:\/\//i.test(h.pr_url) ? `<p><a href="${attr(h.pr_url)}" target="_blank" rel="noopener noreferrer">${esc(h.pr_url)}</a></p>` : `<p class="small"><code>${esc(h.pr_url)}</code></p>`) : '',
    h.branch ? `<p class="small">Branch <code>${esc(h.branch)}</code></p>` : '',
    uncertain,
  ].join('');

  // Local paths are owner-only text: never a link, never fetched, never exported.
  const where = caps.handoff && h.worktree_path ? `<p class="small"><code>${esc(h.worktree_path)}</code> <button type="button" class="btn small ghost icon-only" data-copy="${attr(h.worktree_path)}" data-copy-label="the run's checkout path" aria-label="Copy the checkout path">${icon('copy')}</button></p>` : '';

  const suggestions = (h.suggestions ?? []).length ? `<ul class="suggestions">${h.suggestions.map((s) => suggestionItem(s, h, t ?? { id: h.ticket_id }, { canEdit: !!caps.edit_tickets, pending })).join('')}</ul>` : '';

  // The run's own record (result blob). An export never has it: no result_ref, nothing fetched.
  const rec = record && typeof record === 'object' && !Array.isArray(record) ? record : {};
  const plan = (Array.isArray(rec.plan) ? rec.plan : []).map(recordText).filter(Boolean);
  const attempts = recordRows(rec.attempts);
  const verification = recordRows(rec.verification);
  const critical = recordRows(rec.critical_changes);
  const learned = learningsFiled(h, snapshot, memory);

  const actions = [];
  if (caps.handoff && ['queued', 'running'].includes(h.state)) actions.push(`<button type="button" class="btn small" data-action="cancel-handoff" data-handoff="${attr(h.id)}">Cancel</button>`);
  // A run interrupted by a worker restart or stop, with a recorded session, resumes that session as
  // a new run (spec §5.4); any other failure is retried afresh. Once superseded, neither is offered.
  if (caps.handoff && t && !next && resumable(h)) actions.push(`<button type="button" class="btn small" data-action="resume-run" data-ticket="${attr(t.id)}" data-handoff="${attr(h.id)}">Resume as new run</button>`);
  else if (caps.handoff && t && !next && ['failed', 'timed-out', 'cancelled'].includes(h.state)) actions.push(`<button type="button" class="btn small" data-action="run-agent" data-ticket="${attr(t.id)}" data-recipe="${attr(name)}" data-retry-of="${attr(h.id)}">Retry as new run</button>`);

  return `<article class="detail run-detail" data-run="${attr(h.id)}" aria-labelledby="detail-title">
${head}
${recordStatusLine(h, recordStatus, snapshot.generation_id)}
${section('Result', result)}
${section('Recorded stage', stageLine(h))}
${section('Plan', plan.length ? `<ol class="run-plan small">${plan.map((p) => `<li>${esc(p)}</li>`).join('')}</ol>` : '')}
${section(`Attempts (${attempts.length})`, attempts.length ? `<ul class="run-attempts">${attempts.map(attemptItem).join('')}</ul>` : '')}
${section('Verification', runVerification(verification))}
${section('Changes', changes)}
${section(`Critical changes (${critical.length})`, critical.length ? `<p class="small muted">Writes this run was not allowed to make. One Quill can pin to an exact action becomes its own ticket, which you approve in Runs → Needs you.</p><ul class="run-critical">${runCriticalChanges(h, critical, snapshot, caps)}</ul>` : '')}
${section('Production writes (full access)', productionWrites(h, caps, { now, tz }))}
${section('Delivery', delivery)}
${section(`Learnings filed (${learned.length})`, learned.length ? `<ul class="run-learnings">${learned.map((e) => learningItemOfRun(e, snapshot, caps)).join('')}</ul>` : '')}
${section('Tools used', toolsUsed(attempts))}
${section('Turns & cost', turnsAndCost(h))}
${section('Where it is', where)}
${section('Suggestions', suggestions)}
${actions.length ? `<div class="run-actions">${actions.join(' ')}</div>` : ''}
</article>`;
}
