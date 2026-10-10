import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { installAutostart, uninstallAutostart, autostartStatus, autostartMarkerPath, TASK_NAME, SYSTEMD_UNIT } from '../../src/worker/autostart.js';

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-autostart-'));
  return { env: { QUILL_HOME: path.join(dir, 'quill') }, home: path.join(dir, 'home') };
}

const NODE = '/usr/bin/node';
const BIN = '/opt/quill/bin/quill.js';

// A pretend OS: records every call and keeps the entries it would hold.
function fakeOs() {
  const calls = [];
  const tasks = new Map();
  const loaded = new Set();
  const enabled = new Set();
  const run = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'schtasks') {
      const name = args[args.indexOf('/TN') + 1];
      if (args[0] === '/Create') {
        const xml = fs.readFileSync(args[args.indexOf('/XML') + 1]);
        assert.equal(xml[0], 0xff, 'task XML is UTF-16LE with a BOM');
        tasks.set(name, xml.toString('utf16le'));
        return { code: 0, stdout: 'SUCCESS', stderr: '' };
      }
      if (args[0] === '/Query') return tasks.has(name) ? { code: 0, stdout: name, stderr: '' } : { code: 1, stdout: '', stderr: 'ERROR: The system cannot find the file specified.' };
      if (args[0] === '/Delete') return tasks.delete(name) ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: 'ERROR: not found' };
    }
    if (cmd === 'launchctl') {
      const plist = args[2];
      if (args[0] === 'bootstrap') { if (loaded.has(plist)) return { code: 5, stdout: '', stderr: 'already loaded' }; loaded.add(plist); return { code: 0, stdout: '', stderr: '' }; }
      if (args[0] === 'bootout') return loaded.delete(plist) ? { code: 0, stdout: '', stderr: '' } : { code: 3, stdout: '', stderr: 'no such process' };
    }
    if (cmd === 'systemctl') {
      if (args[1] === 'enable') { enabled.add(args[2]); return { code: 0, stdout: '', stderr: '' }; }
      if (args[1] === 'disable') return enabled.delete(args[2]) ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: 'not enabled' };
      return { code: 0, stdout: '', stderr: '' };
    }
    throw new Error(`unexpected command ${cmd}`);
  };
  return { run, calls, tasks, loaded, enabled };
}

test('Windows: a logon task launches node windowless through a generated .vbs; install twice keeps one task, uninstall twice succeeds', async () => {
  const t = tmp();
  const fake = fakeOs();
  const opts = { platform: 'win32', env: t.env, run: fake.run, nodePath: 'C:\\Program Files\\nodejs\\node.exe', binPath: 'C:\\quill\\bin\\quill.js', home: t.home, user: 'PC\\owner' };
  assert.equal(autostartStatus(t.env, { home: t.home }).installed, false);
  await installAutostart(opts);
  await installAutostart(opts);
  assert.equal(fake.tasks.size, 1);
  const xml = fake.tasks.get(TASK_NAME);
  assert.match(xml, /<LogonTrigger><UserId>PC\\owner<\/UserId><\/LogonTrigger>/);
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/, 'no administrator rights needed');
  assert.match(xml, /<Command>wscript\.exe<\/Command>/);
  const vbs = fs.readFileSync(path.join(t.env.QUILL_HOME, 'worker-login.vbs'), 'utf8');
  assert.match(vbs, /"""C:\\Program Files\\nodejs\\node\.exe"" ""C:\\quill\\bin\\quill\.js"" worker start", 0, False/);
  assert.match(vbs, /Environment\("Process"\)\("QUILL_HOME"\)/, 'a custom QUILL_HOME reaches the worker');
  assert.ok(fake.calls.every((c) => c.includes('/F') || c[1] !== '/Create'), 'create replaces in place');
  assert.equal(fs.existsSync(path.join(t.env.QUILL_HOME, 'worker-login-task.xml')), false, 'the task XML is not left behind');
  assert.equal(autostartStatus(t.env, { home: t.home }).installed, true);
  const first = await uninstallAutostart(opts);
  assert.equal(first.removed, true);
  assert.equal(fake.tasks.size, 0);
  const again = await uninstallAutostart(opts);
  assert.equal(again.removed, false, 'uninstall when absent is a success that changes nothing');
  assert.equal(fake.calls.filter((c) => c[1] === '/Delete').length, 1);
  assert.equal(fs.existsSync(path.join(t.env.QUILL_HOME, 'worker-login.vbs')), false);
  assert.equal(autostartStatus(t.env, { home: t.home }).installed, false);
});

test('macOS: a LaunchAgent that runs once at load with no keep-alive; install twice keeps one agent loaded', async () => {
  const t = tmp();
  const fake = fakeOs();
  const opts = { platform: 'darwin', env: t.env, run: fake.run, nodePath: NODE, binPath: BIN, home: t.home, uid: 501 };
  await installAutostart(opts);
  await installAutostart(opts);
  const plist = path.join(t.home, 'Library', 'LaunchAgents', 'com.session-quill.worker.plist');
  const text = fs.readFileSync(plist, 'utf8');
  assert.match(text, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(text, /<key>KeepAlive<\/key><false\/>/);
  assert.match(text, /<string>\/usr\/bin\/node<\/string><string>\/opt\/quill\/bin\/quill\.js<\/string><string>worker<\/string><string>start<\/string>/);
  assert.equal(fake.loaded.size, 1);
  assert.ok(fake.calls.some((c) => c[0] === 'launchctl' && c[1] === 'bootstrap' && c[2] === 'gui/501'));
  assert.equal(autostartStatus(t.env, { home: t.home }).installed, true);
  await uninstallAutostart(opts);
  assert.equal(fs.existsSync(plist), false);
  assert.equal(fake.loaded.size, 0);
  const calls = fake.calls.length;
  assert.equal((await uninstallAutostart(opts)).removed, false);
  assert.equal(fake.calls.length, calls, 'nothing to undo, nothing run');
});

test('Linux: a oneshot systemd user unit with no Restart=; install twice keeps one enabled unit', async () => {
  const t = tmp();
  const fake = fakeOs();
  const opts = { platform: 'linux', env: { ...t.env, XDG_CONFIG_HOME: path.join(t.home, 'cfg') }, run: fake.run, nodePath: NODE, binPath: BIN, home: t.home };
  await installAutostart(opts);
  await installAutostart(opts);
  const unit = path.join(t.home, 'cfg', 'systemd', 'user', SYSTEMD_UNIT);
  const text = fs.readFileSync(unit, 'utf8');
  assert.match(text, /Type=oneshot/);
  assert.match(text, /ExecStart="\/usr\/bin\/node" "\/opt\/quill\/bin\/quill\.js" worker start/);
  assert.doesNotMatch(text, /Restart=/);
  assert.equal(fake.enabled.size, 1);
  await uninstallAutostart(opts);
  assert.equal(fs.existsSync(unit), false);
  assert.equal(fake.enabled.size, 0);
  assert.equal((await uninstallAutostart(opts)).removed, false);
});

test('a failed OS call fails the install and records nothing', async () => {
  const t = tmp();
  const run = async () => ({ code: 1, stdout: '', stderr: 'ERROR: Access is denied.' });
  await assert.rejects(installAutostart({ platform: 'win32', env: t.env, run, nodePath: NODE, binPath: BIN, home: t.home, user: 'PC\\owner' }), /Access is denied/);
  assert.equal(fs.existsSync(autostartMarkerPath(t.env)), false);
  assert.equal(autostartStatus(t.env, { home: t.home }).installed, false);
});

test('a removed entry file reads as not installed even with the marker present', async () => {
  const t = tmp();
  const fake = fakeOs();
  const opts = { platform: 'linux', env: t.env, run: fake.run, nodePath: NODE, binPath: BIN, home: t.home };
  await installAutostart(opts);
  fs.rmSync(path.join(t.home, '.config', 'systemd', 'user', SYSTEMD_UNIT));
  assert.equal(autostartStatus(t.env, { home: t.home }).installed, false);
});

test('the health payload says whether the worker starts at login', async () => {
  const { captureHealth } = await import('../../src/worker/health.js');
  const { buildMeta } = await import('../../src/worker/projections.js');
  const t = tmp();
  const now = '2026-10-11T00:00:00Z';
  assert.equal(captureHealth(t.env, { now, backlog: [] }).autostart, false);
  fs.mkdirSync(path.dirname(autostartMarkerPath(t.env)), { recursive: true });
  fs.writeFileSync(autostartMarkerPath(t.env), JSON.stringify({ platform: 'win32', entry: 'Task Scheduler task', installed_at: now }));
  const capture = captureHealth(t.env, { now, backlog: [] });
  assert.equal(capture.autostart, true);
  const state = { tickets: new Map(), unresolved: [], meta: { sync_interval_hours: 2 } };
  assert.equal(buildMeta(state, { now, capture, worker_seen_at: now }).worker_autostart, true);
});
