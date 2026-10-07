import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHome, startWorker, cli } from './helpers.js';
import { markTicketWork, shouldCheckDone, markDoneChecked, isWorkTool, DONE_CHECK_INTERVAL_MS } from '../../src/hooks/nudge.js';

const DESC = '**Goal:** Delete the leftover helper script.\n\n**Context:** It patched README.md once.\n\n**Done when:**\n- old-helper.cjs no longer exists\n- the README still builds';
const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('condition not met in time'); await new Promise((r) => setTimeout(r, 50)); }
};

async function setup({ repo = 'none', description = DESC } = {}) {
  const fx = makeHome();
  const w = await startWorker(fx);
  const session = 'done-check-session';
  const created = await cli(['ticket', 'create', 'Delete the helper', '--description', description, '--project', 'demo', '--bind', '--session', session], fx.env);
  assert.equal(created.code, 0, created.err);
  const key = /((?:DEV|FEAT|FIX)-\d+)/.exec(created.out)[1];
  if (repo === 'none') assert.equal((await cli(['ticket', 'set', key, '--repo', 'none'], fx.env)).code, 0);
  const hook = async (event, extra = {}) => {
    const r = await cli(['hook', event], fx.env, { stdin: JSON.stringify({ session_id: session, hook_event_name: event, cwd: process.cwd(), ...extra }) });
    return r.out ? JSON.parse(r.out) : null;
  };
  const work = (tool = 'Bash') => hook('PostToolUse', { tool_name: tool, tool_use_id: `t-${Math.random()}`, tool_input: { command: 'rm old-helper.cjs' }, tool_response: { stdout: '' } });
  const stop = (extra = {}) => hook('Stop', { last_assistant_message: 'Deleted the file.', ...extra });
  // The binding snapshot carries the repository and status once the worker has applied the edits.
  const snapshot = async () => JSON.parse((await cli(['ticket', 'show', '--session', session, '--json'], fx.env)).out).binding;
  await until(async () => { const b = await snapshot(); return b.ticket_key === key && (repo !== 'none' || b.ticket_repo_id === null) && b.ticket_status; });
  return { fx, w, key, work, stop, snapshot };
}

test('after a working turn on a repo-less ticket, Claude is asked once to check its Done when items', async () => {
  const s = await setup();
  try {
    await s.work();
    const first = await s.stop();
    assert.equal(first.decision, 'block');
    assert.match(first.reason, new RegExp(`${s.key} has no repository`));
    assert.match(first.reason, /- old-helper\.cjs no longer exists\n- the README still builds/);
    assert.match(first.reason, new RegExp(`ticket set ${s.key} --status review`));
    assert.equal(await s.stop({ stop_hook_active: true }), null, 'never re-fires on its own follow-up');
    await s.work();
    assert.equal(await s.stop(), null, 'not again within the quiet period, even after more work');
  } finally { await s.w.stop(); }
});

test('no check after a read-only turn, on a repository ticket, or once the ticket is in review', async () => {
  const readOnly = await setup();
  try {
    await readOnly.work('Read');
    assert.equal(await readOnly.stop(), null, 'reading is not work');
    await readOnly.work();
    assert.equal((await cli(['ticket', 'set', readOnly.key, '--status', 'review'], readOnly.fx.env)).code, 0);
    await until(async () => (await readOnly.snapshot()).ticket_status === 'review');
    assert.equal(await readOnly.stop(), null, 'a ticket already in review is not asked about');
  } finally { await readOnly.w.stop(); }
  const withRepo = await setup({ repo: 'keep' });
  try {
    await withRepo.work();
    assert.equal(await withRepo.stop(), null, 'PRs move repository tickets');
  } finally { await withRepo.w.stop(); }
});

test('the check repeats only after new work and the quiet period; read tools never arm it', () => {
  const env = { QUILL_HOME: makeHome().env.QUILL_HOME };
  const t0 = '2026-10-07T10:00:00Z';
  assert.equal(shouldCheckDone('k', env, 'T', t0), false, 'nothing armed yet');
  markTicketWork('k', env, 'T', t0);
  assert.equal(shouldCheckDone('k', env, 'T', t0), true);
  markDoneChecked('k', env, 'T', t0);
  markTicketWork('k', env, 'T', t0);
  assert.equal(shouldCheckDone('k', env, 'T', '2026-10-07T10:10:00Z'), false);
  assert.equal(shouldCheckDone('k', env, 'T', new Date(Date.parse(t0) + DONE_CHECK_INTERVAL_MS).toISOString()), true);
  assert.equal(shouldCheckDone('k', env, 'OTHER', t0), false, 'work on another ticket does not count');
  assert.deepEqual(['Read', 'Grep', 'Bash', 'Edit', 'PowerShell'].map(isWorkTool), [false, false, true, true, true]);
});
