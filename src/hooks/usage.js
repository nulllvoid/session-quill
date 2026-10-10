// Token usage per turn, read at Stop from the host's transcript: only the bytes appended since the
// last read, only the numeric `usage` of assistant messages. No message text is kept.
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from '../lib/paths.js';
import { readJsonIfExists, writeJsonAtomic } from '../lib/atomic-fs.js';
import { snapshotFileName } from './binding-snapshot.js';

const MAX_READ = 8 * 1024 * 1024;
const SEEN_KEEP = 50;
const FIELDS = [['input', 'input_tokens'], ['output', 'output_tokens'], ['cache_read', 'cache_read_input_tokens'], ['cache_write', 'cache_creation_input_tokens']];

const statePath = (key, env) => path.join(stateDir(env), 'usage', snapshotFileName(key));

// A streamed message repeats its id on several lines with growing counts; each id adds only what
// it has grown by since it was last counted, including across reads.
export function sumUsage(lines, seen = {}) {
  const total = { input: 0, output: 0, cache_read: 0, cache_write: 0, messages: 0 };
  for (const line of lines) {
    if (!line || !line.includes('"usage"')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const m = e && e.type === 'assistant' && e.message;
    if (!m || !m.usage || typeof m.id !== 'string') continue;
    const before = seen[m.id];
    const now = {};
    for (const [k, f] of FIELDS) now[k] = Math.max(Number.isFinite(m.usage[f]) ? m.usage[f] : 0, before ? before[k] : 0);
    for (const [k] of FIELDS) total[k] += now[k] - (before ? before[k] : 0);
    if (!before) total.messages += 1;
    delete seen[m.id];
    seen[m.id] = now; // re-insert so the newest ids are kept
  }
  const ids = Object.keys(seen);
  for (const id of ids.slice(0, Math.max(0, ids.length - SEEN_KEEP))) delete seen[id];
  return { total, seen };
}

export function collectTurnUsage(transcriptPath, sessionKey, env) {
  if (typeof transcriptPath !== 'string' || !/\.jsonl$/i.test(transcriptPath)) return null;
  let fd;
  try { fd = fs.openSync(transcriptPath, 'r'); } catch { return null; }
  try {
    const size = fs.fstatSync(fd).size;
    const prev = readJsonIfExists(statePath(sessionKey, env));
    const same = prev && prev.path === transcriptPath && prev.offset <= size;
    let offset = same ? prev.offset : 0;
    // A transcript met for the first time mid-session: count from now on, not the whole history.
    if (!same && size > MAX_READ) offset = size;
    const length = Math.min(size - offset, MAX_READ);
    const buf = Buffer.alloc(length);
    if (length) fs.readSync(fd, buf, 0, length, offset);
    const text = buf.toString('utf8');
    const end = text.lastIndexOf('\n') + 1; // only complete lines; the rest is read next time
    const { total, seen } = sumUsage(text.slice(0, end).split('\n'), same ? { ...(prev.seen ?? {}) } : {});
    writeJsonAtomic(statePath(sessionKey, env), { path: transcriptPath, offset: offset + Buffer.byteLength(text.slice(0, end)), seen });
    return total.messages || total.output || total.input ? total : null;
  } finally {
    fs.closeSync(fd);
  }
}
