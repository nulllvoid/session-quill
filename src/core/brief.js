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

export function resumeBrief(ticket, { nowIso }) {
  if (!ticket) return null;
  const parts = [];
  const goal = (() => { try { return parseDescription(ticket.summary ?? '').goal; } catch { return null; } })();
  if (goal) parts.push(`Goal: ${clip(goal, 200)}`);
  if (ticket.status === 'blocked' && ticket.blocker) parts.push(`Blocked on: ${clip(ticket.blocker, 160)}`);
  if (ticket.next_action) parts.push(`Next action: ${clip(ticket.next_action, 200)}`);
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
  return text;
}
