// Writes generated markdown between `<!-- quill:<marker>:start -->` and `<!-- quill:<marker>:end -->`
// in a file the owner may also edit (ADR 0009). Text outside the markers is never touched, line
// endings are kept, and a section edited since Quill last wrote it is reported instead of replaced.
// Emptying the section (or deleting the markers) lets Quill write it again.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { TrackerError } from './errors.js';
import { readJsonIfExists, writeJsonAtomic, writeFileAtomic } from './atomic-fs.js';

const hash = (s) => crypto.createHash('sha256').update(s.replace(/\r\n/g, '\n')).digest('hex');

export function markers(marker) {
  return { start: `<!-- quill:${marker}:start -->`, end: `<!-- quill:${marker}:end -->` };
}

// Generated text never contains an HTML comment opener, so it cannot fake or close a marker.
export function inertMarkdown(text) {
  return String(text).replace(/<!--/g, '&lt;!--');
}

function indexKey(file, marker) {
  const abs = path.resolve(file);
  return `${process.platform === 'win32' ? abs.toLowerCase() : abs}#${marker}`;
}

export function writeMarkedSection({ file, marker, markdown, indexPath, conflictCode = 'section-conflict' }) {
  const { start: START, end: END } = markers(marker);
  const key = indexKey(file, marker);
  const index = readJsonIfExists(indexPath) ?? {};
  const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const crlf = original.includes('\r\n');
  const text = original.replace(/\r\n/g, '\n');
  const section = `${START}\n${inertMarkdown(markdown).trimEnd()}\n${END}`;
  const start = text.indexOf(START);
  const end = start >= 0 ? text.indexOf(END, start + START.length) : -1;
  let next;
  if (start >= 0 && end >= 0) {
    const current = text.slice(start, end + END.length);
    const inner = text.slice(start + START.length, end);
    const h = hash(current);
    const ours = index[key] === h || index[`${key}:pending`] === h || current === section || !inner.trim();
    if (!ours) throw new TrackerError(conflictCode, `the generated section in ${path.basename(file)} was edited after Quill wrote it; delete what is between the markers to let Quill write it again`);
    next = text.slice(0, start) + section + text.slice(end + END.length);
  } else if (start >= 0 || text.includes(END)) {
    throw new TrackerError(conflictCode, `the generated section markers in ${path.basename(file)} are incomplete; remove them to let Quill write the section again`);
  } else {
    next = text ? `${text.replace(/\n*$/, '')}\n\n${section}\n` : `${section}\n`;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // The new hash is recorded as pending before the file is written and committed after, so a crash
  // between the two writes leaves either section recognised as Quill's own.
  index[`${key}:pending`] = hash(section);
  writeJsonAtomic(indexPath, index);
  writeFileAtomic(file, crlf ? next.replace(/\n/g, '\r\n') : next);
  index[key] = index[`${key}:pending`];
  delete index[`${key}:pending`];
  writeJsonAtomic(indexPath, index);
  return { path: file };
}
