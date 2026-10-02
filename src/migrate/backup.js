// Full backups before migration: notes, hooks/settings, journal and blobs (TRD §Migration and rollout).
import fs from 'node:fs';
import path from 'node:path';
import { nowIso } from '../lib/time.js';

export function backup({ paths, dest, label = 'backup' }) {
  const stamp = nowIso().replace(/[:]/g, '-');
  const dir = path.join(dest, `${stamp}-${label}`);
  fs.mkdirSync(dir, { recursive: true });
  const entries = [];
  paths.forEach((entry, i) => {
    const source = typeof entry === 'string' ? entry : entry.path;
    const role = typeof entry === 'string' ? 'file' : entry.role ?? 'file';
    if (!source || !fs.existsSync(source)) return;
    const stat = fs.statSync(source);
    const target = path.join(dir, `${String(i).padStart(2, '0')}-${path.basename(source)}`);
    fs.cpSync(source, target, { recursive: true, force: true, errorOnExist: false });
    entries.push({ source: path.resolve(source), dest: target, type: stat.isDirectory() ? 'directory' : 'file', role });
  });
  const manifest = path.join(dir, 'manifest.json');
  const record = { schema_version: 1, created_at: nowIso(), label, entries, manifest };
  fs.writeFileSync(manifest, JSON.stringify(record, null, 2));
  return { dir, manifest, entries };
}

export function restoreBackup(manifestPath, { roles = null } = {}) {
  const record = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const restored = [];
  for (const e of record.entries) {
    if (roles && !roles.includes(e.role)) continue;
    if (!fs.existsSync(e.dest)) continue;
    fs.mkdirSync(path.dirname(e.source), { recursive: true });
    fs.cpSync(e.dest, e.source, { recursive: true, force: true });
    restored.push(e);
  }
  return restored;
}
