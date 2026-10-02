import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function tempPathFor(dest) {
  return path.join(path.dirname(dest), `.${path.basename(dest)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
}

export function isTempFile(name) {
  return name.startsWith('.') && name.endsWith('.tmp');
}

export function renameAtomic(from, to, { rename = fs.renameSync, delayMs = 25, maxAttempts = 20 } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      rename(from, to);
      return;
    } catch (err) {
      attempt += 1;
      if (!RETRY_CODES.has(err.code) || attempt >= maxAttempts) {
        try { fs.unlinkSync(from); } catch { /* best effort */ }
        throw err;
      }
      sleepSync(delayMs);
    }
  }
}

export function writeFileAtomic(dest, data) {
  ensureDir(path.dirname(dest));
  const tmp = tempPathFor(dest);
  const fd = fs.openSync(tmp, 'wx');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } catch (err) {
    fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
  fs.closeSync(fd);
  renameAtomic(tmp, dest);
}

export function writeJsonAtomic(dest, obj) {
  writeFileAtomic(dest, JSON.stringify(obj, null, 2) + '\n');
}

export function readJsonIfExists(file) {
  const text = readTextIfExists(file);
  return text === null ? null : JSON.parse(text);
}

export function readTextIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export function listFiles(dir, filter = () => true) {
  try {
    return fs.readdirSync(dir).filter(filter).sort();
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

export function removeIfExists(file) {
  try {
    fs.unlinkSync(file);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}
