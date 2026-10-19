// Final review I3 / ruling R59 part 3: in every tier except `full` the guard treats the Quill home
// (store, ingress, config, journal, handoffs, memory) as protected: no writes, and no reads of the
// credential and secret files there. Run code with plain filesystem access in full access can still
// act with the owner CLI's power (ADR 0026 residual).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decide } from '../../src/gate/run-guard.js';

const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'quill-home-guard-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const at = (...p) => path.join(base, ...p);
const dir = (...p) => { const d = at(...p); fs.mkdirSync(d, { recursive: true }); return d; };
const file = (...p) => { const f = at(...p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x\n'); return f; };

const home = dir('home');
const qh = dir('quill');
const ingress = dir('quill', 'ingress');
const config = file('quill', 'config.toml');
const journal = file('quill', 'events.jsonl');
file('quill', 'memory', 'repo', 'demo.md');
file('quill', 'state', 'heartbeat.json');
const runDir = dir('quill', 'handoffs', 'runs', 'run1');
const context = file('quill', 'handoffs', 'runs', 'run1', 'context', 'repo.md');
const stub = file('quill', 'handoffs', 'runs', 'run1', 'env', 'aws-credentials');
const otherRun = dir('quill', 'handoffs', 'runs', 'run2');
const checkout = dir('quill', 'handoffs', 'worktrees', 'run1');
file('quill', 'handoffs', 'worktrees', 'run1', 'src', 'app.js');
const tmp = dir('tmp');

const VARS = { USERPROFILE: home, HOME: home, QUILL_HOME: qh, QUILL_HANDOFF_ID: 'run1', TEMP: tmp, TMP: tmp, TMPDIR: tmp, QUILL_HANDOFF_GUARD: 'enforce' };
const ENV = { cwd: checkout, vars: VARS, currentBranch: 'feat/x', defaultBranch: 'main', installRoot: dir('install') };
const EDIT = { read_source: true, edit_source: true, commit: true };
const grant = (over = {}) => ({
  access: 'autonomous', permissions: { read_source: true }, scopes: [], actionPins: [],
  readableRoots: [checkout, runDir, path.join(runDir, 'context'), tmp], writableRoots: [checkout, runDir, tmp], protectedPaths: [qh],
  mcpPolicy: { read: [], write: {} }, trustedMcpServers: [], trackerHosts: [], ...over,
});
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const call = (tool_name, tool_input) => ({ tool_name, tool_input });
const fwd = (p) => p.replace(/\\/g, '/');
const q = (p) => `'${p}'`;

const DENIED = [
  ['Write into the ingress folder', call('Write', { file_path: path.join(ingress, 'forged.json'), content: '{}' }), /^QUILL_DENIED protected-path: /],
  ['shell redirect into the ingress folder', bash(`echo {} > ${q(path.join(ingress, 'forged.json'))}`), /^QUILL_DENIED protected-path: /],
  ['Edit of config.toml', call('Edit', { file_path: config, old_string: 'x', new_string: 'y' }), /^QUILL_DENIED protected-path: /],
  ['append to the journal', bash(`echo x >> ${q(journal)}`), /^QUILL_DENIED protected-path: /],
  ['Write into memory', call('Write', { file_path: path.join(qh, 'memory', 'x.md'), content: 'x' }), /^QUILL_DENIED protected-path: /],
  ['Write into another run\'s directory', call('Write', { file_path: path.join(otherRun, 'grant.json'), content: '{}' }), /^QUILL_DENIED (protected-path|outside-writable): /],
  ['Read of config.toml', call('Read', { file_path: config }), /^QUILL_DENIED outside-readable: /],
  ['cat of the journal', bash(`cat ${q(journal)}`), /^QUILL_DENIED outside-readable: /],
  ['Read of the run\'s credential files', call('Read', { file_path: stub }), /^QUILL_DENIED outside-readable: /],
  ['cat of the run\'s credential files', bash(`cat ${q(stub)}`), /^QUILL_DENIED outside-readable: /],
  ['Grep through the run\'s credential files', call('Grep', { pattern: 'aws_secret', path: path.dirname(stub) }), /^QUILL_DENIED outside-readable: /],
  ['node inline code writing ingress through the home directory', bash(`node -e "require('fs').writeFileSync(require('os').homedir() + '/.claude/quill/ingress/x.json', '{}')"`), /^QUILL_DENIED quill-privileged: .*Quill home/],
  ['python inline code opening config.toml by its path', bash(`python -c "open('${fwd(config)}').read()"`), /^QUILL_DENIED quill-privileged: .*Quill home/],
  ['inline code reading QUILL_HOME', bash('node -e "console.log(process.env.QUILL_HOME)"'), /^QUILL_DENIED quill-privileged: .*Quill home/],
  ['an unknown tool on the Quill state', bash(`sqlite3 ${q(fwd(path.join(qh, 'state', 'x.db')))} .tables`), /^QUILL_DENIED quill-privileged: .*Quill home/],
];
for (const [name, c, reason] of DENIED) {
  for (const [label, g] of [['read-only', grant()], ['edit and commit', grant({ permissions: EDIT })]]) {
    test(`R59: ${name} is refused (${label})`, () => {
      const r = decide(c, g, ENV);
      assert.equal(r.decision, 'deny', r.reason);
      assert.match(r.reason, reason);
    });
  }
}

const ALLOWED = [
  ['Read of the run\'s context snapshot', call('Read', { file_path: context })],
  ['scratch in the run directory', call('Write', { file_path: path.join(runDir, 'notes.txt'), content: 'x' })],
  ['inline code reading the context snapshot', bash(`node -e "require('fs').readFileSync('${fwd(context)}')"`)],
  ['an ordinary node script', bash('node script.js')],
];
for (const [name, c] of ALLOWED) {
  test(`R59: ${name} is still allowed`, () => {
    const r = decide(c, grant({ permissions: EDIT }), ENV);
    assert.equal(r.decision, 'allow', r.reason);
  });
}

test('R59: full access only observes, so a run there can still reach the Quill home (ADR 0026 residual)', () => {
  const r = decide(call('Write', { file_path: path.join(ingress, 'x.json'), content: '{}' }), grant({ access: 'full' }), { ...ENV, vars: { ...VARS, QUILL_HANDOFF_GUARD: 'observe' } });
  assert.equal(r.decision, 'allow');
});
