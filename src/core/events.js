import { uuid, isUuid } from '../lib/ids.js';
import { isIsoZ, nowIso } from '../lib/time.js';
import { TrackerError } from '../lib/errors.js';

export const SCHEMA_VERSION = 1;

export const EVENT_KINDS = [
  'session-start', 'prompt', 'pre-tool', 'post-tool', 'tool-failure', 'stop', 'pre-compact',
  'subagent-start', 'subagent-stop', 'session-end',
  'bind', 'gate-off', 'gate-on', 'ticket-create', 'ticket-update', 'relink', 'approve', 'dismiss',
  'request', 'request-tx', 'handoff-tx', 'migration', 'import', 'notify', 'reconcile',
];

const KIND_SET = new Set(EVENT_KINDS);

export function makeEvent({
  kind, payload = {}, store_id, machine_id, producer = 'cli', session_id = null, agent_id = null,
  tool_call_id = null, ticket_id = null, binding_revision = null, source_identity, occurred_at,
}) {
  const event_id = uuid();
  return {
    schema_version: SCHEMA_VERSION,
    event_id,
    store_id,
    machine_id,
    producer,
    occurred_at: occurred_at ?? nowIso(),
    ingested_at: null,
    sequence: null,
    session_id,
    agent_id,
    tool_call_id,
    ticket_id,
    binding_revision,
    kind,
    payload,
    source_identity: source_identity ?? `${kind}:${event_id}`,
  };
}

function invalid(msg) {
  return new TrackerError('event-invalid', msg);
}

export function validateEvent(ev) {
  if (!ev || typeof ev !== 'object') throw invalid('event is not an object');
  if (ev.schema_version !== SCHEMA_VERSION) throw invalid(`unsupported event schema_version ${ev.schema_version}`);
  if (!isUuid(ev.event_id)) throw invalid('event_id must be a UUID');
  if (!KIND_SET.has(ev.kind)) throw invalid(`unknown event kind ${ev.kind}`);
  if (!isIsoZ(ev.occurred_at)) throw invalid(`occurred_at must be RFC 3339 UTC with Z: ${ev.occurred_at}`);
  if (typeof ev.store_id !== 'string' || !ev.store_id) throw invalid('store_id required');
  if (typeof ev.machine_id !== 'string' || !ev.machine_id) throw invalid('machine_id required');
  if (typeof ev.source_identity !== 'string' || !ev.source_identity) throw invalid('source_identity required');
  if (ev.payload === null || typeof ev.payload !== 'object' || Array.isArray(ev.payload)) throw invalid('payload must be an object');
  if (ev.sequence !== null && !(Number.isInteger(ev.sequence) && ev.sequence > 0)) throw invalid('sequence must be null or a positive integer');
  return ev;
}
