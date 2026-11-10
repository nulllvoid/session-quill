import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHub } from '../../src/hub/server.js';
import { addToken } from '../../src/hub/store.js';
import { sanitizeSnapshot } from '../../src/export/sanitize.js';

export const NOW = '2026-11-10T12:00:00Z';

export function ticket(n, extra = {}) {
  return {
    schema_version: 1, id: `0000000${n}-0000-4000-8000-000000000000`, revision: 1, created_at: NOW, updated_at: NOW, key: `PROJ-${n}`, title: `Ticket ${n}`,
    project_id: 'demo', project_name: 'Demo', status: 'active', category: 'feature', priority: 'P2', parent_id: null, next_action: `Do step ${n}`, blocker: null, due: null,
    last_activity: NOW, stale: false, prs: [], deployments: [], children_ids: [], session_ids: [], handoff_ids: [], jira: null, external: null, status_source: 'manual', ...extra,
  };
}

export function rawSnapshot({ tickets = [ticket(1), ticket(2, { status: 'done' })], extra = {} } = {}) {
  return {
    schema_version: 1, generation_id: 'gen-00000007', generated_at: NOW, capabilities: { read: true, edit_tickets: true, handoff: true, refresh: true, cancel_requests: true, export: true },
    tickets, sessions: [], checkpoints: [], handoffs: [], requests: [{ id: 'r1' }], picknext: [], blocked: [], deployments_outstanding: [],
    meta: { store_id: 's', store_name: 'Quill', owner_machine_id: 'machine-1', timezone: 'UTC', last_sync: NOW }, repos: [], unresolved: [{ id: 'u1' }], ...extra,
  };
}

// As it arrives on the wire: through JSON, so no undefined values.
export const sanitized = (opts = {}, exportOpts = {}) => JSON.parse(JSON.stringify(sanitizeSnapshot(rawSnapshot(opts), { exportedAt: NOW, ...exportOpts })));

export async function startHub(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quill-hub-'));
  let ms = Date.parse(NOW);
  const logs = [];
  const hub = createHub({ dir, name: 'Test team', clock: () => ms, log: (m) => logs.push(m), ...options });
  const address = await hub.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  const member = addToken(dir, { name: 'alice', role: 'member', now: NOW });
  const viewer = addToken(dir, { name: 'vera', role: 'viewer', now: NOW });
  return {
    dir, hub, base, member, viewer, logs,
    advance: (by) => { ms += by; },
    close: () => hub.close(),
    put: (token, body, headers = {}) => fetch(`${base}/v1/snapshot`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }),
    async signIn(token) {
      const res = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: base }, body: new URLSearchParams({ token }) });
      const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
      return { res, cookie };
    },
  };
}
