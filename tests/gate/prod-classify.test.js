import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyCall } from '../../src/gate/prod-classify.js';
import { tokenize } from '../../src/gate/shell-tokens.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const rows = JSON.parse(fs.readFileSync(path.join(here, '..', 'fixtures', 'prod-classify.json'), 'utf8'));

const baseCtx = {
  cwd: 'C:\\work\\repo',
  home: 'C:\\Users\\dev',
  env: { TEMP: 'C:\\Users\\dev\\AppData\\Local\\Temp', TMP: 'C:\\Users\\dev\\AppData\\Local\\Temp' },
  currentBranch: 'feat/x',
  defaultBranch: 'main',
  mcpPolicy: { read: [], write: {} },
  trackerHosts: [],
};

const CLASSES = new Set(['local', 'read', 'write', 'external.write', 'privileged', 'unknown-prod', 'unparseable']);
const key = (p) => p.toLowerCase();

test('fixture has at least 200 rows', () => {
  assert.ok(rows.length >= 200, `only ${rows.length} rows`);
});

for (const [i, row] of rows.entries()) {
  const label = `${i} ${row.tool}: ${JSON.stringify(row.input?.command ?? row.input).slice(0, 90)}`;
  test(label, () => {
    const ctx = { ...baseCtx, ...(row.ctx ?? {}) };
    const r = classifyCall({ tool_name: row.tool, tool_input: row.input }, ctx);
    assert.ok(CLASSES.has(r.class), `bad class ${r.class}`);
    assert.equal(typeof r.reason, 'string', 'reason is a string');
    const got = { class: r.class };
    for (const k of ['scope', 'target', 'host', 'path']) if (k in row.expect) got[k] = r[k];
    if ('paths' in row.expect) got.paths = (r.paths ?? []).map(key).sort();
    if ('readPaths' in row.expect) got.readPaths = (r.readPaths ?? []).map(key).sort();
    const want = { ...row.expect };
    if (want.paths) want.paths = want.paths.map(key).sort();
    if (want.readPaths) want.readPaths = want.readPaths.map(key).sort();
    if (want.path) { want.path = key(want.path); got.path = got.path && key(got.path); }
    assert.deepEqual(got, want, `${row.note ?? ''} reason=${r.reason}`);
  });
}

// Shapes too large or awkward for the JSON fixture.
const LONG = 200 * 1024;
test('a 200 KB command is unparseable, never local and never a throw', () => {
  const r = classifyCall({ tool_name: 'Bash', tool_input: { command: `echo ${'a'.repeat(LONG)}` } }, baseCtx);
  assert.equal(r.class, 'unparseable');
  const r2 = classifyCall({ tool_name: 'PowerShell', tool_input: { command: `kubectl delete pod ${'p'.repeat(LONG)}` } }, baseCtx);
  assert.equal(r2.class, 'unparseable');
});

test('deep nesting is unparseable, not a stack overflow', () => {
  let cmd = 'kubectl delete pod p';
  for (let i = 0; i < 14; i += 1) cmd = `sh -c ${JSON.stringify(cmd)}`;
  const r = classifyCall({ tool_name: 'Bash', tool_input: { command: cmd } }, baseCtx);
  assert.ok(['unparseable', 'write'].includes(r.class), r.class);
  const parens = `${'('.repeat(5000)}kubectl delete pod p${')'.repeat(5000)}`;
  const r2 = classifyCall({ tool_name: 'Bash', tool_input: { command: parens } }, baseCtx);
  assert.ok(['unparseable', 'write'].includes(r2.class), r2.class);
});

test('thousands of cd commands are refused quickly, not followed one by one', () => {
  const cmd = `${'cd a; '.repeat(15000)}echo x > y`;
  const t0 = process.hrtime.bigint();
  const r = classifyCall({ tool_name: 'Bash', tool_input: { command: cmd } }, baseCtx);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(r.class, 'unparseable');
  assert.ok(ms < 1000, `${ms.toFixed(0)} ms`);
});

test('brace-like input near the size cap is classified in linear time', () => {
  const inputs = [`echo x > {${','.repeat(99_000)}`, `echo ${'{'.repeat(99_000)}`, `echo {${'a,'.repeat(49_000)}`, `rm ${'{a,'.repeat(33_000)}`];
  for (const command of inputs) {
    const t0 = process.hrtime.bigint();
    const r = classifyCall({ tool_name: 'Bash', tool_input: { command } }, baseCtx);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(CLASSES.has(r.class));
    assert.ok(ms < 50, `${command.slice(0, 20)}… took ${ms.toFixed(1)} ms`);
  }
});

test('garbage inputs never throw', () => {
  const inputs = [undefined, null, 0, 'x', [], { command: {} }, { command: Symbol.iterator.toString() }, { command: '\u0000kubectl delete pod p' }];
  for (const tool_name of ['Bash', 'PowerShell', 'Edit', 'mcp__a__b', '', undefined, 7]) {
    for (const tool_input of inputs) {
      const r = classifyCall({ tool_name, tool_input }, baseCtx);
      assert.ok(CLASSES.has(r.class));
    }
  }
  assert.ok(CLASSES.has(classifyCall(undefined, undefined).class));
  assert.ok(CLASSES.has(classifyCall({ tool_name: 'Bash', tool_input: { command: 'rm -rf x' } }, undefined).class));
});

test('a NUL byte in a command is unparseable', () => {
  const r = classifyCall({ tool_name: 'Bash', tool_input: { command: 'kubectl get pods\u0000; kubectl delete pod p' } }, baseCtx);
  assert.equal(r.class, 'unparseable');
});

test('chains report every non-local part so the guard can require all of them', () => {
  const r = classifyCall({ tool_name: 'Bash', tool_input: { command: 'kubectl delete pod p && curl -X POST https://h.example/x' } }, baseCtx);
  assert.equal(r.class, 'write');
  const classes = r.calls.map((c) => c.class).sort();
  assert.deepEqual(classes, ['external.write', 'write']);
});

test('default protected branches without ctx.isProtectedBranch, and a custom predicate', () => {
  const c = { ...baseCtx };
  assert.equal(classifyCall({ tool_name: 'Bash', tool_input: { command: 'git push origin trunk' } }, c).scope, 'git.protected');
  const custom = { ...baseCtx, isProtectedBranch: (b) => b === 'feat/x' };
  assert.equal(classifyCall({ tool_name: 'Bash', tool_input: { command: 'git push origin feat/x' } }, custom).scope, 'git.protected');
  assert.equal(classifyCall({ tool_name: 'Bash', tool_input: { command: 'git push origin main' } }, custom).scope, 'git.push');
  const noBranch = { ...baseCtx, currentBranch: undefined };
  assert.equal(classifyCall({ tool_name: 'Bash', tool_input: { command: 'git push' } }, noBranch).scope, 'git.protected', 'unknown push target is refused');
});

test('tokenize unwraps wrappers into segments', () => {
  assert.deepEqual(tokenize('sh -c "kubectl get pods | grep x"', 'bash'), [['kubectl', 'get', 'pods'], ['grep', 'x']]);
  assert.deepEqual(tokenize('& kubectl.exe delete pod p; Get-Date', 'powershell'), [['kubectl.exe', 'delete', 'pod', 'p'], ['Get-Date']]);
  assert.deepEqual(tokenize('FOO=1 env BAR=2 timeout 5 kubectl get pods', 'bash'), [['kubectl', 'get', 'pods']]);
  assert.equal(tokenize('echo "open', 'bash'), null);
});

test('module is pure: imports only node:path and its sibling', () => {
  for (const f of ['prod-classify.js', 'shell-tokens.js']) {
    const src = fs.readFileSync(path.join(here, '..', '..', 'src', 'gate', f), 'utf8');
    const specs = [...src.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm), ...src.matchAll(/import\(\s*['"]([^'"]+)['"]/g), ...src.matchAll(/require\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const s of specs) assert.ok(['node:path', './shell-tokens.js'].includes(s), `${f} imports ${s}`);
    assert.doesNotMatch(src, /process\.(env|cwd)|globalThis\.fetch|\bfetch\(/, `${f} reads ambient state`);
  }
});

test('perf: p95 under 5 ms over 1,000 mixed calls', () => {
  const sample = rows.filter((r) => r.tool !== 'SomeFutureTool');
  const times = [];
  for (let i = 0; i < 1000; i += 1) {
    const row = sample[i % sample.length];
    const t0 = process.hrtime.bigint();
    classifyCall({ tool_name: row.tool, tool_input: row.input }, { ...baseCtx, ...(row.ctx ?? {}) });
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.floor(times.length * 0.95)];
  assert.ok(p95 < 5, `p95 ${p95.toFixed(3)} ms`);
});
