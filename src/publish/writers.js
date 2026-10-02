// Local publishers (ADR 0010): a markdown roll-up in a marked section of a note, and the read-only
// standalone HTML export written to a path. The artifact publisher lives in artifact.js.
import path from 'node:path';
import { writeMarkedSection } from '../lib/marked-section.js';
import { writeStaticHtml } from '../export/static.js';
import { renderRollup } from './content.js';
import { PUBLISH_FIELDS } from './config.js';

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function publishMarkdown(publisher, rows, { indexPath, now }) {
  const markdown = renderRollup(rows, { title: publisher.title ?? publisher.name, fields: publisher.fields, generatedAt: now });
  writeMarkedSection({ file: publisher.path, marker: `publish:${publisher.name}`, markdown, indexPath, conflictCode: 'publish-conflict' });
  return { summary: `${plural(rows.length, 'ticket')} written to ${path.basename(publisher.path)}` };
}

export function publishHtml(publisher, snapshot, { now }) {
  const fields = [...new Set(publisher.fields.map((f) => PUBLISH_FIELDS[f]))];
  const r = writeStaticHtml(snapshot, publisher.path, { fields, projects: publisher.projects, includeLinks: publisher.include_links, exportedAt: now });
  const count = publisher.projects ? snapshot.tickets.filter((t) => publisher.projects.includes(t.project_id)).length : r.ticket_count;
  return { summary: `${plural(count, 'ticket')} copied to ${path.basename(publisher.path)}` };
}
