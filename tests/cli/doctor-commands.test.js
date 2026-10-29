import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandsCheck, collect } from '../../src/cli/commands/doctor.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const command = '---\ndescription: Test command\nallowed-tools: Bash(node *)\n---\nnode "${CLAUDE_PLUGIN_ROOT}/bin/quill.js" example\n';
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quill-doctor-commands-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.claude-plugin'));
  fs.mkdirSync(path.join(dir, 'commands'));
  fs.writeFileSync(path.join(dir, '.claude-plugin/plugin.json'), JSON.stringify({ commands: ['./commands/example.md'] }));
  fs.writeFileSync(path.join(dir, 'commands/example.md'), command);
  return dir;
}

test('doctor validates and lists all nine shipped commands from the manifest', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin/plugin.json'), 'utf8'));
  assert.equal(manifest.commands.length, 9);
  assert.deepEqual(manifest.commands.map((p) => path.basename(p)).sort(), fs.readdirSync(path.join(root, 'commands')).filter((p) => p.endsWith('.md')).sort());
  const check = commandsCheck();
  assert.equal(check.level, 'ok', check.detail);
  assert.deepEqual(check.detail.split(', '), manifest.commands.map((p) => `/session-quill:${path.basename(p, '.md')}`).sort());
});

test('doctor command list follows manifest additions', (t) => {
  const dir = fixture(t);
  assert.deepEqual(commandsCheck(dir), { level: 'ok', detail: '/session-quill:example' });
});

test('doctor reports a missing declared command and marks the report failed', async (t) => {
  const dir = fixture(t);
  fs.unlinkSync(path.join(dir, 'commands/example.md'));
  const check = commandsCheck(dir);
  assert.equal(check.level, 'error');
  assert.match(check.detail, /commands\/example\.md.*ENOENT/);
  const { report } = await collect({ QUILL_HOME: path.join(dir, 'home') }, { pluginRoot: dir });
  assert.equal(report.ok, false);
  assert.deepEqual(report.items.find((item) => item.label === 'commands'), { ...check, label: 'commands' });
});

test('doctor reports malformed command frontmatter and missing CLI reference', (t) => {
  const dir = fixture(t);
  for (const [text, expected] of [
    ['description: no delimiters', /frontmatter/],
    ['---\ndescription: hello\n', /frontmatter/],
    [command.replace('description: Test command', 'description:'), /description/],
    [command.replace('description: Test command', 'description "unterminated'), /expected key/],
    [command.replace('${CLAUDE_PLUGIN_ROOT}/bin/quill.js', '/wrong/quill.js'), /bundled CLI/],
  ]) {
    fs.writeFileSync(path.join(dir, 'commands/example.md'), text);
    const check = commandsCheck(dir);
    assert.equal(check.level, 'error');
    assert.match(check.detail, /commands\/example\.md/);
    assert.match(check.detail, expected);
  }
});

test('doctor reports malformed or empty command manifests without throwing', (t) => {
  const dir = fixture(t);
  for (const text of ['{', '{}', '{"commands":[]}', '{"commands":[null]}', '{"commands":["../outside.md"]}']) {
    fs.writeFileSync(path.join(dir, '.claude-plugin/plugin.json'), text);
    const check = commandsCheck(dir);
    assert.equal(check.level, 'error', text);
    assert.match(check.detail, /plugin\.json|command path/);
  }
});
