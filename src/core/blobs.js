import fs from 'node:fs';
import path from 'node:path';
import { blobsDir } from '../lib/paths.js';
import { contentHash } from '../lib/ids.js';
import { writeFileAtomic, readTextIfExists } from '../lib/atomic-fs.js';

// Full checkpoint and plan text is stored by content hash. Events reference blobs that must
// already be persisted (TRD §Durability 1, §Capture and approval).
export function putBlob(text, env = process.env) {
  const hash = contentHash(text);
  const file = path.join(blobsDir(env), hash);
  if (!fs.existsSync(file)) writeFileAtomic(file, text);
  return { hash, path: file, length: text.length };
}

export function getBlob(hash, env = process.env) {
  if (!/^[0-9a-f]{64}$/.test(hash)) return null;
  return readTextIfExists(path.join(blobsDir(env), hash));
}

export function hasBlob(hash, env = process.env) {
  return /^[0-9a-f]{64}$/.test(hash) && fs.existsSync(path.join(blobsDir(env), hash));
}
