// What a recipe run knows about its ticket (ADR 0013): the owner's own notes and the full latest
// plan and checkpoint, the work so far (files, commits and, with source access, their diff), the
// tickets around it, and what earlier runs on the ticket suggested and how the owner decided.
// Everything here is ticket data; the prompt fences it as data, never as instructions.
import { execFile } from 'node:child_process';
import { getBlob } from '../core/blobs.js';

export const CONTEXT_LIMITS = {
  user_notes: 6000,
  plan: 8000,
  checkpoint: 6000,
  files: 80,
  commits: 30,
  related: 20,
  history: 3,
  history_summary: 400,
  diff_total: 30000,
  diff_per_commit: 12000,
};

// Multi-line ticket data stays inside the data block: a run of dashes could imitate the prompt's
// section markers, so it is shortened; long text is cut with a note of how much was left out.
export function dataBlock(text, max) {
  const clean = String(text ?? '').replace(/\r\n?/g, '\n').replace(/-{5,}/g, '----').trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max)}\n… (truncated; ${clean.length - max} more characters)`;
}

const COMMIT_RE = /^Commit ([0-9a-f]{7,40})(?:: (.*?))?(?: \(attached\))?$/;

export function ticketCommits(ticket, limit = CONTEXT_LIMITS.commits) {
  const seen = new Set();
  const out = [];
  for (const e of ticket.timeline ?? []) {
    if (e.kind !== 'commit') continue;
    const m = COMMIT_RE.exec(e.text ?? '');
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ sha: m[1], message: m[2] ?? '', at: e.at });
  }
  return out.slice(-limit);
}

function brief(t) {
  return `${t.key} "${t.title}" (${t.status})`;
}

export function relatedTickets(state, ticket, limit = CONTEXT_LIMITS.related) {
  const get = (id) => state.tickets.get(id) ?? null;
  const parent = ticket.parent_id ? get(ticket.parent_id) : null;
  const siblings = parent ? (parent.children_ids ?? []).filter((id) => id !== ticket.id).map(get).filter(Boolean).slice(0, limit) : [];
  const children = (ticket.children_ids ?? []).map(get).filter(Boolean).slice(0, limit);
  return {
    parent: parent ? `${brief(parent)}${parent.next_action ? `; next: ${parent.next_action}` : ''}` : null,
    siblings: siblings.map(brief),
    children: children.map((c) => `${brief(c)}${c.next_action ? `; next: ${c.next_action}` : ''}`),
  };
}

function suggestionText(s) {
  if (s.type === 'followup') return `follow-up "${s.title}"`;
  if (s.type === 'deploy-evidence') return `deployment evidence for ${(s.items ?? []).map((i) => `${i.environment} ${i.state}`).join(', ')}`;
  return `${s.type.replace('-', ' ')} "${String(s.text ?? '').slice(0, 200)}"`;
}

// Earlier finished runs on the ticket, newest first, with each suggestion's fate.
export function runHistory(state, ticket, currentId, limit = CONTEXT_LIMITS.history) {
  const runs = [...state.handoffs.values()]
    .filter((h) => h.ticket_id === ticket.id && h.id !== currentId && ['done', 'failed', 'timed-out', 'cancelled'].includes(h.state))
    .sort((a, b) => String(b.finished_at ?? b.requested_at ?? '').localeCompare(String(a.finished_at ?? a.requested_at ?? '')))
    .slice(0, limit);
  return runs.map((h) => {
    const name = h.recipe ? h.recipe.name : h.mode;
    const summary = h.result_summary ? ` ${String(h.result_summary).replace(/\s+/g, ' ').slice(0, CONTEXT_LIMITS.history_summary)}` : '';
    const decided = (h.suggestions ?? []).map((s) => `${suggestionText(s)}: ${s.state === 'proposed' ? 'not decided yet' : s.state}`);
    const applied = h.legacy !== false && h.state === 'done' ? ' (results applied directly)' : '';
    return `- ${h.finished_at ?? h.requested_at} ${name} (${h.state})${applied}:${summary || ' no summary'}${decided.length ? `\n  Suggestions: ${decided.join('; ')}` : ''}`;
  });
}

function latestCheckpoint(state, ticket) {
  let best = null;
  for (const cp of state.checkpoints?.values() ?? []) {
    if (cp.ticket_id !== ticket.id || !cp.complete || !cp.content_ref || cp.dismissed_at) continue;
    if (!best || String(cp.recorded_at) > String(best.recorded_at)) best = cp;
  }
  return best;
}

export function gatherContext(state, ticket, { env = process.env, currentId = null, readBlob = (hash) => getBlob(hash, env) } = {}) {
  const plans = [...(ticket.plans ?? [])].sort((a, b) => String(a.approved_at).localeCompare(String(b.approved_at)));
  const plan = plans.at(-1) ?? null;
  const planText = plan ? (plan.content_ref && readBlob(plan.content_ref)) || plan.preview : null;
  const cp = latestCheckpoint(state, ticket);
  // The approved plan is often the latest checkpoint too; it is shown once.
  const cpText = cp && (!plan || cp.id !== plan.checkpoint_id) ? readBlob(cp.content_ref) || cp.preview : null;
  return {
    user_notes: ticket.user_notes && ticket.user_notes.trim() ? dataBlock(ticket.user_notes, CONTEXT_LIMITS.user_notes) : null,
    plan: planText ? { at: plan.approved_at, text: dataBlock(planText, CONTEXT_LIMITS.plan) } : null,
    checkpoint: cpText ? { at: cp.recorded_at, text: dataBlock(cpText, CONTEXT_LIMITS.checkpoint) } : null,
    files: (ticket.files_touched ?? []).slice(0, CONTEXT_LIMITS.files).map((f) => f.relative_path ?? String(f)),
    files_total: (ticket.files_touched ?? []).length,
    commits: ticketCommits(ticket),
    related: relatedTickets(state, ticket),
    history: runHistory(state, ticket, currentId),
    diff: null,
  };
}

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 15000, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

// The patch of the ticket's own commits, read from the run's isolated checkout. No external diff
// or textconv program runs, and a commit the checkout does not have is skipped.
export async function gatherDiff(cwd, commits, { total = CONTEXT_LIMITS.diff_total, perCommit = CONTEXT_LIMITS.diff_per_commit } = {}) {
  if (!cwd || !commits.length) return null;
  const parts = [];
  let used = 0;
  let skipped = 0;
  for (const c of commits) {
    if (used >= total) { skipped += 1; continue; }
    let out;
    try {
      out = await git(cwd, ['-c', 'core.quotepath=off', 'show', '--no-color', '--no-ext-diff', '--no-textconv', '--stat', '--patch', '--format=commit %H%nDate: %cI%n%n    %s%n', c.sha]);
    } catch {
      skipped += 1;
      continue;
    }
    const piece = dataBlock(out, Math.min(perCommit, total - used));
    parts.push(piece);
    used += piece.length;
  }
  if (!parts.length) return null;
  return `${parts.join('\n\n')}${skipped ? `\n… (${skipped} commit${skipped === 1 ? '' : 's'} not shown: missing from the checkout or over the size limit)` : ''}`;
}
