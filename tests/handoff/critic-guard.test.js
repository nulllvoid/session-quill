// Review fix (ADR 0040): the critic of an autonomous run runs under the guard, with a read-only
// grant of its own and an autonomous environment without the run's scope credentials. Its guard
// lines go to its own directory (removed afterwards), never to the run's ledger, and its init
// event never replaces the run's MCP inventory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { bootWorker, makeRepo, until, git, T1 } from './helpers.js';
import { parseToml } from '../../src/config/toml.js';
import { handoffRunDir } from '../../src/lib/paths.js';

function gateScript() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-critg-gate-'));
  const file = path.join(dir, 'gate.js');
  fs.writeFileSync(file, "console.log('ok 1 test');");
  return `"${process.execPath}" "${file}"`;
}

test('an autonomous run\'s critic gets the guard and a read-only grant of its own, without the run\'s scope credentials', async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo.dir, 'CLAUDE.md'), 'Rules.\n');
  git(repo.dir, 'add', '.');
  git(repo.dir, 'commit', '-q', '-m', 'rules');
  const capture = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'st-critg-cap-')), 'cap.json');
  const scopes = parseToml('[scopes."k8s.write".targets.stg]\nenv.KUBECONFIG = "env:FAKE_RW_KUBECONFIG"\n').scopes;
  const b = await bootWorker({ repo, runtimeAvailable: true, configExtra: { scopes }, repoExtra: { test_command: gateScript(), critic: true }, fakeEnv: { FAKE_CLAUDE_EDIT: 'src.js', FAKE_CLAUDE_CAPTURE: capture, FAKE_RW_KUBECONFIG: '/fake/rw/kubeconfig', FAKE_CLAUDE_ENV_PROBE: 'KUBECONFIG,QUILL_HANDOFF_SCOPES,QUILL_HANDOFF_GUARD,QUILL_HANDOFF_ID,FAKE_RW_KUBECONFIG' } });
  try {
    b.ticket(T1, 'LOCAL-a-00000001');
    const rid = randomUUID();
    b.request(rid, { target_id: T1, expected_revision: b.w.state.tickets.get(T1).revision, payload: { mode: 'attempt-fix', note: 'fix it', permissions: { read_source: true, edit_source: true, commit: false, push_branch: false, open_draft_pr: false }, access: 'autonomous', scopes: ['k8s.write:stg'] } });
    b.w.tick();
    const req = b.w.state.requests.get(rid);
    assert.equal(req.state, 'applied', JSON.stringify(req.error));
    const hid = req.result.handoff_id;
    const h = await until(() => { b.w.tick(); const x = b.w.state.handoffs.get(hid); return ['done', 'failed', 'timed-out', 'cancelled'].includes(x.state) ? x : null; });
    assert.equal(h.state, 'done', JSON.stringify(h.error));
    assert.ok(['clean', 'warnings'].includes(h.critic_status), `${h.critic_status}: ${h.critic_reason}`);

    const run = JSON.parse(fs.readFileSync(capture, 'utf8'));
    assert.equal(run.env_probe.KUBECONFIG, '/fake/rw/kubeconfig', 'the run itself holds its scope credential');
    const critic = JSON.parse(fs.readFileSync(`${capture}.critic`, 'utf8'));
    // The guard is wired in, enforcing, with a grant of its own.
    const at = critic.args.indexOf('--settings');
    assert.ok(at >= 0, 'the critic gets the guard settings');
    assert.notEqual(critic.args[at + 1], run.args[run.args.indexOf('--settings') + 1], 'not the run\'s settings: its guard lines never land in the run ledger');
    assert.ok(critic.settings && critic.settings.hooks && critic.settings.hooks.PreToolUse, 'the guard hook');
    const grant = JSON.parse(critic.grant_text);
    assert.deepEqual([grant.access, grant.scopes, Object.keys(grant.permissions).filter((k) => grant.permissions[k])], ['autonomous', [], ['read_source']]);
    assert.equal(grant.writableRoots.includes(h.worktree_path), false, 'the checkout is not writable');
    // No scope credentials, and not the run's id (its guard reads its own directory).
    assert.notEqual(critic.env_probe.KUBECONFIG, '/fake/rw/kubeconfig');
    assert.equal(critic.env_probe.FAKE_RW_KUBECONFIG, null);
    assert.equal(critic.env_probe.QUILL_HANDOFF_SCOPES, '');
    assert.equal(critic.env_probe.QUILL_HANDOFF_GUARD, 'enforce');
    assert.notEqual(critic.env_probe.QUILL_HANDOFF_ID, hid);
    assert.doesNotMatch(JSON.stringify(critic), /fake\/rw\/kubeconfig/);
    // Its directory is gone once it ends; the run's own grant is untouched.
    assert.equal(fs.existsSync(handoffRunDir(b.w.env, critic.env_probe.QUILL_HANDOFF_ID)), false);
    assert.deepEqual(JSON.parse(run.grant_text).scopes.map((s) => s.name), ['k8s.write']);
  } finally { await b.w.stop(); }
});
