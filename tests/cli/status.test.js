// The lean status-line entry (scripts/statusline.js, ADR 0034) prints exactly what the CLI's
// `quill status --statusline` printed before it: the expected strings below were produced by the
// 1.1.1 implementation (scripts/statusline.js → src/cli/main.js → status.js) for each state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MACHINE = '22222222-2222-4222-8222-222222222222';
const STORE = '33333333-3333-4333-8333-333333333333';
const OSC = '\u001b]8;;';
const ST = '\u001b\\';
const link = (url) => ` ${OSC}${url}${ST}${url}${OSC}${ST}`;

function home({ initialized = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-statusline-'));
  if (!initialized) return dir;
  const store = path.join(dir, 'Quill');
  fs.mkdirSync(store);
  fs.writeFileSync(path.join(store, 'store.json'), JSON.stringify({ schema_version: 1, store_id: STORE, store_name: 'Quill', owner_machine_id: MACHINE }));
  fs.writeFileSync(path.join(dir, 'machine.json'), JSON.stringify({ machine_id: MACHINE, machine_name: 'test' }));
  fs.writeFileSync(path.join(dir, 'config.toml'), `config_version = 1\nstore_path = ${JSON.stringify(store)}\n`);
  fs.mkdirSync(path.join(dir, 'state', 'bindings'), { recursive: true });
  return dir;
}
const write = (dir, rel, value) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), typeof value === 'string' ? value : JSON.stringify(value));
};
const bind = (dir, session, snap) => write(dir, `state/bindings/${session}.json`, { schema_version: 1, session_key: session, binding_revision: 1, ...snap });
const healthy = (dir, pid = 4242) => write(dir, 'state/heartbeat.json', { at: new Date().toISOString(), pid });
const endpoint = (dir, ep) => write(dir, 'state/ui-endpoint.json', { host: '127.0.0.1', pid: 4242, started_at: '2026-10-11T00:00:00Z', ...ep });
const TICKET = { ticket_id: '00000001-0000-4000-8000-000000000000', ticket_key: 'DEV-7', ticket_title: 'Lean status line', gate_enabled: true };

const STATES = [
  { name: 'not initialized', setup: () => home({ initialized: false }), input: { session_id: 's1' }, want: '⌁ quill: not initialized' },
  { name: 'no session id, worker down', setup: () => home(), input: {}, want: '⌁ unbound ⚠ worker' },
  { name: 'malformed stdin', setup: () => home(), input: '{not json', want: '⌁ unbound ⚠ worker' },
  { name: 'unbound session', setup: () => home(), input: { session_id: 's1' }, want: '⌁ unbound ⚠ worker' },
  { name: 'unbound, gate off', setup: () => { const d = home(); bind(d, 's1', { ticket_id: null, gate_enabled: false }); return d; }, input: { session_id: 's1' }, want: '⌁ unbound (gate off) ⚠ worker' },
  { name: 'bound, worker down', setup: () => { const d = home(); bind(d, 's1', TICKET); return d; }, input: { session_id: 's1', cwd: os.tmpdir() }, want: '⌁ DEV-7 Lean status line ⚠ worker' },
  { name: 'bound, gate off', setup: () => { const d = home(); bind(d, 's1', { ...TICKET, gate_enabled: false }); return d; }, input: { session_id: 's1' }, want: '⌁ DEV-7 Lean status line (gate off) ⚠ worker' },
  { name: 'bound, no title, healthy', setup: () => { const d = home(); bind(d, 's1', { ...TICKET, ticket_title: null }); healthy(d); return d; }, input: { session_id: 's1' }, want: '⌁ DEV-7' },
  { name: 'session key with unsafe characters', setup: () => { const d = home(); bind(d, 'a_b', TICKET); return d; }, input: { session_id: 'a/b' }, want: '⌁ DEV-7 Lean status line ⚠ worker' },
  { name: 'bound, healthy, dashboard link', setup: () => { const d = home(); bind(d, 's1', TICKET); healthy(d); endpoint(d, { port: 47321 }); return d; }, input: { session_id: 's1' }, want: `⌁ DEV-7 Lean status line${link('http://127.0.0.1:47321/')}` },
  { name: 'unbound, healthy, port fallback', setup: () => { const d = home(); healthy(d); endpoint(d, { port: 50123, configured_port: 47321 }); return d; }, input: { session_id: 's1' }, want: `⌁ unbound${link('http://127.0.0.1:50123/')} ⚠ port 47321 taken; using 50123` },
  { name: 'stale endpoint pid', setup: () => { const d = home(); bind(d, 's1', TICKET); healthy(d); endpoint(d, { port: 47321, pid: 999999 }); return d; }, input: { session_id: 's1' }, want: '⌁ DEV-7 Lean status line' },
  { name: 'non-loopback endpoint', setup: () => { const d = home(); healthy(d); endpoint(d, { host: 'evil.example', port: 47321 }); return d; }, input: { session_id: 's1' }, want: '⌁ unbound' },
  { name: 'unreadable store', setup: () => { const d = home(); write(d, 'Quill/store.json', '{broken'); return d; }, input: { session_id: 's1' }, want: '' },
];

const run = (argv, dir, input) => spawnSync(process.execPath, argv, { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', env: { ...process.env, QUILL_HOME: dir, QUILL_HANDOFF_ID: '' } });

for (const s of STATES) {
  test(`status line, ${s.name}: the lean entry and quill status --statusline print the 1.1.1 bytes`, () => {
    const dir = s.setup();
    try {
      const lean = run([path.join(ROOT, 'scripts', 'statusline.js')], dir, s.input);
      assert.equal(lean.status, 0, lean.stderr);
      assert.equal(lean.stdout, s.want);
      assert.equal(lean.stderr, '');
      const cli = run([path.join(ROOT, 'bin', 'quill.js'), 'status', '--statusline'], dir, s.input);
      assert.equal(cli.stdout, s.want);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('the lean status-line entry does not load the CLI command table', () => {
  const dir = home();
  const trace = path.join(dir, 'loaded.txt');
  const hooks = path.join(dir, 'trace.mjs');
  fs.writeFileSync(hooks, `import { registerHooks } from 'node:module';\nimport fs from 'node:fs';\nregisterHooks({ load(url, ctx, next) { if (url.startsWith('file:')) fs.appendFileSync(${JSON.stringify(trace)}, url + '\\n'); return next(url, ctx); } });\n`);
  try {
    const r = spawnSync(process.execPath, ['--import', pathToFileURL(hooks).href, path.join(ROOT, 'scripts', 'statusline.js')], { input: '{}', encoding: 'utf8', env: { ...process.env, QUILL_HOME: dir } });
    assert.equal(r.stdout, '⌁ unbound ⚠ worker', r.stderr);
    const loaded = fs.readFileSync(trace, 'utf8');
    for (const heavy of ['/src/cli/main.js', '/src/cli/commands/', '/src/worker/', '/src/runtime/']) assert.ok(!loaded.includes(heavy), `${heavy} stays unloaded`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
