import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline/promises';
import { loadUserConfig, saveUserConfig, saveRepoConfig, loadRepoConfig, CATEGORIES } from '../../config/config.js';
import { ensureMachineId, createStoreMeta, writeStoreMeta, loadStoreMeta, storeLayout } from '../../config/store.js';
import { isValidTimeZone } from '../../lib/time.js';
import { ensureDir } from '../../lib/atomic-fs.js';
import { trackerHome, ingressDir, blobsDir, stateDir, projectionsDir } from '../../lib/paths.js';
import { TrackerError } from '../../lib/errors.js';
import { collect, MIN_NODE_MAJOR } from './doctor.js';
import { commandName } from '../context.js';

async function ask(io, question, fallback) {
  if (!process.stdin.isTTY) return fallback;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question}${fallback !== undefined ? ` [${fallback}]` : ''}: `)).trim();
    return answer || fallback;
  } finally {
    rl.close();
  }
}

function slugId(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
}

export async function run({ flags, io, env }) {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < MIN_NODE_MAJOR) throw new TrackerError('node-unsupported', `Node ${process.versions.node} is unsupported; install Node >= ${MIN_NODE_MAJOR} LTS (Claude Code does not bundle Node)`);
  const cfg = loadUserConfig(env);
  const yes = flags.yes === true;
  const defaultStore = cfg.store_path || path.join(os.homedir(), 'Documents', 'Tracker');
  const storePath = path.resolve(flags.store ?? (yes ? defaultStore : await ask(io, 'Markdown store folder (plain folder or inside an Obsidian vault)', defaultStore)));
  const repoDir = path.resolve(flags.repo ?? process.cwd());
  const existingRepo = loadRepoConfig(repoDir) ?? {};
  const projectName = flags['project-name'] ?? (yes ? (existingRepo.project_name ?? path.basename(repoDir)) : await ask(io, 'Project name', existingRepo.project_name ?? path.basename(repoDir)));
  const projectId = flags.project ?? existingRepo.project_id ?? slugId(projectName);
  const timezone = flags.timezone ?? cfg.timezone;
  if (!isValidTimeZone(timezone)) throw new TrackerError('timezone-invalid', `invalid IANA time zone ${timezone}`);
  const category = flags.category ?? existingRepo.category ?? cfg.default_category;
  if (!CATEGORIES.includes(category)) throw new TrackerError('category-invalid', `category must be one of ${CATEGORIES.join(', ')}`);

  const machineId = ensureMachineId(env);
  for (const dir of [trackerHome(env), ingressDir(env), blobsDir(env), stateDir(env), projectionsDir(env)]) ensureDir(dir);
  ensureDir(storePath);
  let meta = loadStoreMeta(storePath);
  if (!meta) {
    meta = createStoreMeta({ store_name: flags['store-name'] ?? path.basename(storePath), owner_machine_id: machineId, timezone });
    writeStoreMeta(storePath, meta);
    io.println(`created store ${meta.store_name} (${meta.store_id}) at ${storePath}`);
  } else if (meta.owner_machine_id !== machineId) {
    io.println(`! store at ${storePath} is owned by machine ${meta.owner_machine_id}; this machine will have a read-only copy. Transfer ownership explicitly to write.`);
  } else {
    io.println(`using existing store ${meta.store_name} at ${storePath}`);
  }
  const layout = storeLayout(storePath);
  for (const dir of [layout.tickets, layout.sessions, layout.handoffs, layout.authored]) ensureDir(dir);

  const repoId = flags['repo-id'] ?? existingRepo.repo_id ?? projectId;
  cfg.store_path = storePath;
  cfg.store_name = meta.store_name;
  cfg.timezone = timezone;
  cfg.default_project = cfg.default_project || projectId;
  cfg.projects = { ...cfg.projects, [projectId]: { ...(cfg.projects[projectId] ?? {}), name: projectName, repo_id: repoId } };
  cfg.repos = { ...cfg.repos, [repoId]: { ...(cfg.repos[repoId] ?? {}), project_id: projectId, display_name: path.basename(repoDir), canonical_path: repoDir, default_branch: (cfg.repos[repoId] ?? {}).default_branch ?? 'main', deployment_environments: (cfg.repos[repoId] ?? {}).deployment_environments ?? ['production'] } };
  const cfgFile = saveUserConfig(cfg, env);
  io.println(`wrote user config ${cfgFile}`);
  if (fs.existsSync(repoDir)) {
    const repoCfg = { ...existingRepo, project_id: projectId, project_name: projectName, category, repo_id: repoId };
    const f = saveRepoConfig(repoDir, repoCfg);
    io.println(`wrote repository defaults ${f} (safe to commit; contains no secrets or ownership)`);
  }

  if (meta.owner_machine_id === machineId && flags['no-worker'] !== true) {
    const { startDetached, waitHealthy } = await import('./worker.js');
    const { isLocked } = await import('../../worker/lock.js');
    const ctx = { env, config: cfg, storeMeta: meta, machineId };
    if (!(await isLocked(meta.store_id, machineId, env))) {
      const pid = startDetached(ctx);
      const ok = await waitHealthy(ctx, 10_000);
      io.println(ok ? `worker started (pid ${pid}) and heartbeat verified` : `! worker spawned (pid ${pid}) but no heartbeat within 10 s; run tracker doctor`);
    } else {
      io.println('worker already running');
    }
  }
  const { report } = await collect(env);
  for (const item of report.items.filter((i) => i.level !== 'ok')) io.println(`${item.level === 'warn' ? '!' : '✗'} ${item.label}: ${item.detail}`);
  io.println('');
  io.println('Next steps:');
  io.println(`  1. Load the plugin in Claude Code (e.g. claude --plugin-dir <path-to-session-tracker>) and start a session in ${repoDir}.`);
  io.println(`  2. Create and bind a ticket: ${commandName('ticket')} create "<title>" --bind`);
  io.println('  3. Open the dashboard: tracker ui');
  io.println('To keep the worker running across reboots, register `tracker worker start` with your OS login items / Task Scheduler / systemd user service.');
  return report.ok ? 0 : 1;
}
