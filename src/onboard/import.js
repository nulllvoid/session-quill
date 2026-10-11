// Importing the issues assigned to the owner (ADR 0024). Each new issue becomes a ticket through
// the ordinary ticket-create event, under its tracker key and with a deterministic id, so an issue
// imported twice (by the worker and by `quill tracker import`, or after a crash) is one ticket.
// Nothing here runs an agent or writes to the tracker.
import { externalTicketId } from '../core/external-keys.js';

export const IMPORT_LIMIT = 50;

// A GitHub issue number needs a prefix to be a ticket key: the tracker's first allowed prefix,
// else the repository name in capitals without separators (acme/web-app gives WEBAPP-12), so the
// key matches [A-Z][A-Z0-9]+-<number> like any other tracker key.
export function githubPrefix(tracker) {
  if (tracker && Array.isArray(tracker.prefixes) && tracker.prefixes.length) return tracker.prefixes[0];
  const name = String((tracker && tracker.repo) || '').split('/').pop() ?? '';
  const prefix = name.toUpperCase().replace(/[^A-Z0-9]+/g, '').replace(/^[^A-Z]+/, '').slice(0, 20);
  return prefix.length >= 2 ? prefix : 'GH';
}

export function importKey(issue, tracker) {
  if (tracker.system === 'github') return `${githubPrefix(tracker)}-${issue.number}`;
  return String(issue.key).toUpperCase();
}

const normalUrl = (u) => String(u ?? '').trim().replace(/\/+$/, '').toLowerCase();

// Whether a ticket already points at this issue: the same Jira key, or the same GitHub issue page
// (repository and number), whatever the ticket's own key is.
function pointsAt(ticket, issue, key, tracker) {
  const ext = ticket.external;
  if (tracker.system === 'github') return !!(ext && ext.system === 'github' && issue.url && normalUrl(ext.url) === normalUrl(issue.url));
  const same = (k) => typeof k === 'string' && k.toUpperCase() === key;
  return !!((ext && ext.system === tracker.system && same(ext.key)) || (ticket.jira && same(ticket.jira.key)));
}

function keyHolder(tickets, key) {
  return tickets.find((t) => String(t.key).toUpperCase() === key || (t.aliases ?? []).some((a) => String(a).toUpperCase() === key)) ?? null;
}

// The ticket-create payloads for issues that are not tickets yet; the keys of issues a ticket
// already points at (existing); and issues whose key another ticket holds (collisions, skipped).
export function planImport(issues, { tracker, tickets = [], storeId, projectId, projectName = null, category = 'research', now }) {
  const all = [...tickets];
  const create = [];
  const existing = [];
  const collisions = [];
  const seen = new Set();
  for (const issue of issues) {
    const key = importKey(issue, tracker).toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (all.some((t) => pointsAt(t, issue, key, tracker))) { existing.push(key); continue; }
    const holder = keyHolder(all, key);
    if (holder) { collisions.push({ key, ticket_key: holder.key }); continue; }
    const remote = { title: issue.title ?? null, status: issue.status ?? null, assignee: issue.assignee ?? null, fix_versions: Array.isArray(issue.fix_versions) ? issue.fix_versions.slice(0, 10) : [], fetched_at: now };
    const external = { system: tracker.system, key, url: issue.url ?? null, validation: 'valid', validated_at: now, error: null, remote };
    create.push({
      id: externalTicketId(storeId, key), key, title: String(issue.title || key).replace(/\s+/g, ' ').trim().slice(0, 200), project_id: projectId, project_name: projectName ?? projectId,
      category, priority: 'P2', parent_id: null, repo_id: null, due: null, external,
      jira: tracker.system === 'jira' ? { key, url: external.url, validation: 'valid', validated_at: now, error: null } : null,
      created_via: `imported from ${tracker.system}`,
    });
  }
  return { create, existing, collisions };
}

export const importSourceIdentity = (key) => `tracker-import:${key}`;

// The project new tickets join: the default project, else the first one configured.
export function importProject(config) {
  const projects = config.projects ?? {};
  const id = config.default_project && projects[config.default_project] ? config.default_project : Object.keys(projects)[0] ?? null;
  return id ? { id, name: projects[id].name ?? id } : null;
}

