// Importing the issues assigned to the owner (ADR 0024). Each new issue becomes a ticket through
// the ordinary ticket-create event, under its tracker key and with a deterministic id, so an issue
// imported twice (by the worker and by `quill tracker import`, or after a crash) is one ticket.
// Nothing here runs an agent or writes to the tracker.
import { externalTicketId } from '../core/external-keys.js';

export const IMPORT_LIMIT = 50;

// A GitHub issue number needs a prefix to be a ticket key: the tracker's first allowed prefix,
// else the repository name in capitals (acme/web-app gives WEB_APP-12).
export function githubPrefix(tracker) {
  if (tracker && Array.isArray(tracker.prefixes) && tracker.prefixes.length) return tracker.prefixes[0];
  const name = String((tracker && tracker.repo) || '').split('/').pop() ?? '';
  const prefix = name.toUpperCase().replace(/[^A-Z0-9_]+/g, '_').replace(/^[^A-Z]+/, '').replace(/_+$/, '').slice(0, 20);
  return prefix || 'GH';
}

export function importKey(issue, tracker) {
  if (tracker.system === 'github') return `${githubPrefix(tracker)}-${issue.number}`;
  return String(issue.key).toUpperCase();
}

function keyTaken(keys, key) {
  const upper = key.toUpperCase();
  for (const k of keys) if (k.toUpperCase() === upper) return true;
  return false;
}

// The ticket-create payloads for issues that are not tickets yet, and the keys already present.
// `keys` holds every ticket key and alias in the store.
export function planImport(issues, { tracker, keys, storeId, projectId, projectName = null, category = 'research', now }) {
  const create = [];
  const existing = [];
  const seen = new Set();
  for (const issue of issues) {
    const key = importKey(issue, tracker);
    if (seen.has(key)) continue;
    seen.add(key);
    if (keyTaken(keys, key)) { existing.push(key); continue; }
    const remote = { title: issue.title ?? null, status: issue.status ?? null, assignee: issue.assignee ?? null, fix_versions: Array.isArray(issue.fix_versions) ? issue.fix_versions.slice(0, 10) : [], fetched_at: now };
    const external = { system: tracker.system, key, url: issue.url ?? null, validation: 'valid', validated_at: now, error: null, remote };
    create.push({
      id: externalTicketId(storeId, key), key, title: String(issue.title || key).replace(/\s+/g, ' ').trim().slice(0, 200), project_id: projectId, project_name: projectName ?? projectId,
      category, priority: 'P2', parent_id: null, repo_id: null, due: null, external,
      jira: tracker.system === 'jira' ? { key, url: external.url, validation: 'valid', validated_at: now, error: null } : null,
      created_via: `imported from ${tracker.system}`,
    });
  }
  return { create, existing };
}

export const importSourceIdentity = (key) => `tracker-import:${key}`;

// The project new tickets join: the default project, else the first one configured.
export function importProject(config) {
  const projects = config.projects ?? {};
  const id = config.default_project && projects[config.default_project] ? config.default_project : Object.keys(projects)[0] ?? null;
  return id ? { id, name: projects[id].name ?? id } : null;
}

export function storeKeys(tickets) {
  const keys = [];
  for (const t of tickets) { keys.push(t.key); for (const a of t.aliases ?? []) keys.push(a); }
  return keys;
}
