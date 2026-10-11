// `quill worker install` / `uninstall` (ADR 0022): a per-user login entry that runs
// `quill worker start` once, with no admin rights and no OS keep-alive. Restarts after a crash stay
// with ensureReady's backoff in the hooks. Every OS call goes through `run`, so tests use fakes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { quillHome, stateDir, logsDir } from '../lib/paths.js';
import { readJsonIfExists, writeFileAtomic, writeJsonAtomic, removeIfExists } from '../lib/atomic-fs.js';
import { TrackerError } from '../lib/errors.js';

export const TASK_NAME = 'Session Quill worker (quill)';
export const LAUNCH_AGENT_LABEL = 'com.session-quill.worker';
export const SYSTEMD_UNIT = 'session-quill-worker.service';
const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'quill.js');

// Written by install and removed by uninstall; the worker reads only this, so the health payload
// and doctor never spawn an OS tool.
export function autostartMarkerPath(env) {
  return path.join(stateDir(env), 'autostart.json');
}

export function defaultRunner(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, encoding: 'utf8', timeout: 30_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout ?? '', stderr: stderr ?? (err ? err.message : '') });
    });
  });
}

const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const vbsStr = (s) => `"${String(s).replace(/"/g, '""')}"`;

function windowsPlan({ env, nodePath, binPath, user }) {
  const vbs = path.join(quillHome(env), 'worker-login.vbs');
  const xml = path.join(quillHome(env), 'worker-login-task.xml');
  // A windowless launch: wscript runs node hidden, so no console flashes at logon.
  const vbsText = [
    "' Session Quill: start the worker at logon without a console window (quill worker install).",
    'Set shell = CreateObject("WScript.Shell")',
    ...(env.QUILL_HOME ? [`shell.Environment("Process")("QUILL_HOME") = ${vbsStr(path.resolve(env.QUILL_HOME))}`] : []),
    `shell.Run ${vbsStr(`"${nodePath}" "${binPath}" worker start`)}, 0, False`,
    '',
  ].join('\r\n');
  // A logon trigger for this user with an interactive token needs no administrator rights.
  const taskXml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Starts the Session Quill worker at logon (quill worker start).</Description></RegistrationInfo>
  <Principals><Principal id="Author"><UserId>${xmlEsc(user)}</UserId><LogonType>InteractiveToken</LogonType></Principal></Principals>
  <Settings>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
  </Settings>
  <Triggers><LogonTrigger><UserId>${xmlEsc(user)}</UserId></LogonTrigger></Triggers>
  <Actions Context="Author"><Exec><Command>wscript.exe</Command><Arguments>"${xmlEsc(vbs)}"</Arguments></Exec></Actions>
</Task>
`;
  return {
    platform: 'win32',
    entry: `Task Scheduler task "${TASK_NAME}"`,
    // Both files are UTF-16LE with a BOM: wscript reads a BOM-less .vbs in the ANSI code page, which
    // would garble a profile path outside ASCII.
    files: [{ path: vbs, content: `﻿${vbsText}`, encoding: 'utf16le' }, { path: xml, content: `﻿${taskXml}`, encoding: 'utf16le', transient: true }],
    install: [['schtasks', ['/Create', '/TN', TASK_NAME, '/XML', xml, '/F']]],
    uninstall: [['schtasks', ['/Delete', '/TN', TASK_NAME, '/F']]],
    query: ['schtasks', ['/Query', '/TN', TASK_NAME]],
  };
}

// launchd and systemd start login entries with a minimal PATH, so `claude` (and git) installed
// under Homebrew, nvm or ~/.local would not resolve; the entry keeps the PATH of the install.
function loginEnv(env) {
  const out = {};
  const PATH = env.PATH ?? env.Path ?? process.env.PATH;
  if (PATH) out.PATH = PATH;
  if (env.QUILL_HOME) out.QUILL_HOME = path.resolve(env.QUILL_HOME);
  return out;
}

function darwinPlan({ env, nodePath, binPath, home, uid }) {
  const plist = path.join(home, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);
  const vars = Object.entries(loginEnv(env));
  const envBlock = vars.length ? `  <key>EnvironmentVariables</key>\n  <dict>${vars.map(([k, v]) => `<key>${k}</key><string>${xmlEsc(v)}</string>`).join('')}</dict>\n` : '';
  const text = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xmlEsc(nodePath)}</string><string>${xmlEsc(binPath)}</string><string>worker</string><string>start</string></array>
${envBlock}  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>StandardOutPath</key><string>${xmlEsc(path.join(logsDir(env), 'worker-login.log'))}</string>
  <key>StandardErrorPath</key><string>${xmlEsc(path.join(logsDir(env), 'worker-login.log'))}</string>
</dict>
</plist>
`;
  const domain = `gui/${uid}`;
  return {
    platform: 'darwin',
    entry: `LaunchAgent ${plist}`,
    entryFile: plist,
    files: [{ path: plist, content: text }],
    // bootout first so a second install replaces the loaded agent instead of failing.
    install: [['launchctl', ['bootout', domain, plist], { ignoreFailure: true }], ['launchctl', ['bootstrap', domain, plist]]],
    uninstall: [['launchctl', ['bootout', domain, plist], { ignoreFailure: true }]],
    query: null,
  };
}

function linuxPlan({ env, nodePath, binPath, home }) {
  const configHome = env.XDG_CONFIG_HOME ? path.resolve(env.XDG_CONFIG_HOME) : path.join(home, '.config');
  const unit = path.join(configHome, 'systemd', 'user', SYSTEMD_UNIT);
  // Quoted for systemd: backslash and quote escaped, `%` doubled (specifiers apply to both
  // settings) and, in ExecStart= only, `$` doubled (Environment= does no variable expansion).
  const q = (s, { exec = false } = {}) => {
    let v = String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%');
    if (exec) v = v.replace(/\$/g, '$$$$');
    return `"${v}"`;
  };
  // oneshot: run `worker start` once at login. No Restart=; recovery stays with ensureReady.
  const text = [
    '[Unit]',
    'Description=Session Quill worker (quill worker start)',
    '',
    '[Service]',
    'Type=oneshot',
    'RemainAfterExit=yes',
    ...Object.entries(loginEnv(env)).map(([k, v]) => `Environment=${q(`${k}=${v}`)}`),
    `ExecStart=${q(nodePath, { exec: true })} ${q(binPath, { exec: true })} worker start`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
  return {
    platform: 'linux',
    entry: `systemd user unit ${unit}`,
    entryFile: unit,
    files: [{ path: unit, content: text }],
    install: [['systemctl', ['--user', 'daemon-reload']], ['systemctl', ['--user', 'enable', SYSTEMD_UNIT]]],
    uninstall: [['systemctl', ['--user', 'disable', SYSTEMD_UNIT], { ignoreFailure: true }], ['systemctl', ['--user', 'daemon-reload'], { ignoreFailure: true, after: true }]],
    query: null,
  };
}

export function autostartPlan({ platform = process.platform, env = process.env, nodePath = process.execPath, binPath = BIN, home = os.homedir(), user = null, uid = null } = {}) {
  if (platform === 'win32') return windowsPlan({ env, nodePath, binPath, user: user ?? (process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${os.userInfo().username}` : os.userInfo().username) });
  if (platform === 'darwin') return darwinPlan({ env, nodePath, binPath, home, uid: uid ?? (typeof process.getuid === 'function' ? process.getuid() : 501) });
  if (platform === 'linux') return linuxPlan({ env, nodePath, binPath, home });
  throw new TrackerError('unsupported-platform', `starting the worker at login is not supported on ${platform}; start it with quill worker start`);
}

async function runAll(steps, run) {
  for (const [cmd, args, opts = {}] of steps) {
    const r = await run(cmd, args);
    if (r.code !== 0 && !opts.ignoreFailure) throw new TrackerError('autostart-failed', `${cmd} ${args[0]} failed: ${(r.stderr || r.stdout || `exit code ${r.code}`).trim().split('\n')[0]}`);
  }
}

// Install is idempotent: files are rewritten, the OS entry is replaced in place (/F, bootout
// before bootstrap, enable), so a second install still leaves exactly one entry.
export async function installAutostart({ env = process.env, run = defaultRunner, now = new Date().toISOString(), ...opts } = {}) {
  const plan = autostartPlan({ env, ...opts });
  for (const f of plan.files) {
    if (f.encoding) { fs.mkdirSync(path.dirname(f.path), { recursive: true }); fs.writeFileSync(f.path, Buffer.from(f.content, f.encoding)); } else writeFileAtomic(f.path, f.content);
  }
  try {
    await runAll(plan.install, run);
  } finally {
    for (const f of plan.files) if (f.transient) removeIfExists(f.path);
  }
  writeJsonAtomic(autostartMarkerPath(env), { platform: plan.platform, entry: plan.entry, installed_at: now });
  return plan;
}

// Uninstall when nothing is installed succeeds and changes nothing.
export async function uninstallAutostart({ env = process.env, run = defaultRunner, ...opts } = {}) {
  const plan = autostartPlan({ env, ...opts });
  let removed = false;
  if (plan.query) {
    if ((await run(...plan.query)).code === 0) { await runAll(plan.uninstall, run); removed = true; }
  } else if (fs.existsSync(plan.entryFile)) {
    await runAll(plan.uninstall.filter(([, , o = {}]) => !o.after), run);
    removeIfExists(plan.entryFile);
    await runAll(plan.uninstall.filter(([, , o = {}]) => o.after), run);
    removed = true;
  }
  for (const f of plan.files) removeIfExists(f.path);
  removed = removeIfExists(autostartMarkerPath(env)) || removed;
  return { plan, removed };
}

// `quill doctor` only: autostartStatus, plus asking Task Scheduler on Windows whether the task
// install registered still exists (it has no entry file to check). Hot paths stay marker-only.
export async function verifyAutostart(env = process.env, { platform = process.platform, run = defaultRunner, home = os.homedir() } = {}) {
  const status = autostartStatus(env, { home });
  const marker = readJsonIfExists(autostartMarkerPath(env));
  if (!status.installed || !marker || marker.platform !== 'win32' || platform !== 'win32') return status;
  const r = await run('schtasks', ['/Query', '/TN', TASK_NAME]);
  if (r.code === 0) return status;
  return { installed: false, entry: marker.entry, missing: true, detail: `marker present but task missing (${TASK_NAME})` };
}

// What install recorded, checked against the entry file where there is one. No OS tool runs.
export function autostartStatus(env = process.env, { home = os.homedir() } = {}) {
  const marker = readJsonIfExists(autostartMarkerPath(env));
  if (!marker) return { installed: false, entry: null };
  if (marker.platform !== 'win32') {
    try {
      const plan = autostartPlan({ platform: marker.platform, env, home });
      if (plan.entryFile && !fs.existsSync(plan.entryFile)) return { installed: false, entry: marker.entry, missing: true };
    } catch { /* unsupported platform: trust the marker */ }
  }
  return { installed: true, entry: marker.entry, installed_at: marker.installed_at ?? null };
}
