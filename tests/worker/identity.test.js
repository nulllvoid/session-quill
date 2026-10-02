import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Worker } from '../../src/worker/worker.js';
import { makeEvent } from '../../src/core/events.js';
import { writeIngress } from '../../src/core/ingress.js';
import { createStoreMeta, writeStoreMeta } from '../../src/config/store.js';
import { defaultUserConfig, saveUserConfig } from '../../src/config/config.js';
import { readRuntimeIdentity, readBindingSnapshot, writeBindingSnapshot } from '../../src/hooks/binding-snapshot.js';
import { externalTicketId } from '../../src/core/external-keys.js';

const MACHINE = '22222222-2222-4222-8222-222222222222';

function fixture({ repoToml = null, gate = null, tracker = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'st-ident-'));
  const storePath = path.join(home, 'Quill');
  fs.mkdirSync(storePath, { recursive: true });
  const meta = createStoreMeta({ store_name: 'Quill', owner_machine_id: MACHINE, timezone: 'UTC' });
  writeStoreMeta(storePath, meta);
  fs.writeFileSync(path.join(home, 'machine.json'), JSON.stringify({ machine_id: MACHINE, machine_name: 'test' }));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'st-identrepo-'));
  if (repoToml !== null) fs.writeFileSync(path.join(repo, '.quill.toml'), repoToml);
  const config = { ...defaultUserConfig(), store_path: storePath, default_project: 'demo', projects: { demo: { name: 'Demo', repo_id: 'demo' } }, repos: { demo: { project_id: 'demo', display_name: 'demo', canonical_path: repo, default_branch: 'main', deployment_environments: ['production'] } } };
  if (gate) config.gate = { ...config.gate, ...gate };
  if (tracker) config.tracker = tracker;
  const env = { QUILL_HOME: home };
  saveUserConfig(config, env);
  const clock = () => Date.parse('2026-10-02T08:00:00Z');
  const mk = (kind, payload, extra = {}) => makeEvent({ kind, payload, store_id: meta.store_id, machine_id: MACHINE, producer: 'test', occurred_at: '2026-10-02T08:00:00Z', ...extra });
  return { home, repo, meta, config, env, clock, mk };
}

test('the worker publishes gate mode, tracker and per-repository scopes in the runtime identity', async () => {
  const f = fixture({ repoToml: 'project_id = "demo"\n[tracker]\nsystem = "jira"\ndomain = "https://example.atlassian.net"\nprefixes = ["PMLA"]\n[gate]\nmode = "strict"\n' });
  const w = new Worker({ config: f.config, storeMeta: f.meta, env: f.env, clock: f.clock });
  await w.start();
  try {
    const id = readRuntimeIdentity(f.env);
    assert.equal(id.gate_mode, 'nudge');
    assert.equal(id.tracker, null);
    const r = id.repos.find((x) => x.repo_id === 'demo');
    assert.equal(r.gate_mode, 'strict');
    assert.deepEqual(r.tracker.prefixes, ['PMLA']);
    assert.equal(r.tracker.url_template, '{domain}/browse/{key}');
  } finally { await w.stop(); }
});

test('a repository cannot loosen the gate, and invalid tracker config is reported rather than applied', async () => {
  const f = fixture({ gate: { mode: 'strict' }, repoToml: "[gate]\nmode = \"off\"\n[tracker]\nkey_pattern = '(a+)+'\n" });
  const w = new Worker({ config: f.config, storeMeta: f.meta, env: f.env, clock: f.clock });
  await w.start();
  try {
    const r = readRuntimeIdentity(f.env).repos[0];
    assert.equal(r.gate_mode, 'strict');
    assert.equal(r.tracker, null);
    const health = fs.readFileSync(path.join(f.home, 'state', 'health-errors.jsonl'), 'utf8');
    assert.match(health, /config-invalid/);
    assert.match(health, /backtracking/);
  } finally { await w.stop(); }
});

test('editing a registered .quill.toml republishes the identity without a restart', async () => {
  const f = fixture({ repoToml: '[tracker]\nprefixes = ["PMLA"]\n' });
  const w = new Worker({ config: f.config, storeMeta: f.meta, env: f.env, clock: f.clock, identityCheckMs: 0 });
  await w.start();
  try {
    const file = path.join(f.repo, '.quill.toml');
    fs.writeFileSync(file, '[tracker]\nprefixes = ["PC"]\n');
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(file, later, later);
    w.tick();
    assert.deepEqual(readRuntimeIdentity(f.env).repos[0].tracker.prefixes, ['PC']);
  } finally { await w.stop(); }
});

test('a fresh provisional snapshot survives an unrelated publish until its bind event is applied', async () => {
  const f = fixture();
  const w = new Worker({ config: f.config, storeMeta: f.meta, env: f.env, clock: f.clock });
  await w.start();
  try {
    const bindEv = f.mk('bind', { external: { system: 'jira', key: 'PMLA-1', url: null }, source: 'prompt', title_hint: null, project_id: 'demo', repo_id: 'demo', ensure_only: false }, { session_id: 'p1' });
    const provisionalId = externalTicketId(f.meta.store_id, 'PMLA-1');
    writeBindingSnapshot('p1', { session_id: null, ticket_id: provisionalId, ticket_key: 'PMLA-1', ticket_title: 'PMLA-1', ticket_aliases: [], project_id: 'demo', binding_revision: 1, gate_enabled: true, has_title: false, provisional: true, provisional_event_id: bindEv.event_id, provisional_at: '2026-10-02T08:00:00Z' }, f.env);
    writeIngress(f.mk('session-start', { source: 'startup', cwd: f.repo }, { session_id: 'p1' }), f.env);
    w.tick();
    assert.equal(readBindingSnapshot('p1', f.env).provisional, true, 'an unrelated publish keeps the provisional binding');
    writeIngress(bindEv, f.env);
    w.tick();
    const confirmed = readBindingSnapshot('p1', f.env);
    assert.equal(confirmed.provisional, undefined);
    assert.equal(confirmed.ticket_id, provisionalId);
    assert.equal(confirmed.binding_revision, 1);
    assert.deepEqual(confirmed.ticket_aliases, []);
    writeBindingSnapshot('p2', { ticket_id: provisionalId, ticket_key: 'PMLA-1', binding_revision: 1, gate_enabled: true, provisional: true, provisional_event_id: 'never-applied', provisional_at: '2026-10-02T07:58:00Z' }, f.env);
    writeIngress(f.mk('session-start', { source: 'startup', cwd: f.repo }, { session_id: 'p2' }), f.env);
    w.tick();
    assert.equal(readBindingSnapshot('p2', f.env).ticket_id, null, 'a stale provisional snapshot is replaced');
  } finally { await w.stop(); }
});
