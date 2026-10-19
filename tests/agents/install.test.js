// ADR 0020: shared recipes install from a folder or an https Git URL, previewed, then confirmed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { install } from '../../src/cli/commands/agent.js';
import { fetchSource, readInstalled, gitClone } from '../../src/agents/install.js';
import { personalRecipesDir } from '../../src/agents/recipes.js';
import { loadContext } from '../../src/cli/context.js';
import { makeHome, cli } from '../cli/helpers.js';

const recipe = (name, extra = '') => `---\nname: ${name}\ndescription: ${name} for tests\n${extra}---\nLook at {{ticket.key}} and summarise it.\n`;

function shared() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-shared-'));
  fs.mkdirSync(path.join(dir, 'recipes'));
  fs.writeFileSync(path.join(dir, 'recipes', 'triage.md'), recipe('triage'));
  fs.writeFileSync(path.join(dir, 'recipes', 'fixer.md'), recipe('fixer', 'mode: attempt-fix\npermissions: { read_source: true, edit_source: true, commit: true }\n'));
  fs.writeFileSync(path.join(dir, 'recipes', 'broken.md'), '---\nname: other\n---\nbody\n');
  fs.writeFileSync(path.join(dir, 'recipes', 'README.md'), '# not a recipe');
  return dir;
}

function capture() {
  let out = '';
  return { io: { println: (s = '') => { out += `${s}\n`; }, json: (o) => { out += JSON.stringify(o); }, out: (s) => { out += s; }, error: () => {} }, get out() { return out; } };
}

test('install previews what each recipe may do and installs nothing without --confirm', async () => {
  const fx = makeHome();
  const ctx = loadContext(fx.env);
  const c = capture();
  assert.equal(await install(ctx, c.io, [shared()], {}), 0);
  assert.match(c.out, /nothing is installed yet/);
  assert.match(c.out, /install  triage \(analyse, 30 min\)/);
  assert.match(c.out, /can change things: edit_source, commit/);
  assert.match(c.out, /skip     broken: name "other" must match the file name "broken"/);
  assert.doesNotMatch(c.out, /README/);
  assert.equal(fs.existsSync(path.join(personalRecipesDir(fx.env), 'triage.md')), false);
});

test('--confirm installs valid recipes with provenance; list marks them; uninstall removes only unmodified ones', async () => {
  const fx = makeHome();
  const ctx = loadContext(fx.env);
  const src = shared();
  const c = capture();
  assert.equal(await install(ctx, c.io, [src], { confirm: true, only: 'triage,fixer' }), 0);
  assert.match(c.out, /Installed fixer, triage into/);
  const index = readInstalled(fx.env);
  assert.deepEqual(Object.keys(index).sort(), ['fixer', 'triage']);
  assert.equal(index.triage.source, src);
  assert.equal(index.triage.file, 'recipes/triage.md');
  assert.match(index.triage.hash, /^[0-9a-f]{64}$/);
  const list = await cli(['agent', 'list'], fx.env);
  assert.match(list.out, /triage\s+installed\s+analyse/);
  const again = capture();
  assert.equal(await install(ctx, again.io, [src], { confirm: true, only: 'triage' }), 1, 'an installed recipe is not replaced silently');
  assert.match(again.out, /already installed from .* \(use --replace to update\)/);
  fs.appendFileSync(path.join(personalRecipesDir(fx.env), 'fixer.md'), '\nMy own edit.\n');
  const refused = await cli(['agent', 'uninstall', 'fixer'], fx.env);
  assert.notEqual(refused.code, 0);
  assert.match(refused.err, /edited after installing/);
  assert.equal((await cli(['agent', 'uninstall', 'triage'], fx.env)).code, 0);
  assert.equal(fs.existsSync(path.join(personalRecipesDir(fx.env), 'triage.md')), false);
  assert.deepEqual(Object.keys(readInstalled(fx.env)), ['fixer']);
});

test('a hand-written personal recipe is never overwritten without --replace', async () => {
  const fx = makeHome();
  fs.mkdirSync(personalRecipesDir(fx.env), { recursive: true });
  fs.writeFileSync(path.join(personalRecipesDir(fx.env), 'triage.md'), recipe('triage'));
  const c = capture();
  assert.equal(await install(loadContext(fx.env), c.io, [shared()], { confirm: true, only: 'triage' }), 1);
  assert.match(c.out, /a personal recipe with this name exists/);
});

test('sources: https Git URLs are cloned with a pinned ref; other schemes and credentials in URLs are refused', async () => {
  const calls = [];
  const src = shared();
  const fakeClone = (url, ref, dest) => { calls.push({ url, ref }); fs.cpSync(src, dest, { recursive: true }); return 'abc123def4567890'; };
  const fx = makeHome();
  const c = capture();
  assert.equal(await install(loadContext(fx.env), c.io, ['https://example.com/team/recipes.git'], { ref: 'v1.2', only: 'triage' }, { clone: fakeClone }), 0);
  assert.deepEqual(calls, [{ url: 'https://example.com/team/recipes.git', ref: 'v1.2' }]);
  assert.match(c.out, /at v1\.2 \(commit abc123def456\)/);
  assert.throws(() => fetchSource('ext::sh -c touch% /tmp/pwned'), /not a folder or an https/);
  assert.throws(() => fetchSource('ssh://git@example.com/x.git'), /https:\/\/ Git URL or a local folder/);
  assert.throws(() => fetchSource('https://user:secret@example.com/x.git'), /no credentials/);
  assert.throws(() => fetchSource('https://example.com/x.git', { ref: '--upload-pack=evil' }), /--ref must be/);
  assert.equal(typeof gitClone, 'function');
});
