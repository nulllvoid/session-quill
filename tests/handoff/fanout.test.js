import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedToolsFor } from '../../src/handoff/runner.js';
import os from 'node:os';
import { loadRecipes } from '../../src/agents/recipes.js';

const SUBAGENT_TOOLS = ['Task', 'Agent'];

test('read-only analyses with source access may fan out to Claude Code subagents (ADR 0023)', () => {
  for (const mode of ['analyse', 'analyse-followups']) {
    const t = allowedToolsFor({ mode, permissions: { read_source: true } });
    for (const tool of SUBAGENT_TOOLS) assert.ok(t.allowed.includes(tool), `${mode} allows ${tool}`);
    assert.ok(t.disallowed.includes('Edit'), 'still read-only');
  }
  const notes = allowedToolsFor({ mode: 'analyse', permissions: {} });
  for (const tool of SUBAGENT_TOOLS) assert.ok(notes.disallowed.includes(tool), 'a notes-only run has nothing to fan out over');
  const fix = allowedToolsFor({ mode: 'attempt-fix', permissions: { read_source: true, edit_source: true } });
  for (const tool of SUBAGENT_TOOLS) assert.equal(fix.allowed.includes(tool), false, 'a fix stays one agent');
});

test('the built-in analyse recipes tell the agent to split large analyses by module and merge the results', () => {
  const { effective } = loadRecipes({ env: { QUILL_HOME: os.tmpdir(), HOME: os.tmpdir(), USERPROFILE: os.tmpdir() } });
  for (const name of ['analyse', 'analyse-followups']) {
    const r = effective.get(name);
    assert.ok(r, name);
    assert.match(r.body, /subagent/i);
    assert.match(r.body, /by module|per module/i);
    assert.match(r.body, /merge/i);
  }
});

test('only read-only analyses get subagents, under every access level, and a self-check never does', async () => {
  const { runtimeAccess, selfCheckTools } = await import('../../src/handoff/runner.js');
  const fixPerms = { read_source: true, edit_source: true };
  for (const access of ['standard', 'settings', 'full']) {
    const fix = runtimeAccess({ access, mode: 'attempt-fix', permissions: fixPerms });
    for (const tool of SUBAGENT_TOOLS) {
      assert.equal(fix.allowed.includes(tool), false, `${access}: a fix is not allowed ${tool}`);
      assert.ok(fix.disallowed.includes(tool), `${access}: a fix is denied ${tool}`);
    }
    const editingAnalyse = runtimeAccess({ access, mode: 'analyse', permissions: fixPerms });
    for (const tool of SUBAGENT_TOOLS) assert.ok(editingAnalyse.disallowed.includes(tool), `${access}: a run that may edit source is denied ${tool}`);
    const read = runtimeAccess({ access, mode: 'analyse', permissions: { read_source: true } });
    for (const tool of SUBAGENT_TOOLS) assert.equal(read.disallowed.includes(tool), false, `${access}: a read-only analysis keeps ${tool}`);
  }
  for (const perms of [{ read_source: true }, { read_source: false }, fixPerms]) {
    const check = selfCheckTools(perms);
    for (const tool of SUBAGENT_TOOLS) {
      assert.equal(check.allowed.includes(tool), false, 'the self-check is one agent');
      assert.ok(check.disallowed.includes(tool));
    }
    assert.ok(check.disallowed.includes('Edit'), 'and never edits');
  }
});
