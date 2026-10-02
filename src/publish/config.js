// [[publish]] tables in user config (ADR 0010). Like [[schedule]], a repository cannot publish.
import path from 'node:path';
import crypto from 'node:crypto';

export const PUBLISH_KINDS = ['markdown', 'html', 'artifact'];
export const PLANNED_PUBLISH_KINDS = ['confluence', 'notion'];
// Publisher field names (the proposal's short forms) and the export field each one reads.
export const PUBLISH_FIELDS = {
  key: 'key', title: 'title', status: 'status', category: 'category', priority: 'priority', next: 'next_action', blocker: 'blocker',
  due: 'due', updated: 'last_activity', pr: 'prs', deployments: 'deployments', stale: 'stale', external: 'external',
};
const FIELD_ALIASES = { next_action: 'next', last_activity: 'updated', prs: 'pr' };
export const DEFAULT_PUBLISH_FIELDS = ['key', 'title', 'status', 'next', 'pr', 'deployments', 'updated'];
export const KIND_LABELS = { artifact: 'Live', html: 'Copy', markdown: 'Note' };
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const ARTIFACT_URL_RE = /^https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9-]+(?:[/?#][^\s"'<>]*)?$/;

// What the owner consents to (ADR 0010): the destination and what is sent there. Changing the path or
// URL, the fields, the projects, links or two-way makes it a new consent. A fingerprint, so neither
// the snapshot nor the journal carries the local path.
export function consentId(p) {
  const scope = { d: destinationOf(p), f: [...(p.fields ?? [])].sort(), p: p.projects ? [...p.projects].sort() : null, l: !!p.include_links, t: !!p.two_way };
  return crypto.createHash('sha256').update(JSON.stringify(scope)).digest('hex').slice(0, 16);
}

export function destinationOf(p) {
  return p.kind === 'artifact' ? `artifact:${p.url ?? 'new'}` : `${p.kind}:${p.path}`;
}

export function normalizePublishers(config = {}) {
  const raw = config.publish;
  if (raw === undefined) return { publishers: [], warnings: [] };
  if (!Array.isArray(raw)) return { publishers: [], warnings: ['[[publish]] must be a list of tables'] };
  const publishers = [];
  const warnings = [];
  const names = new Set();
  raw.forEach((p, i) => {
    const where = `publish ${p && typeof p.name === 'string' ? `"${p.name}"` : `#${i + 1}`}`;
    if (!p || typeof p !== 'object' || Array.isArray(p)) { warnings.push(`${where}: must be a table`); return; }
    if (typeof p.name !== 'string' || !NAME_RE.test(p.name)) { warnings.push(`${where}: name must use lowercase letters, digits and dashes`); return; }
    if (names.has(p.name)) { warnings.push(`${where}: duplicate name; ignored`); return; }
    if (PLANNED_PUBLISH_KINDS.includes(p.kind)) { warnings.push(`${where}: kind "${p.kind}" arrives in a later release; skipped`); return; }
    if (!PUBLISH_KINDS.includes(p.kind)) { warnings.push(`${where}: kind must be one of ${PUBLISH_KINDS.join(', ')}`); return; }
    const rawFields = p.fields ?? DEFAULT_PUBLISH_FIELDS;
    if (!Array.isArray(rawFields) || !rawFields.length) { warnings.push(`${where}: fields must be a list`); return; }
    const fields = [];
    for (const f of rawFields) {
      const name = FIELD_ALIASES[f] ?? f;
      if (!PUBLISH_FIELDS[name]) { warnings.push(`${where}: unknown field "${f}"; use ${Object.keys(PUBLISH_FIELDS).join(', ')}`); return; }
      if (!fields.includes(name)) fields.push(name);
    }
    if (!fields.includes('key')) fields.unshift('key');
    const projects = p.projects === undefined ? null : p.projects;
    if (projects !== null && (!Array.isArray(projects) || projects.some((x) => typeof x !== 'string'))) { warnings.push(`${where}: projects must be a list of project ids`); return; }
    const on = p.on ?? [];
    if (!Array.isArray(on) || on.some((x) => x !== 'reconcile')) { warnings.push(`${where}: on may only contain "reconcile"`); return; }
    let target = null;
    let url = null;
    if (p.kind === 'html') {
      if (typeof p.path !== 'string' || !p.path.trim()) { warnings.push(`${where}: an html publisher needs path = "<file.html>"`); return; }
      if (!/\.html?$/i.test(p.path.trim())) { warnings.push(`${where}: path must end in .html`); return; }
      target = path.resolve(config.store_path ?? '.', p.path.trim());
    } else if (p.kind === 'markdown') {
      target = path.resolve(config.store_path ?? '.', typeof p.path === 'string' && p.path.trim() ? p.path.trim() : path.join('rollups', `${p.name}.md`));
    } else if (p.url !== undefined) {
      if (typeof p.url !== 'string' || !ARTIFACT_URL_RE.test(p.url.trim())) { warnings.push(`${where}: url must be a claude.ai artifact link`); return; }
      url = p.url.trim();
    }
    const executor = p.kind === 'artifact' ? (p.executor ?? 'session') : null;
    if (p.kind === 'artifact' && !['session', 'cli'].includes(executor)) { warnings.push(`${where}: executor must be session or cli`); return; }
    const title = typeof p.title === 'string' && p.title.trim() ? p.title.trim().slice(0, 120) : p.name;
    publishers.push({ name: p.name, kind: p.kind, fields, projects: projects && projects.length ? [...projects] : null, include_links: p.include_links === true, path: target, url, title, after_reconcile: on.includes('reconcile'), executor, two_way: p.kind === 'artifact' && p.two_way === true });
    names.add(p.name);
  });
  return { publishers, warnings };
}
