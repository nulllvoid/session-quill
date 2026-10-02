import path from 'node:path';
import os from 'node:os';
import { uuid } from '../lib/ids.js';
import { nowIso } from '../lib/time.js';
import { machinePath } from '../lib/paths.js';
import { readJsonIfExists, writeJsonAtomic } from '../lib/atomic-fs.js';

export const SCHEMA_VERSION = 1;

export function ensureMachineId(env = process.env) {
  const file = machinePath(env);
  const existing = readJsonIfExists(file);
  if (existing && existing.machine_id) return existing.machine_id;
  const record = { machine_id: uuid(), machine_name: os.hostname(), created_at: nowIso() };
  writeJsonAtomic(file, record);
  return record.machine_id;
}

export function createStoreMeta({ store_name, owner_machine_id, timezone }) {
  const at = nowIso();
  return {
    schema_version: SCHEMA_VERSION,
    store_id: uuid(),
    store_name,
    owner_machine_id,
    timezone,
    created_at: at,
    updated_at: at,
  };
}

export function storeMetaPath(storePath) {
  return path.join(storePath, 'store.json');
}

export function loadStoreMeta(storePath) {
  const meta = readJsonIfExists(storeMetaPath(storePath));
  if (meta && meta.schema_version > SCHEMA_VERSION) {
    const err = new Error(`store schema_version ${meta.schema_version} is newer than supported ${SCHEMA_VERSION}`);
    err.code = 'schema-too-new';
    throw err;
  }
  return meta;
}

export function writeStoreMeta(storePath, meta) {
  writeJsonAtomic(storeMetaPath(storePath), meta);
}

export function storeLayout(storePath) {
  return {
    root: storePath,
    tickets: path.join(storePath, 'tickets'),
    sessions: path.join(storePath, 'sessions'),
    handoffs: path.join(storePath, 'handoffs'),
    authored: path.join(storePath, 'authored'),
  };
}
