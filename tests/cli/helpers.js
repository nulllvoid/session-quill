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
  const storePath = path.join(home, 'Tracker');
  fs.mkdirSync(storePath, { recursive: true });
  const meta = createStoreMeta({ store_name: 'Tracker', owner_machine_id: MACHINE, timezone: 'UTC' });
  writeStoreMeta(storePath, meta);
  fs.writeFileSync(path.join(home, 'machine.json'), JSON.stringify({ machine_id: MACHINE, machine_name: 'test' }));
  const env = { TRACKER_HOME: home };
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
