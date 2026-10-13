// The tool inventory a run's system/init event reports (spec §5.4, ruling R6), the runtime
// version gate for autonomous runs (spec §3) and the summary the Run dialog reads (spec §8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseInit, latestInventory, assertRuntime, parseVersion, MIN_RUNTIME, mcpServerSources, writeMcpServers, MCP_SERVERS_FILE, autonomyInfo } from '../../src/handoff/inventory.js';

// The init event of the stream fixture (Task 3, tests/handoff/stream.test.js), extended with the
// other fields claude 2.1.296 reports (research 03 §C).
const INIT = '{"type":"system","subtype":"init","session_id":"s1","tools":["Bash"],"mcp_servers":[{"name":"claude_ai_Atlassian","status":"connected","source":"claudeai"}]}';
const FULL_INIT = {
  type: 'system', subtype: 'init', session_id: 's2', claude_code_version: '2.1.296', model: 'claude-x',
  tools: ['Bash', 'Read', 'mcp__claude_ai_Atlassian__getJiraIssue', 7, ''],
  mcp_servers: [
    { name: 'claude_ai_Atlassian', status: 'connected', source: 'claudeai' },
    { name: 'claude.ai Gmail', status: 'needs-auth', source: 'claudeai' },
    { name: 'repo-db', status: 'connected', source: 'project' },
    { name: 'mine', status: 'failed' },
    'junk', null,
  ],
  plugins: [{ name: 'session-quill', path: 'C:/Users/me/.claude/plugins/x' }, 'loose-name', { path: '/no/name' }],
  skills: ['start', { name: 'doctor' }, 3],
};

test('parseInit reads the Task 3 init fixture', () => {
  const inv = parseInit(JSON.parse(INIT));
  assert.deepEqual(inv, { tools: ['Bash'], mcpServers: [{ name: 'claude_ai_Atlassian', status: 'connected', source: 'claudeai' }], plugins: [], skills: [], version: null });
});

test('parseInit keeps names, statuses and sources only: plugin paths are dropped, junk is skipped', () => {
  const inv = parseInit(FULL_INIT);
  assert.deepEqual(inv.tools, ['Bash', 'Read', 'mcp__claude_ai_Atlassian__getJiraIssue']);
  assert.deepEqual(inv.mcpServers, [
    { name: 'claude_ai_Atlassian', status: 'connected', source: 'claudeai' },
    { name: 'claude.ai Gmail', status: 'needs-auth', source: 'claudeai' },
    { name: 'repo-db', status: 'connected', source: 'project' },
    { name: 'mine', status: 'failed', source: null },
  ]);
  assert.deepEqual(inv.plugins, ['session-quill', 'loose-name']);
  assert.deepEqual(inv.skills, ['start', 'doctor']);
  assert.equal(inv.version, '2.1.296');
  assert.equal(JSON.stringify(inv).includes('C:/Users'), false, 'no local plugin path is kept');
});

test('parseInit caps every list and every string, and survives a non-object', () => {
  const big = parseInit({ tools: Array.from({ length: 2000 }, (_, i) => `t${i}`), mcp_servers: Array.from({ length: 500 }, (_, i) => ({ name: `s${i}${'x'.repeat(500)}`, status: 'connected', source: 'user' })) });
  assert.ok(big.tools.length <= 500);
  assert.ok(big.mcpServers.length <= 200);
  assert.ok(big.mcpServers.every((s) => s.name.length <= 200));
  assert.deepEqual(parseInit(null), { tools: [], mcpServers: [], plugins: [], skills: [], version: null });
  assert.deepEqual(parseInit({ tools: 'Bash', claude_code_version: 42 }).version, null);
});

test('latestInventory picks the most recently recorded inventory from state or a snapshot', () => {
  const a = { id: 'a', requested_at: '2026-10-01T00:00:00Z', inventory: { ...parseInit(JSON.parse(INIT)), at: '2026-10-01T00:01:00Z' } };
  const b = { id: 'b', requested_at: '2026-10-02T00:00:00Z', inventory: { ...parseInit(FULL_INIT), at: '2026-10-02T00:01:00Z' } };
  const c = { id: 'c', requested_at: '2026-10-03T00:00:00Z' };
  assert.equal(latestInventory({ handoffs: new Map([['a', a], ['b', b], ['c', c]]) }).run_id, 'b');
  assert.equal(latestInventory({ handoffs: [b, a, c] }).version, '2.1.296');
  assert.equal(latestInventory({ handoffs: [c] }), null);
  assert.equal(latestInventory({}), null);
});

test('assertRuntime refuses below 2.1.295 and anything it cannot read, with runtime-too-old', () => {
  assert.equal(MIN_RUNTIME, '2.1.295');
  assert.deepEqual(parseVersion('2.1.296 (Claude Code)'), [2, 1, 296]);
  assert.equal(assertRuntime('2.1.296 (Claude Code)'), '2.1.296');
  assert.equal(assertRuntime('2.1.295'), '2.1.295');
  assert.equal(assertRuntime('3.0.0'), '3.0.0');
  for (const v of ['2.1.200', '2.0.999', '1.9.400', null, '', 'claude', undefined]) {
    assert.throws(() => assertRuntime(v), (e) => e.code === 'runtime-too-old' && /standard/.test(e.message), String(v));
  }
  assert.throws(() => assertRuntime('2.1.300', '2.2.0'), (e) => e.code === 'runtime-too-old');
});

test('mcpServerSources maps server names to sources; writeMcpServers writes it for the guard', () => {
  assert.deepEqual(mcpServerSources(FULL_INIT), { claude_ai_Atlassian: 'claudeai', 'claude.ai Gmail': 'claudeai', 'repo-db': 'project' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-inv-'));
  try {
    const file = writeMcpServers(dir, FULL_INIT);
    assert.equal(file, path.join(dir, MCP_SERVERS_FILE));
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { claude_ai_Atlassian: 'claudeai', 'claude.ai Gmail': 'claudeai', 'repo-db': 'project' });
    writeMcpServers(dir, { mcp_servers: [] });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {}, 'a later init replaces it');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('autonomyInfo: latest inventory, latest autonomous credential report, configured read-only profiles', () => {
  const report = { kubernetes: 'readonly', aws: 'stub', residual: ['ssh: keys'], scope_errors: [] };
  const state = { handoffs: new Map([
    ['a', { id: 'a', access: 'autonomous', requested_at: '2026-10-01T00:00:00Z', started_at: '2026-10-01T00:00:10Z', cred_report: { kubernetes: 'stub' } }],
    ['b', { id: 'b', access: 'autonomous', requested_at: '2026-10-02T00:00:00Z', started_at: '2026-10-02T00:00:10Z', cred_report: report, inventory: { ...parseInit(FULL_INIT), at: '2026-10-02T00:00:11Z' } }],
    ['c', { id: 'c', access: 'standard', requested_at: '2026-10-03T00:00:00Z', started_at: '2026-10-03T00:00:10Z' }],
  ]) };
  const info = autonomyInfo(state, { prod: { readonly: { kubeconfig: path.resolve('/ro/kube'), db_env: { DATABASE_URL: 'env:RO_DSN' } } }, handoff: { trusted_mcp_servers: ['repo-db'] } });
  assert.equal(info.inventory.run_id, 'b');
  assert.deepEqual(info.credentials, { report, run_id: 'b', at: '2026-10-02T00:00:10Z' });
  assert.deepEqual(info.readonly_configured, ['kubernetes', 'databases']);
  assert.deepEqual(info.trusted_mcp_servers, ['repo-db']);
  assert.equal(info.min_runtime, '2.1.295');
  const empty = autonomyInfo({ handoffs: new Map() }, {});
  assert.deepEqual([empty.inventory, empty.credentials, empty.readonly_configured], [null, null, []]);
  assert.equal(JSON.stringify(info).includes('/ro/kube'), false, 'no configured path reaches the snapshot');
});
