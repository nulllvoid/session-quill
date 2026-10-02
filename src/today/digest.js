// The daily digest (ADR 0009): one day of the Today feed as markdown, written into a marked
// section of a daily note (or a file). Text outside the section is never touched, and a section
// edited since Quill last wrote it is never overwritten.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { TrackerError } from '../lib/errors.js';
import { readJsonIfExists, writeJsonAtomic, writeFileAtomic } from '../lib/atomic-fs.js';

export const START = '<!-- quill:digest:start -->';
export const END = '<!-- quill:digest:end -->';
const LABELS = { commit: ['commit', 'commits'], pr: ['PR', 'PRs'], deployment: ['deployment', 'deployments'], status: ['status change', 'status changes'], write: ['file write', 'file writes'], plan: ['plan', 'plans'], conclusion: ['conclusion', 'conclusions'], handoff: ['agent run', 'agent runs'], bind: ['binding', 'bindings'] };
const ORDER = Object.keys(LABELS);

const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
const oneLine = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim();

export function renderDigest(day, { pendingDeployments = [] } = {}) {
  const lines = [`## Session Quill — ${day.date}`, ''];
  if (!day.tickets.length) lines.push('No tracked activity.');
  for (const t of day.tickets) {
    const parts = ORDER.filter((k) => t.counts[k]).map((k) => `${t.counts[k]} ${LABELS[k][t.counts[k] === 1 ? 0 : 1]}`);
    lines.push(`- **${oneLine(t.key)}** ${oneLine(t.title)} — ${parts.join(', ')}`);
  }
  if (day.sessions) lines.push('', `Sessions started: ${day.sessions}`);
  if (pendingDeployments.length) lines.push('', `Awaiting deployment: ${pendingDeployments.map((d) => `${oneLine(d.ticket_key)} (${oneLine(d.environment)})`).join(', ')}`);
  return `${lines.join('\n')}\n`;
}

// Writes `markdown` between the digest markers of `file` (created when missing). `indexPath` keeps
// the hash of each section Quill wrote, so a section someone edited is reported instead of replaced.
export function writeDigestFile({ file, markdown, indexPath }) {
  const index = readJsonIfExists(indexPath) ?? {};
  const section = `${START}\n${markdown.trimEnd()}\n${END}`;
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const start = text.indexOf(START);
  const end = start >= 0 ? text.indexOf(END, start) : -1;
  if (start >= 0 && end >= 0) {
    const current = text.slice(start, end + END.length);
    if (index[file] !== hash(current)) throw new TrackerError('digest-conflict', `the digest section in ${file} was edited after Quill wrote it; clear that section to let Quill write it again`);
    text = text.slice(0, start) + section + text.slice(end + END.length);
  } else if (start >= 0 || text.includes(END)) {
    throw new TrackerError('digest-conflict', `the digest markers in ${file} are incomplete; remove them to let Quill write the section again`);
  } else {
    text = text ? `${text.replace(/\s*$/, '')}\n\n${section}\n` : `${section}\n`;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, text);
  index[file] = hash(section);
  writeJsonAtomic(indexPath, index);
  return { path: file };
}

export function writeDigest({ dir, date, markdown, indexPath }) {
  return writeDigestFile({ file: path.join(dir, `${date}.md`), markdown, indexPath });
}
