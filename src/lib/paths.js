import os from 'node:os';
import path from 'node:path';

export function quillHome(env = process.env) {
  return env.QUILL_HOME ? path.resolve(env.QUILL_HOME) : path.join(os.homedir(), '.claude', 'quill');
}

export const configPath = (env) => path.join(quillHome(env), 'config.toml');
export const machinePath = (env) => path.join(quillHome(env), 'machine.json');
export const ingressDir = (env) => path.join(quillHome(env), 'ingress');
export const journalPath = (env) => path.join(quillHome(env), 'events.jsonl');
export const blobsDir = (env) => path.join(quillHome(env), 'blobs');
export const stateDir = (env) => path.join(quillHome(env), 'state');
export const projectionsDir = (env) => path.join(quillHome(env), 'projections');
export const runDir = (env) => path.join(quillHome(env), 'run');
export const handoffsDir = (env) => path.join(quillHome(env), 'handoffs');
export const logsDir = (env) => path.join(quillHome(env), 'logs');
export const healthErrorsPath = (env) => path.join(stateDir(env), 'health-errors.jsonl');
export const heartbeatPath = (env) => path.join(stateDir(env), 'heartbeat.json');
export const bindingsDir = (env) => path.join(stateDir(env), 'bindings');
export const requestsDir = (env) => path.join(stateDir(env), 'requests');

export function hostPlansDir(env = process.env) {
  return env.CLAUDE_PLANS_DIR ? path.resolve(env.CLAUDE_PLANS_DIR) : path.join(os.homedir(), '.claude', 'plans');
}
