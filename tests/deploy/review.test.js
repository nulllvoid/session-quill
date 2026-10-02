// Regression tests for the step 5 review findings (ADR 0009).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildRuntimeIdentity } from '../../src/config/runtime.js';
import { createStoreMeta } from '../../src/config/store.js';
import { buildToday } from '../../src/today/feed.js';
import { renderDigest } from '../../src/today/digest.js';
import { writeMarkedSection } from '../../src/lib/marked-section.js';
import { normalizeSchedules } from '../../src/schedule/config.js';
import { createJobs } from '../../src/schedule/jobs.js';
import { scenario, T1 } from '../acceptance/scenario.js';
import { runReconciliation } from '../../src/reconcile/run.js';

const meta = createStoreMeta({ store_name: 'Q', owner_machine_id: '22222222-2222-4222-8222-222222222222', timezone: 'UTC' });

test('review 1: a [tracker] table with only environments lists environments without switching on ticket binding', () => {
  const { identity } = buildRuntimeIdentity({ storeMeta: meta, config: { store_path: 'C:/Q', tracker: { environments: ['stage', 'prod'] }, repos: {} } });
  assert.equal(identity.tracker, null, 'no key pattern, no auto-binding');
  assert.deepEqual(identity.environments, ['stage', 'prod']);
  const bad = buildRuntimeIdentity({ storeMeta: meta, config: { store_path: 'C:/Q', tracker: { system: 'jira', key_pattern: '(', environments: ['stage'] }, repos: {} } });
  assert.deepEqual(bad.identity.environments, ['stage'], 'a broken key pattern does not lose the environments');
});

test('review 2: when a repository\'s environments cannot be resolved, a merge is not recorded with a guessed list; it is retried once config is fixed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-env-'));
  fs.writeFileSync(path.join(dir, '.quill.toml'), '[tracker\nenvironments = ["stage"]\n');
  const merged = { state: 'merged', opened_at: '2026-10-01T00:00:00Z', merged_at: '2026-10-02T06:00:00Z' };
  const providers = { for: () => ({ name: 'github', fetchPr: async () => merged }) };
  const s = scenario({ providers, gateMode: 'nudge', repos: { demo: { project_id: 'demo', display_name: 'demo', default_branch: 'main', provider: 'github', canonical_path: dir } } });
  s.config.tracker = { environments: ['prod'] };
  await s.start();
  try {
    s.ticket(T1, 'PROJ-1');
    s.bind('pr1', T1);
    s.ingest('pre-tool', { tool_name: 'Bash' }, { session_id: 'pr1', tool_call_id: 'g1', source_identity: 'pre:pr1:g1' });
    s.ingest('post-tool', { tool_name: 'Bash', write_paths: [], repo_id: 'demo', success: true, pr: { url: 'https://github.com/acme/demo/pull/1', provider: 'github', state: 'open' } }, { session_id: 'pr1', tool_call_id: 'g1', source_identity: 'post:pr1:g1' });
    s.w.tick();
    await runReconciliation(s.w, { providers });
    let t = s.w.state.tickets.get(T1);
    assert.equal(t.deployments.length, 0);
    assert.match(t.prs[0].error, /deployment environments for demo are unresolved/);
    fs.writeFileSync(path.join(dir, '.quill.toml'), '[tracker]\nenvironments = ["stage"]\n');
    s.w.publishIdentity();
    await runReconciliation(s.w, { providers });
    t = s.w.state.tickets.get(T1);
    assert.deepEqual(t.deployments.map((d) => d.environment), ['stage']);
  } finally { await s.stop(); }
});

test('review 3: a caught-up digest writes the missed slot\'s day, not the day it finally runs', async () => {
  const s = await scenario({ startMs: Date.parse('2026-10-03T09:00:00Z') }).start();
  try {
    const jobs = createJobs({ providers: null });
    const r = await jobs.digest(s.w, { schedule: 'd', due_at: '2026-10-02T19:30:00Z', settings: { to: ['vault-daily'], path: null, day: 'today' } });
    assert.match(r.summary, /for 2026-10-02/);
    assert.ok(fs.existsSync(path.join(s.storePath, 'daily', '2026-10-02.md')));
  } finally { await s.stop(); }
});

test('review 3: the scheduler tells a job which slot it runs for', async () => {
  const { Worker } = await import('../../src/worker/worker.js');
  const { createSchedulerExtension } = await import('../../src/schedule/extension.js');
  const { defaultUserConfig, saveUserConfig } = await import('../../src/config/config.js');
  const { writeStoreMeta } = await import('../../src/config/store.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'st-slot-'));
  const storePath = path.join(home, 'Quill');
  fs.mkdirSync(storePath);
  writeStoreMeta(storePath, meta);
  fs.writeFileSync(path.join(home, 'machine.json'), JSON.stringify({ machine_id: meta.owner_machine_id, machine_name: 't' }));
  const config = { ...defaultUserConfig(), store_path: storePath, timezone: 'UTC', projects: {}, repos: {}, schedule: [{ name: 'evening', job: 'digest', cron: '30 19 * * *' }] };
  const env = { QUILL_HOME: home };
  saveUserConfig(config, env);
  let now = Date.parse('2026-10-02T19:29:00Z');
  const seen = [];
  const jobs = { async digest(worker, args) { seen.push(args.due_at); return { summary: 'ok' }; } };
  const w = new Worker({ config, storeMeta: meta, env, clock: () => now });
  const ext = createSchedulerExtension({ env, config }, { jobs, stopWaitMs: 0 });
  w.use(ext);
  await w.start();
  try {
    now = Date.parse('2026-10-03T09:00:00Z');
    w.tick();
    await ext.idle();
    assert.deepEqual(seen, ['2026-10-02T19:30:00Z']);
  } finally { await w.stop(); }
});

test('review 4: the Today window counts calendar days across a daylight-saving change', () => {
  const tl = (at) => ({ id: at, at, kind: 'commit', text: 'c', event_id: 'e', content_ref: null, coverage: 'complete' });
  const state = { meta: { timezone: 'America/New_York' }, sessions: new Map(), tickets: new Map([['t', { id: 't', key: 'K-1', title: 't', status: 'active', timeline: [tl('2026-10-31T15:00:00Z'), tl('2026-11-01T15:00:00Z')] }]]) };
  const today = buildToday(state, { nowIso: '2026-11-02T04:30:00Z', days: 2 });
  assert.deepEqual(today.days.map((d) => d.date), ['2026-11-01', '2026-10-31']);
});

test('review 5: digest paths resolve against the store, ~ means home, and must be markdown', () => {
  const { schedules, warnings } = normalizeSchedules({ store_path: 'C:/Quill', schedule: [
    { name: 'rel', job: 'digest', every: '1d', to: ['file'], path: 'notes/digest.md' },
    { name: 'home', job: 'digest', every: '1d', to: ['file'], path: '~/digest.md' },
    { name: 'txt', job: 'digest', every: '1d', to: ['file'], path: 'C:/notes/digest.txt' },
  ] }, { timeZone: 'UTC', now: Date.parse('2026-10-03T08:00:00Z') });
  assert.deepEqual(schedules.map((s) => s.path), [path.resolve('C:/Quill', 'notes/digest.md'), path.join(os.homedir(), 'digest.md')]);
  assert.match(warnings.join('\n'), /txt.*path must end in \.md/);
});

test('review 6: the marked section survives CRLF editors, can be cleared to regenerate, never escapes its markers, and keeps the owner\'s trailing spaces', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-ms-'));
  const file = path.join(dir, 'note.md');
  const indexPath = path.join(dir, 'index.json');
  fs.writeFileSync(file, 'my line with a hard break  \n');
  writeMarkedSection({ file, marker: 'digest', markdown: 'one\n', indexPath });
  assert.match(fs.readFileSync(file, 'utf8'), /^my line with a hard break {2}\n/);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\n/g, '\r\n'));
  writeMarkedSection({ file, marker: 'digest', markdown: 'two\n', indexPath });
  assert.match(fs.readFileSync(file, 'utf8'), /\r\ntwo\r\n/, 'a CRLF file is not mistaken for an edit and keeps CRLF');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('two', 'mine'));
  assert.throws(() => writeMarkedSection({ file, marker: 'digest', markdown: 'three\n', indexPath }), /delete what is between the markers/);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('mine', ''));
  writeMarkedSection({ file, marker: 'digest', markdown: 'three\n', indexPath });
  assert.match(fs.readFileSync(file, 'utf8'), /three/);
  fs.rmSync(indexPath);
  writeMarkedSection({ file, marker: 'digest', markdown: 'three\n', indexPath });
  const md = renderDigest({ date: '2026-10-03', sessions: 0, tickets: [{ key: 'K-1', title: 'sneaky <!-- quill:digest:end --> title', counts: { commit: 1 } }] });
  assert.doesNotMatch(md, /<!--/);
});
