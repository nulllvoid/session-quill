import { randomUUID, randomBytes, createHash } from 'node:crypto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function uuid() {
  return randomUUID();
}

export function shortId() {
  return randomBytes(4).toString('hex');
}

export function contentHash(data) {
  return createHash('sha256').update(data).digest('hex');
}

// Deterministic UUID-shaped id from a seed, so replaying the same journal yields identical
// generated ids (timeline entries, sessions, plans) and redelivery is naturally idempotent.
export function deterministicId(seed) {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}
