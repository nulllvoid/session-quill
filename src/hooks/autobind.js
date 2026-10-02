// Decides whether a prompt or branch should change this session's binding (ADR 0005).
import { findKeys } from '../core/external-keys.js';

export function planAutoBind({ source, text, snapshot, tracker }) {
  if (!tracker || !tracker.sources.includes(source)) return null;
  const keys = findKeys(text, tracker, { uppercase: source === 'branch' && tracker.prefixes.length > 0 });
  if (!keys.length) return null;
  const bound = snapshot && snapshot.ticket_id ? [snapshot.ticket_key, ...(snapshot.ticket_aliases ?? [])] : [];
  if (bound.some((k) => keys.includes(k))) return null;
  if (!bound.length) return { key: keys[0], ensure_only: false };
  if (source === 'branch') return null;
  if (tracker.on_new_key === 'switch') return { key: keys[0], ensure_only: false };
  if (tracker.on_new_key === 'add') return { key: keys[0], ensure_only: true };
  return null;
}
