import fs from 'node:fs';
import path from 'node:path';
import { ingressDir } from '../lib/paths.js';
import { ensureDir, tempPathFor, renameAtomic, isTempFile, listFiles, removeIfExists } from '../lib/atomic-fs.js';
import { TrackerError } from '../lib/errors.js';
import { validateEvent } from './events.js';

// Producers (hooks, CLI) persist one complete file per event. Only complete `<event_id>.json`
// files are eligible for ingestion; temp files are never read (TRD §Durability 1).
export function writeIngress(ev, env = process.env, { timeoutMs = 1000, clock = Date.now } = {}) {
  validateEvent(ev);
  const started = clock();
  const dir = ingressDir(env);
  const dest = path.join(dir, `${ev.event_id}.json`);
  try {
    ensureDir(dir);
    const tmp = tempPathFor(dest);
    const fd = fs.openSync(tmp, 'wx');
    try {
      fs.writeSync(fd, JSON.stringify(ev));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    renameAtomic(tmp, dest);
  } catch (err) {
    throw new TrackerError('ingress-failed', `could not persist event ${ev.event_id}: ${err.message}`, { cause: err });
  }
  const elapsed = clock() - started;
  if (elapsed > timeoutMs) {
    // Persistence succeeded but blew the budget; callers surface this as a health warning.
    return { event_id: ev.event_id, path: dest, slow: true, elapsed };
  }
  return { event_id: ev.event_id, path: dest, slow: false, elapsed };
}

export function listIngress(env = process.env) {
  const dir = ingressDir(env);
  const out = [];
  for (const name of listFiles(dir, (f) => f.endsWith('.json') && !isTempFile(f))) {
    const file = path.join(dir, name);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      out.push({ file, name, error: 'unreadable', event: null });
      continue;
    }
    try {
      const event = JSON.parse(text);
      out.push({ file, name, event, error: null });
    } catch {
      out.push({ file, name, event: null, error: 'malformed' });
    }
  }
  out.sort((a, b) => {
    const ta = a.event ? a.event.occurred_at : '';
    const tb = b.event ? b.event.occurred_at : '';
    if (ta !== tb) return ta < tb ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return out;
}

export function removeIngress(eventIdOrName, env = process.env) {
  const name = eventIdOrName.endsWith('.json') ? eventIdOrName : `${eventIdOrName}.json`;
  return removeIfExists(path.join(ingressDir(env), name));
}

export function quarantineIngress(name, env = process.env) {
  const dir = ingressDir(env);
  const qdir = path.join(dir, 'quarantine');
  ensureDir(qdir);
  try {
    renameAtomic(path.join(dir, name), path.join(qdir, name));
  } catch { /* best effort */ }
}

export function countIngress(env = process.env) {
  return listFiles(ingressDir(env), (f) => f.endsWith('.json') && !isTempFile(f)).length;
}
