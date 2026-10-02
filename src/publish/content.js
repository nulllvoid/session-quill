// What a publisher sends (ADR 0010): rows built from the export sanitizer, so the same privacy rules
// apply as for a shared HTML snapshot — configured projects and fields only, local paths redacted,
// links only when the publisher includes them.
import { sanitizeSnapshot } from '../export/sanitize.js';
import { PUBLISH_FIELDS } from './config.js';

const STATUS_ORDER = ['active', 'review', 'deploy-pending', 'blocked', 'todo', 'done'];
const STATUS_LABELS = { todo: 'To do', active: 'Active', review: 'Review', 'deploy-pending': 'Deploy pending', blocked: 'Blocked', done: 'Done' };

function exportFields(fields) {
  return [...new Set(fields.map((f) => PUBLISH_FIELDS[f]))];
}

function value(t, field) {
  switch (field) {
    case 'next': return t.next_action ?? '';
    case 'updated': return t.last_activity ?? t.updated_at ?? '';
    case 'pr': return (t.prs ?? []).map((p) => (p.url ? `${p.state} ${p.url}` : p.state)).join(', ');
    case 'deployments': return (t.environments ?? []).filter((e) => e.state !== 'none').map((e) => `${e.environment}: ${e.state}`).join(' · ');
    case 'external': return t.external ? (t.external.url ? `${t.external.key} ${t.external.url}` : t.external.key) : '';
    case 'stale': return !!t.stale;
    default: return t[field] ?? '';
  }
}

export function rowsFor(snapshot, publisher, { exportedAt } = {}) {
  const sanitized = sanitizeSnapshot(snapshot, { fields: exportFields(publisher.fields), projects: publisher.projects, includeLinks: publisher.include_links, exportedAt });
  // _ticket travels with each row (never written to a destination) so page edits can be checked
  // against the revision that was published (ADR 0011).
  return sanitized.tickets.map((t) => ({ ...Object.fromEntries(publisher.fields.map((f) => [f, value(t, f)])), _ticket: { id: t.id, revision: t.revision } }));
}

const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');

export function renderRollup(rows, { title, fields, generatedAt }) {
  const lines = [`## ${title}`, '', `Updated ${generatedAt} by Session Quill.`];
  const cols = fields.filter((f) => f !== 'status');
  for (const status of STATUS_ORDER) {
    const group = rows.filter((r) => (r.status ?? 'todo') === status);
    if (!group.length) continue;
    lines.push('', `### ${STATUS_LABELS[status]} (${group.length})`, '', `| ${cols.join(' | ')} |`, `| ${cols.map(() => '---').join(' | ')} |`);
    for (const r of group) lines.push(`| ${cols.map((f) => cell(r[f])).join(' | ')} |`);
  }
  if (!rows.length) lines.push('', 'No tickets in scope.');
  return `${lines.join('\n')}\n`;
}
