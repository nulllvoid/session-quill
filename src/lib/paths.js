import os from 'node:os';
import path from 'node:path';

export function trackerHome(env = process.env) {
  return env.TRACKER_HOME ? path.resolve(env.TRACKER_HOME) : path.join(os.homedir(), '.claude', 'tracker');
}

export const configPath = (env) => path.join(trackerHome(env), 'config.toml');
export const machinePath = (env) => path.join(trackerHome(env), 'machine.json');
export const ingressDir = (env) => path.join(trackerHome(env), 'ingress');
export const journalPath = (env) => path.join(trackerHome(env), 'events.jsonl');
export const blobsDir = (env) => path.join(trackerHome(env), 'blobs');
export const stateDir = (env) => path.join(trackerHome(env), 'state');
export const projectionsDir = (env) => path.join(trackerHome(env), 'projections');
export const runDir = (env) => path.join(trackerHome(env), 'run');
export const handoffsDir = (env) => path.join(trackerHome(env), 'handoffs');
export const logsDir = (env) => path.join(trackerHome(env), 'logs');
export const healthErrorsPath = (env) => path.join(stateDir(env), 'health-errors.jsonl');
export const heartbeatPath = (env) => path.join(stateDir(env), 'heartbeat.json');
export const bindingsDir = (env) => path.join(stateDir(env), 'bindings');
export const requestsDir = (env) => path.join(stateDir(env), 'requests');

export function hostPlansDir(env = process.env) {
  return env.CLAUDE_PLANS_DIR ? path.resolve(env.CLAUDE_PLANS_DIR) : path.join(os.homedir(), '.claude', 'plans');
}
