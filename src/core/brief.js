// A short "where was I?" brief for a session that binds to a ticket with history. Built from the
// ticket's projection only, bounded in size, and empty for a ticket nothing has happened on yet.
import { ageMs, DAY, HOUR } from '../lib/time.js';
import { parseDescription } from './description.js';

export const BRIEF_MAX = 1200;

function ago(iso, nowIso) {
  if (!iso) return null;
  const ms = ageMs(iso, nowIso);
  if (ms < HOUR) return 'within the hour';
  if (ms < DAY) return `${Math.floor(ms / HOUR)} h ago`;
  const d = Math.floor(ms / DAY);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// Files Claude can act on: repository-relative paths, most recently touched first.
function recentFiles(ticket, limit = 5) {
  return (ticket.files_touched ?? [])
    .filter((f) => f.relative_path && !/^([A-Za-z]:|\/)/.test(f.relative_path))
    .sort((a, b) => (a.last_seen < b.last_seen ? 1 : -1))
    .slice(0, limit)
    .map((f) => f.relative_path);
}

// The worker's context card (ADR 0038, src/memory/blast-radius.js), already filtered and cleaned
// when it was written; here it is only clipped. Empty when the card says nothing.
export const CONTEXT_MAX = 600;
const list = (v) => (Array.isArray(v) ? v : []);

export function contextBlock(card) {
  if (!card || typeof card !== 'object') return '';
  const parts = [];
  const co = list(card.co_change).slice(0, 5).filter((c) => c && c.file && c.partner).map((c) => `${clip(c.partner, 100)} with ${clip(c.file, 100)} (${Number(c.n) || 0} commits)`);
  if (co.length) parts.push(`Often changed together: ${co.join(', ')}`);
  const rel = list(card.related).slice(0, 5).filter((r) => r && r.key).map((r) => {
    const state = [r.status ? clip(r.status, 20) : null, r.live_run === true ? 'a run is live' : null].filter(Boolean).join(', ');
    return `${clip(r.key, 60)}${r.title ? ` "${clip(r.title, 80)}"` : ''}${state ? ` (${state})` : ''}: ${list(r.files).slice(0, 3).map((f) => clip(f, 100)).join(', ')}`;
  });
  if (rel.length) parts.push(`Other tickets on these files: ${rel.join('; ')}`);
  const guard = list(card.guard).slice(0, 5).filter((g) => typeof g === 'string' && g).map((g) => clip(g, 200));
  if (guard.length) parts.push(`Guard: ${guard.join('; ')}`);
  if (!parts.length) return '';
  let text = `Context: ${parts.map((p) => `${p}.`.replace(/\.\.$/, '.')).join(' ')}`;
  if (text.length > CONTEXT_MAX) text = `${text.slice(0, CONTEXT_MAX - 1)}…`;
  return text;
}


// The failure ledger (ADR 0032): the last FAILED_SHOWN worker test-gate failures from the ticket's Run
// notes, newest first, in the worker's own fields only (never test output). A page-proposed run's
// note is never given to anyone else, so it is skipped.
export const FAILED_SHOWN = 2;
function failedBefore(ticket) {
  const notes = (Array.isArray(ticket.run_notes) ? ticket.run_notes : [])
    .filter((n) => n && typeof n === 'object' && n.origin !== 'page' && n.failure && typeof n.failure === 'object')
    .sort((a, b) => (String(b.at ?? '') > String(a.at ?? '') ? 1 : String(b.at ?? '') < String(a.at ?? '') ? -1 : 0))
    .slice(0, FAILED_SHOWN);
  if (!notes.length) return null;
  const one = (n) => {
    const f = n.failure;
    const files = (Array.isArray(f.files_touched) ? f.files_touched : []).filter((x) => typeof x === 'string');
    const what = f.status === 'timeout' ? 'tests timed out' : `tests failed${Number.isInteger(f.exit_code) ? ` (exit ${f.exit_code})` : ''}`;
    const touched = files.length ? `, changed ${files.slice(0, 3).map((x) => clip(x, 80)).join(', ')}${files.length > 3 ? ` and ${files.length - 3} more` : ''}` : '';
    return `run ${String(n.run_id ?? '').slice(0, 8)} ${what}, signature ${clip(f.signature ?? 'unknown', 16)}${f.command ? ` running ${clip(String(f.command).replace(/`/g, "'"), 80)}` : ''}${touched}`;
  };
  return `Failed before: ${notes.map(one).join(' | ')}`;
}

export function resumeBrief(ticket, { nowIso, card = null }) {
  if (!ticket) return null;
  const parts = [];
  const goal = (() => { try { return parseDescription(ticket.summary ?? '').goal; } catch { return null; } })();
  if (goal) parts.push(`Goal: ${clip(goal, 200)}`);
  if (ticket.status === 'blocked' && ticket.blocker) parts.push(`Blocked on: ${clip(ticket.blocker, 160)}`);
  if (ticket.next_action) parts.push(`Next action: ${clip(ticket.next_action, 200)}`);
  const failed = failedBefore(ticket);
  if (failed) parts.push(failed);
  const plan = (ticket.plans ?? []).filter((p) => p.approved_at).slice(-1)[0] ?? (ticket.plans ?? []).slice(-1)[0];
  if (plan && plan.preview) parts.push(`${plan.approved_at ? 'Approved plan' : 'Latest plan'}: ${clip(plan.preview, 220)}`);
  const conclusions = (ticket.conclusions ?? []).slice(-2).map((c) => clip(c.preview, 160)).filter(Boolean);
  if (conclusions.length) parts.push(`Recent conclusions: ${conclusions.join(' | ')}`);
  const files = recentFiles(ticket);
  if (files.length) parts.push(`Recently changed: ${files.join(', ')}`);
  const prs = (ticket.prs ?? []).filter((p) => p.state === 'open' || p.state === 'draft' || p.state === 'merged').slice(-3);
  if (prs.length) parts.push(`PRs: ${prs.map((p) => `${p.url} (${p.state})`).join(', ')}`);
  const pending = (ticket.deployments ?? []).filter((d) => d.state === 'pending').map((d) => d.environment);
  if (pending.length) parts.push(`Awaiting deployment to: ${[...new Set(pending)].join(', ')}`);
  // Only a description: nothing has happened yet, so there is nothing to resume.
  if (!parts.some((p) => !p.startsWith('Goal:'))) return null;
  const when = ago(ticket.last_activity, nowIso);
  const head = `Where ${ticket.key} stands (${ticket.status}${when ? `, last activity ${when}` : ''}):`;
  let text = `${head} ${parts.map((p) => `${p}.`.replace(/\.\.$/, '.')).join(' ')}`;
  if (text.length > BRIEF_MAX) text = `${text.slice(0, BRIEF_MAX - 1)}…`;
  const context = contextBlock(card);
  return context ? `${text} ${context}` : text;
}
