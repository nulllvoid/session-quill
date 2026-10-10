import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sumUsage, collectTurnUsage } from '../../src/hooks/usage.js';
import { effortText } from '../../ui/components.js';
import { newState, ev, createTicket, bind } from './helpers.js';

const line = (id, usage, type = 'assistant') => JSON.stringify({ type, message: { id, usage, content: [{ type: 'text', text: 'secret text never kept' }] } });
const U = (input, output, cache_read = 0, cache_write = 0) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: cache_read, cache_creation_input_tokens: cache_write });

test('usage: a streamed message counts once, by how much it grew', () => {
  const { total, seen } = sumUsage([line('m1', U(2, 10, 100, 50)), line('m1', U(2, 155, 100, 50)), line('m2', U(1, 20)), JSON.stringify({ type: 'user', message: { content: 'hi' } }), 'not json']);
  assert.deepEqual(total, { input: 3, output: 175, cache_read: 100, cache_write: 50, messages: 2 });
  const again = sumUsage([line('m2', U(1, 30))], seen);
  assert.deepEqual(again.total, { input: 0, output: 10, cache_read: 0, cache_write: 0, messages: 0 }, 'only the growth since the last read');
});

test('usage is read incrementally from the transcript, complete lines only, and keeps no text', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'st-effort-'));
  const env = { QUILL_HOME: home };
  const file = path.join(home, 'session.jsonl');
  fs.writeFileSync(file, `${line('a', U(5, 50))}\n${line('b', U(1, 7)).slice(0, 20)}`);
  assert.deepEqual(collectTurnUsage(file, 's1', env), { input: 5, output: 50, cache_read: 0, cache_write: 0, messages: 1 });
  fs.writeFileSync(file, `${line('a', U(5, 50))}\n${line('b', U(1, 7))}\n`);
  assert.deepEqual(collectTurnUsage(file, 's1', env), { input: 1, output: 7, cache_read: 0, cache_write: 0, messages: 1 }, 'the half line is read once complete');
  assert.equal(collectTurnUsage(file, 's1', env), null, 'nothing new');
  const state = fs.readFileSync(path.join(home, 'state', 'usage', 's1.json'), 'utf8');
  assert.doesNotMatch(state, /secret text/);
  assert.equal(collectTurnUsage(path.join(home, 'missing.jsonl'), 's1', env), null);
  assert.equal(collectTurnUsage(path.join(home, 'notes.txt'), 's1', env), null);
});

test('effort: active time sums capped gaps between a bound session\'s events; stop adds a turn and its tokens', () => {
  const state = newState();
  const t = createTicket(state);
  bind(state, 's1', t.id, { at: '2026-10-02T08:00:00Z' });
  ev(state, 'prompt', { length: 5 }, { session_id: 's1', occurred_at: '2026-10-02T08:01:00Z' });
  ev(state, 'pre-tool', { tool_name: 'Read' }, { session_id: 's1', tool_call_id: 'c1', occurred_at: '2026-10-02T08:03:00Z' });
  ev(state, 'pre-tool', { tool_name: 'Read' }, { session_id: 's1', tool_call_id: 'c2', occurred_at: '2026-10-02T09:03:00Z' }); // an hour later: capped at 5 min
  ev(state, 'stop', { complete: false, usage: { input: 10, output: 200, cache_read: 5000, cache_write: 300 } }, { session_id: 's1', occurred_at: '2026-10-02T09:04:00Z' });
  const e = state.tickets.get(t.id).effort;
  assert.equal(e.active_ms, (1 + 2 + 5 + 1) * 60_000);
  assert.equal(e.turns, 1);
  assert.deepEqual(e.tokens, { input: 10, output: 200, cache_read: 5000, cache_write: 300 });
  assert.equal(effortText(e), '9 min active · 1 turn · 6k tokens (200 output)');
  assert.equal(effortText(undefined), null);
  assert.equal(effortText({ active_ms: 7_800_000, turns: 14, tokens: { input: 0, output: 36_000, cache_read: 1_200_000, cache_write: 0 } }), '2 h 10 min active · 14 turns · 1.2M tokens (36k output)');
});

test('effort: an unbound session and a subagent stop credit no turn', () => {
  const state = newState();
  const t = createTicket(state);
  ev(state, 'session-start', { source: 'startup' }, { session_id: 'loose', occurred_at: '2026-10-02T08:00:00Z' });
  ev(state, 'prompt', { length: 1 }, { session_id: 'loose', occurred_at: '2026-10-02T08:02:00Z' });
  bind(state, 's2', t.id, { at: '2026-10-02T08:00:00Z' });
  ev(state, 'subagent-stop', { complete: false }, { session_id: 's2', occurred_at: '2026-10-02T08:00:30Z' });
  assert.equal(state.tickets.get(t.id).effort.turns, 0);
  assert.equal(state.tickets.get(t.id).effort.active_ms, 30_000);
});
