import fs from 'node:fs';
import { healthErrorsPath } from '../lib/paths.js';
import { listIngress } from '../core/ingress.js';

export function readHealthErrors(env, { limit = 50 } = {}) {
  let text;
  try { text = fs.readFileSync(healthErrorsPath(env), 'utf8'); } catch { return []; }
  const lines = text.split('\n').filter(Boolean);
  return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return { kind: 'malformed', raw: l }; } });
}

export function captureHealth(env, { now, journalInfo = {}, backlog = null }) {
  const errors = readHealthErrors(env, { limit: 20 });
  const pending = backlog ?? listIngress(env);
  const oldest = pending.length ? pending.reduce((min, p) => (p.event && (!min || p.event.occurred_at < min) ? p.event.occurred_at : min), null) : null;
  let status = 'ok';
  let reason = null;
  if (journalInfo.corrupt) { status = 'error'; reason = 'journal corruption: recovery required'; }
  else if (errors.some((e) => e.kind === 'capture-gap')) { status = 'degraded'; reason = `capture gaps recorded (${errors.filter((e) => e.kind === 'capture-gap').length} recent)`; }
  else if (journalInfo.quarantined) { status = 'degraded'; reason = 'torn journal tail quarantined on last start'; }
  else if (pending.length > 100) { status = 'degraded'; reason = `${pending.length} events pending ingestion`; }
  return { health: { status, reason, observed_at: now }, oldest_pending_event_at: oldest, backlog: pending.length, errors };
}
