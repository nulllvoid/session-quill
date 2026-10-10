import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { usageStats, usageItems, readJournalTail } from '../../src/core/usage.js';
import { listIngress } from '../../src/core/ingress.js';
import { writeRuntimeIdentity, writeBindingSnapshot } from '../../src/hooks/binding-snapshot.js';

const NOW = '2026-10-11T12:00:00Z';
const tool = (kind, ms, at = '2026-10-10T12:00:00Z') => ({ kind, occurred_at: at, payload: { hook_ms: ms } });

test('usage stats: hook percentiles, gaps and ticket coverage within the window only', () => {
  const events = [
    ...[90, 95, 100, 105, 300].map((ms) => tool('pre-tool', ms)),
    tool('post-tool', 98),
    tool('pre-tool', 5000, '2026-09-01T00:00:00Z'), // outside the 7-day window
    { kind: 'pre-tool', occurred_at: '2026-10-10T12:00:00Z', payload: {} }, // before 0.6.1: no measurement
  ];
  const healthErrors = [{ kind: 'capture-gap', at: '2026-10-09T00:00:00Z' }, { kind: 'capture-gap', at: '2026-09-01T00:00:00Z' }, { kind: 'slow-capture', at: '2026-10-10T00:00:00Z' }];
  const sessions = [
    { last_event_at: '2026-10-10T00:00:00Z', ticket_ids: ['t1'] },
    { last_event_at: '2026-10-10T00:00:00Z', ticket_ids: [], unbound_work: { files: [{}], commits: [] } },
    { last_event_at: '2026-10-10T00:00:00Z', ticket_ids: ['t1'], agent_id: 'sub' },
    { last_event_at: '2026-08-01T00:00:00Z', ticket_ids: [] },
  ];
  const s = usageStats({ events, healthErrors, sessions, nowIso: NOW });
  assert.deepEqual(s, { days: 7, tool_calls: 6, hook_samples: 6, hook_p50_ms: 100, hook_p95_ms: 300, capture_gaps: 1, slow_captures: 1, sessions: 2, sessions_bound: 1, sessions_with_unlinked_work: 1 });
  const items = usageItems(s);
  assert.equal(items.find((i) => i.label === 'hook latency').level, 'warn', 'p95 over the 200 ms budget');
  assert.match(items.find((i) => i.label === 'ticket coverage').detail, /1\/2 sessions linked to a ticket; 1 \(50%\) left unlinked work/);
});

test('the journal tail is bounded and skips a record cut at the boundary', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'st-usage-')), 'events.jsonl');
  const lines = Array.from({ length: 200 }, (_, i) => JSON.stringify({ kind: 'pre-tool', sequence: i, pad: 'x'.repeat(100) }));
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const tail = readJournalTail(file, { maxBytes: 2000 });
  assert.ok(tail.length > 5 && tail.length < 20, `${tail.length} events`);
  assert.equal(tail[tail.length - 1].sequence, 199);
  assert.equal(readJournalTail(path.join(path.dirname(file), 'missing.jsonl')).length, 0);
});

test('the hook process records its own duration on tool events', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'st-usage-hook-'));
  const env = { QUILL_HOME: home };
  writeRuntimeIdentity({ store_id: '33333333-3333-4333-8333-333333333333', machine_id: '22222222-2222-4222-8222-222222222222', store_path: path.join(home, 'Quill'), gate_enabled: true, gate_mode: 'nudge', approval_phrases_enabled: false, allow_tools: [] }, env);
  writeBindingSnapshot('s1', { ticket_id: '00000001-0000-4000-8000-000000000000', ticket_key: 'DEV-1', binding_revision: 1, gate_enabled: true }, env);
  const bin = fileURLToPath(new URL('../../bin/quill-hook.js', import.meta.url));
  const input = JSON.stringify({ session_id: 's1', tool_name: 'Read', tool_input: { file_path: 'a' }, tool_use_id: 't1' });
  const r = spawnSync(process.execPath, [bin, 'PreToolUse'], { input, env: { ...process.env, ...env }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const [ev] = listIngress(env).map((x) => x.event);
  assert.equal(ev.kind, 'pre-tool');
  assert.ok(Number.isInteger(ev.payload.hook_ms) && ev.payload.hook_ms > 0 && ev.payload.hook_ms < 5000, `hook_ms ${ev.payload.hook_ms}`);
});
