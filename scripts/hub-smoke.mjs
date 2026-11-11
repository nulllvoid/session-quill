#!/usr/bin/env node
// Smoke test for a running team hub (ADR 0044): health, a push, sign-in, the overview, the board.
//   node scripts/hub-smoke.mjs --url http://127.0.0.1:47400 --token qh_m_…
// CI runs it against the Docker image; it works against any hub you can reach. It pushes one
// two-ticket board under the token's name with store id "smoke-store" and removes it again.
import { sanitizeSnapshot } from '../src/export/sanitize.js';

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? null : process.argv[i + 1]; };
const base = (arg('url') ?? 'http://127.0.0.1:47400').replace(/\/+$/, '');
const token = arg('token') ?? process.env.QUILL_HUB_TOKEN;
if (!token) { console.error('usage: hub-smoke.mjs --url <hub> --token <member token>'); process.exit(2); }

const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const ticket = (n, status) => ({ schema_version: 1, id: `smoke-${n}`, revision: 1, created_at: now, updated_at: now, key: `SMOKE-${n}`, title: `Smoke ticket ${n}`, project_id: 'smoke', project_name: 'Smoke', status, priority: 'P2', next_action: 'Nothing: this is a smoke test', blocker: null, last_activity: now, stale: false, prs: [], deployments: [], children_ids: [], session_ids: [], handoff_ids: [] });
const snapshot = sanitizeSnapshot({ schema_version: 1, generation_id: 'gen-smoke', generated_at: now, tickets: [ticket(1, 'active'), ticket(2, 'done')], sessions: [], checkpoints: [], handoffs: [], requests: [], picknext: [], blocked: [], deployments_outstanding: [], meta: { store_name: 'Smoke', timezone: 'UTC' }, repos: [], unresolved: [] }, { exportedAt: now });

const steps = [];
const check = (name, ok, detail = '') => { steps.push({ name, ok }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };
const auth = { Authorization: `Bearer ${token}` };

try {
  const health = await (await fetch(`${base}/healthz`)).json();
  check('healthz', health.ok === true && health.service === 'quill-hub', JSON.stringify(health));

  const push = await fetch(`${base}/v1/snapshot`, { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ schema_version: 1, store_id: 'smoke-store', machine_name: 'smoke', snapshot }) });
  const pushed = await push.json();
  check('push accepted', push.status === 200 && pushed.ticket_count === 2, `${push.status} ${JSON.stringify(pushed).slice(0, 160)}`);

  const raw = await fetch(`${base}/v1/snapshot`, { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ store_id: 'smoke-store', snapshot: { tickets: [] } }) });
  check('unsanitized push refused', raw.status === 422, String(raw.status));

  const team = await (await fetch(`${base}/v1/team`, { headers: auth })).json();
  const mine = (team.boards ?? []).find((b) => b.store_id === 'smoke-store');
  check('team overview lists the board', !!mine && mine.ticket_count === 2 && team.open.some((t) => t.key === 'SMOKE-1'));

  const login = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: base }, body: new URLSearchParams({ token }) });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  check('browser sign-in', login.status === 303 && cookie.startsWith('quill_hub='), String(login.status));

  const overview = await fetch(`${base}/`, { headers: { Cookie: cookie } });
  const html = await overview.text();
  check('overview page', overview.status === 200 && html.includes('SMOKE-1') && !/<script/i.test(html));

  const frame = await fetch(`${base}/b/${mine ? mine.member : 'x'}/smoke-store/frame`, { headers: { Cookie: cookie } });
  const board = await frame.text();
  check('board renders from the image\'s own dashboard', frame.status === 200 && board.includes('window.__SNAPSHOT__') && /script-src 'sha256-/.test(frame.headers.get('content-security-policy') ?? ''));

  const anon = await fetch(`${base}/`, { redirect: 'manual' });
  check('pages need a session', anon.status === 303);

  const del = await fetch(`${base}/v1/snapshot/smoke-store`, { method: 'DELETE', headers: auth });
  check('board removed', del.status === 200);
} catch (err) {
  check('hub reachable', false, err.message);
}
const failed = steps.filter((s) => !s.ok).length;
console.log(failed ? `${failed} of ${steps.length} checks failed` : `all ${steps.length} checks passed`);
process.exit(failed ? 1 : 0);
