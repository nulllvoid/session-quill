import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Worker } from '../../src/worker/worker.js';
import { createStoreMeta, writeStoreMeta } from '../../src/config/store.js';
import { defaultUserConfig, saveUserConfig } from '../../src/config/config.js';
import { main } from '../../src/cli/main.js';

export const MACHINE = '22222222-2222-4222-8222-222222222222';

export function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'st-cli-'));
  const storePath = path.join(home, 'Quill');
  fs.mkdirSync(storePath, { recursive: true });
  const meta = createStoreMeta({ store_name: 'Quill', owner_machine_id: MACHINE, timezone: 'UTC' });
  writeStoreMeta(storePath, meta);
  fs.writeFileSync(path.join(home, 'machine.json'), JSON.stringify({ machine_id: MACHINE, machine_name: 'test' }));
  const env = { QUILL_HOME: home };
  const config = { ...defaultUserConfig(), store_path: storePath, default_project: 'demo', projects: { demo: { name: 'Demo', repo_id: 'demo' } }, repos: { demo: { project_id: 'demo', display_name: 'demo', default_branch: 'main', deployment_environments: ['production'] } } };
  saveUserConfig(config, env);
  return { home, storePath, meta, config, env };
}

export async function startWorker(fx, { derive } = {}) {
  const w = new Worker({ config: fx.config, storeMeta: fx.meta, env: fx.env, derive });
  await w.start();
  const timer = setInterval(() => { try { w.tick(); } catch (err) { console.error(err); } }, 20);
  return { worker: w, stop: async () => { clearInterval(timer); await w.stop(); } };
}

export async function cli(argv, env, { stdin = '' } = {}) {
  let out = '';
  let err = '';
  const code = await main(argv, { env, stdout: (s) => { out += s; }, stderr: (s) => { err += s; }, stdin: async () => stdin });
  return { code, out, err };
}

// A valid ticket description (ADR 0014) for tests that create tickets through the CLI.
export const DESC = '**Goal:** Exercise the ticket under test end to end.\n\n**Context:** Created by an automated test.\n\n**Done when:**\n- the test passes';

// Tests that let the CLI spawn a real background worker: a random dashboard port, so they never
// contend for the fixed one (or the user's own worker on it).
export function seedSpawnConfig(env) {
  fs.mkdirSync(env.QUILL_HOME, { recursive: true });
  const file = path.join(env.QUILL_HOME, 'config.toml');
  if (!fs.existsSync(file)) fs.writeFileSync(file, 'ui_port = 0\n');
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } };

// Cleanup for those tests: ask the worker to stop, then kill whatever pid this home's heartbeat
// or start attempt names if it is still alive after the deadline, so no test leaves one behind.
export async function stopSpawnedWorker(env, { deadlineMs = 6000 } = {}) {
  const read = (...p) => { try { return JSON.parse(fs.readFileSync(path.join(env.QUILL_HOME, ...p), 'utf8')); } catch { return null; } };
  const pids = new Set([read('state', 'heartbeat.json')?.pid, read('run', 'worker-start-attempt.json')?.pid].filter((p) => Number.isInteger(p) && p > 0 && p !== process.pid));
  try {
    if (fs.existsSync(path.join(env.QUILL_HOME, 'config.toml'))) await cli(['worker', 'stop'], env);
  } catch { /* fall through to the kill */ }
  const until = Date.now() + deadlineMs;
  while ([...pids].some(alive) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  for (const pid of pids) if (alive(pid)) { try { process.kill(pid); } catch { /* already gone */ } }
}
