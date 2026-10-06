import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { HOOK_EVENTS } from '../../src/hooks/adapter.js';

const ROOT = path.resolve('.');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('plugin.json is valid, named session-quill, and references existing paths', () => {
  const manifest = JSON.parse(read('.claude-plugin/plugin.json'));
  assert.equal(manifest.name, 'session-quill');
  assert.ok(manifest.version);
  assert.ok(manifest.description);
  assert.ok(manifest.author && manifest.author.name);
  for (const p of manifest.agents ?? []) assert.ok(fs.existsSync(path.join(ROOT, p)), p);
  assert.ok(fs.existsSync(path.join(ROOT, 'agents', 'quill-handoff.md')));
});

test('hooks.json covers every supported hook event in exec form with node, synchronously, and points at existing files', () => {
  const hooks = JSON.parse(read('hooks/hooks.json')).hooks;
  for (const event of HOOK_EVENTS) {
    assert.ok(Array.isArray(hooks[event]) && hooks[event].length, `hook for ${event}`);
    for (const matcherBlock of hooks[event]) {
      for (const h of matcherBlock.hooks) {
        assert.equal(h.type, 'command');
        assert.equal(h.command, 'node', `${event} uses exec form with node`);
        assert.ok(Array.isArray(h.args), `${event} has args`);
        assert.equal(h.args[0], '${CLAUDE_PLUGIN_ROOT}/bin/quill.js');
        assert.equal(h.args[1], 'hook');
        assert.equal(h.args[2], event);
        assert.notEqual(h.async, true, `${event} must not be async`);
        assert.ok(Number.isInteger(h.timeout) && h.timeout <= 10, `${event} has a short timeout`);
      }
    }
  }
  assert.ok(fs.existsSync(path.join(ROOT, 'bin', 'quill.js')));
  assert.equal(hooks.PreToolUse[0].matcher, undefined, 'PreToolUse evaluates every tool (no matcher)');
});

test('commands exist with frontmatter, use the plugin root path and never guess the namespace', () => {
  for (const name of ['start', 'ticket', 'approve', 'status', 'handoff', 'ui', 'agent', 'publish']) {
    const text = read(`commands/${name}.md`);
    assert.match(text, /^---\n[\s\S]*description:/, `${name} has frontmatter`);
    assert.match(text, /\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/quill\.js/, `${name} runs the bundled CLI`);
    assert.equal(/\/ticket\b(?!:)/.test(text.replace(/\/session-quill:ticket/g, '')), false, `${name} does not reference an unnamespaced /ticket alias`);
  }
  assert.match(read('commands/ticket.md'), /argument-hint:/);
  assert.match(read('commands/ticket.md'), /--session/);
});

test('status line script prints the binding segment from status-line JSON', () => {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'statusline.js')], { input: JSON.stringify({ session_id: 'sess-none', cwd: ROOT }), encoding: 'utf8', env: { ...process.env, QUILL_HOME: fs.mkdtempSync(path.join(require_os().tmpdir(), 'st-sl-')) } });
  assert.match(out, /quill: not initialized|unbound/);
});

function require_os() { return { tmpdir: () => process.env.TEMP || process.env.TMPDIR || '/tmp' }; }

test('README documents install, init, first tracked session, uninstall and diagnostics; the MIT license ships with the repo', () => {
  const readme = read('README.md');
  for (const needle of ['--plugin-dir', 'quill init', '/session-quill:ticket', 'quill doctor', 'Uninstall', 'quill ui', 'Node', 'not bundled']) assert.ok(readme.includes(needle), `README mentions ${needle}`);
  assert.ok(fs.existsSync(path.join(ROOT, 'docs', 'README.md')), 'design index moved under docs/');
  assert.match(read('LICENSE'), /^MIT License/);
  assert.equal(JSON.parse(read('package.json')).license, 'MIT');
  assert.equal(JSON.parse(read('.claude-plugin/plugin.json')).license, 'MIT');
  assert.equal(fs.existsSync(path.join(ROOT, 'LICENSE-TBD.md')), false);
});

test('claude plugin validate passes when the CLI is available', (t) => {
  let out;
  try {
    out = execFileSync(process.platform === 'win32' ? 'claude.exe' : 'claude', ['plugin', 'validate', ROOT], { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    if (err.code === 'ENOENT') { t.skip('claude CLI not installed'); return; }
    assert.fail(`claude plugin validate failed: ${err.stdout ?? ''}${err.stderr ?? ''}${err.message}`);
  }
  assert.match(out, /Validation passed/);
});
