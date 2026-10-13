// What a run's Claude Code reported about itself (spec §5.4, ruling R6), the runtime version gate
// for autonomous runs (spec §3, ADR 0026) and the machine summary the Run dialog shows (spec §8).
//
// The init event (`system/init` of stream-json) lists the tools, MCP servers with their status and
// source, plugins, skills and `claude_code_version`. The run keeps a capped copy of the names, so
// the dialog can say which connectors the next run will find and which it will not trust. Plugin
// paths and anything else local are dropped. The guard reads the server sources from
// `<runDir>/mcp-servers.json`, which the stream collector writes as soon as init arrives (R20).
import path from 'node:path';
import { TrackerError } from '../lib/errors.js';
import { credentialSettings } from '../config/credentials.js';
import { mcpSettings } from '../config/mcp-policy.js';
import { MCP_SERVERS_FILE, mcpServerSources, writeMcpServersFile } from './mcp-sources.js';

export { MCP_SERVERS_FILE, mcpServerSources };

// `onFailure: "block"` on the guard hook needs this Claude Code release (spec §3, research 03 P0).
export const MIN_RUNTIME = '2.1.295';

const CAPS = { tools: 500, mcpServers: 200, plugins: 100, skills: 300 };
const NAME_MAX = 200;
const WORD_MAX = 40;

const oneLine = (v, max) => (typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, max) : '');
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function names(list, max) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    const n = oneLine(typeof item === 'string' ? item : isPlainObject(item) ? item.name : '', NAME_MAX);
    if (n) out.push(n);
    if (out.length >= max) break;
  }
  return out;
}

/** `[major, minor, patch]` from the first x.y.z in the text, else null. */
export function parseVersion(text) {
  const m = typeof text === 'string' ? /(\d+)\.(\d+)\.(\d+)/.exec(text) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compare(a, b) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/**
 * Refuses a Claude Code too old for autonomous runs, or one whose version cannot be read: the
 * guard hook depends on `onFailure: "block"`, so an unknown runtime fails closed.
 * @returns {string} the version as x.y.z
 * @throws {TrackerError} `runtime-too-old`
 */
export function assertRuntime(versionString, min = MIN_RUNTIME) {
  const v = parseVersion(versionString);
  const floor = parseVersion(min);
  if (!v || !floor || compare(v, floor) < 0) {
    const found = v ? v.join('.') : 'an unknown version';
    throw new TrackerError('runtime-too-old', `Claude Code ${found} is older than ${min}, which autonomous runs need (the guard hook must block a call when it fails). Update Claude Code, or queue the run again with standard access.`);
  }
  return v.join('.');
}

/**
 * The inventory a run's init event reports: names, statuses and sources only, capped.
 * @returns {{ tools: string[], mcpServers: { name: string, status: string|null, source: string|null }[], plugins: string[], skills: string[], version: string|null, counts: { tools: number, mcpServers: number, plugins: number, skills: number } }}
 */
export function parseInit(initEvent) {
  const e = isPlainObject(initEvent) ? initEvent : {};
  const mcpServers = [];
  for (const s of Array.isArray(e.mcp_servers) ? e.mcp_servers : []) {
    if (!isPlainObject(s)) continue;
    const name = oneLine(s.name, NAME_MAX);
    if (!name) continue;
    mcpServers.push({ name, status: oneLine(s.status, WORD_MAX) || null, source: oneLine(s.source, WORD_MAX) || null });
    if (mcpServers.length >= CAPS.mcpServers) break;
  }
  const v = parseVersion(typeof e.claude_code_version === 'string' ? e.claude_code_version : null);
  const total = (list) => (Array.isArray(list) ? list.length : 0);
  // The lists are capped; the counts say how many the runtime reported, so a cut shows.
  const counts = { tools: total(e.tools), mcpServers: total(e.mcp_servers), plugins: total(e.plugins), skills: total(e.skills) };
  return { tools: names(e.tools, CAPS.tools), mcpServers, plugins: names(e.plugins, CAPS.plugins), skills: names(e.skills, CAPS.skills), version: v ? v.join('.') : null, counts };
}

const handoffList = (state) => {
  const h = state && state.handoffs;
  if (h instanceof Map) return [...h.values()];
  return Array.isArray(h) ? h : [];
};
const later = (a, b) => (String(a ?? '') > String(b ?? ''));

/** The most recently recorded run inventory, with the run it came from; null when none. */
export function latestInventory(state) {
  let best = null;
  for (const h of handoffList(state)) {
    if (!h || !isPlainObject(h.inventory)) continue;
    const at = h.inventory.at ?? h.started_at ?? h.requested_at;
    if (!best || later(at, best.at)) best = { ...h.inventory, run_id: h.id, at: at ?? null };
  }
  return best;
}

/** Writes `<dir>/mcp-servers.json` for the guard (R20); returns its path. */
export function writeMcpServers(dir, initEvent) {
  return writeMcpServersFile(path.join(dir, MCP_SERVERS_FILE), initEvent);
}

// Which credential system each `[prod.readonly]` key configures (cred-env.js report names).
const READONLY_SYSTEMS = [['kubeconfig', 'kubernetes'], ['aws_profile', 'aws'], ['gcloud_config', 'gcp'], ['google_application_credentials', 'gcp'], ['azure_config_dir', 'azure'], ['db_env', 'databases'], ['argocd_env', 'argo']];

/**
 * What the Run dialog shows about autonomous runs on this machine (snapshot meta.autonomy; never
 * exported): the latest init inventory, the latest autonomous run's credential report (Task 9
 * `report`, as recorded at its dispatch), which read-only profiles the config names (system names
 * only, never paths or values), and the trusted project MCP servers.
 */
export function autonomyInfo(state, config = {}) {
  let credentials = null;
  for (const h of handoffList(state)) {
    if (!h || h.access !== 'autonomous' || !isPlainObject(h.cred_report)) continue;
    const at = h.started_at ?? h.requested_at ?? null;
    if (!credentials || later(at, credentials.at)) credentials = { report: h.cred_report, run_id: h.id, at };
  }
  const { readonly } = credentialSettings(config);
  const configured = [];
  for (const [key, system] of READONLY_SYSTEMS) if (readonly[key] !== undefined && !configured.includes(system)) configured.push(system);
  return { inventory: latestInventory(state), credentials, readonly_configured: configured, trusted_mcp_servers: mcpSettings(config).trustedMcpServers, min_runtime: MIN_RUNTIME };
}
