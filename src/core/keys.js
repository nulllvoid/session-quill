import { shortId } from '../lib/ids.js';
import { TrackerError } from '../lib/errors.js';

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

export function slugify(title) {
  const slug = String(title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');
  return slug || 'ticket';
}

// Local keys are `<prefix>-<slug>-<short-id>`; children use the parent key plus a serialized
// counter (TRD §Binding and attribution). Keys are display aliases, never identities.
export function allocateKey(state, { prefix = 'LOCAL', title, parent_id = null }) {
  if (parent_id) {
    const parent = state.tickets.get(parent_id);
    if (!parent) throw new TrackerError('parent-invalid', `parent ${parent_id} does not exist`);
    let n = state.counters.childByParent.get(parent_id) ?? 0;
    for (;;) {
      n += 1;
      const key = `${parent.key}.${n}`;
      if (!state.keyIndex.has(key)) return key;
    }
  }
  const slug = slugify(title);
  for (;;) {
    const key = `${prefix}-${slug}-${shortId()}`;
    if (!state.keyIndex.has(key)) return key;
  }
}

export function validateKey(key) {
  if (typeof key !== 'string' || !KEY_RE.test(key) || key.includes('..') || key === '.' ) {
    throw new TrackerError('key-invalid', `invalid ticket key: ${key}`);
  }
  return key;
}

export function safeKeyFileName(key) {
  validateKey(key);
  if (/[\\/]/.test(key) || key.startsWith('.')) throw new TrackerError('key-invalid', `invalid ticket key: ${key}`);
  return key;
}

export function validateParent(state, ticketId, parentId) {
  if (parentId === null || parentId === undefined) return;
  if (parentId === ticketId) throw new TrackerError('parent-invalid', 'a ticket cannot be its own parent');
  const parent = state.tickets.get(parentId);
  if (!parent) throw new TrackerError('parent-invalid', `parent ${parentId} does not exist in this store`);
  if (parent.store_id !== state.meta.store_id) throw new TrackerError('parent-invalid', 'cross-store parent links are invalid');
  let cursor = parent;
  const seen = new Set([ticketId]);
  while (cursor) {
    if (seen.has(cursor.id)) throw new TrackerError('parent-invalid', 'parent link would create a cycle');
    seen.add(cursor.id);
    cursor = cursor.parent_id ? state.tickets.get(cursor.parent_id) : null;
  }
}
