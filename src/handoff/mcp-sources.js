// Which configuration each MCP server of a run came from (ruling R20). The stream collector writes
// `<runDir>/mcp-servers.json` ({ "<server name>": "<source>" }) from the run's init event, and the
// guard (bin/quill-guard.js) reads it on every MCP call: a server from claude.ai, the user's
// settings or a plugin is trusted by source; a project server, or one the file does not list, only
// when the grant names it. Node built-ins only, because the guard loads this on every tool call.
import fs from 'node:fs';
import path from 'node:path';

export const MCP_SERVERS_FILE = 'mcp-servers.json';
const NAME_MAX = 200;
const SOURCE_MAX = 40;
const MAX_SERVERS = 200;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clean = (v, max) => (typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, max) : '');

/** `{ <server name>: <source> }` from an init event (`mcp_servers`) or a parsed inventory (`mcpServers`); servers without a source are left out. */
export function mcpServerSources(initOrInventory) {
  const list = isPlainObject(initOrInventory) ? (initOrInventory.mcp_servers ?? initOrInventory.mcpServers) : null;
  const out = {};
  for (const s of Array.isArray(list) ? list.slice(0, MAX_SERVERS) : []) {
    if (!isPlainObject(s)) continue;
    const name = clean(s.name, NAME_MAX);
    const source = clean(s.source, SOURCE_MAX);
    if (name && source && !Object.hasOwn(out, name)) out[name] = source;
  }
  return out;
}

/** Writes the sources of `initEvent` to `file`, replacing it atomically (owner-only where the OS has modes). */
export function writeMcpServersFile(file, initEvent) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(mcpServerSources(initEvent))}\n`, { mode: 0o600 });
  try { fs.renameSync(tmp, file); } catch (err) { try { fs.unlinkSync(tmp); } catch { /* best effort */ } throw err; }
  return file;
}

// The server part of a tool name as Claude Code spells it: characters outside [A-Za-z0-9_-]
// become `_` ("claude.ai Gmail" → mcp__claude_ai_Gmail__…).
const toolForm = (name) => name.replace(/[^A-Za-z0-9_-]/g, '_');

/**
 * The source of the server an `mcp__<server>__<tool>` call goes to, from the run's sources file.
 * `mcp__a__b__c` can split at either `__`: readings the file does not list are not servers of
 * this run, and when several are listed the least trusted source wins. Returns 'unknown' when the
 * file is missing or unreadable or lists no reading, so the guard trusts nothing it cannot place.
 */
export function sourceOfTool(toolName, file, trusted = ['claudeai', 'user', 'plugin']) {
  let map;
  try { map = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return 'unknown'; }
  if (!isPlainObject(map)) return 'unknown';
  const byForm = new Map();
  for (const [name, source] of Object.entries(map)) {
    if (typeof source !== 'string') continue;
    const form = toolForm(name);
    // Two servers that spell to the same tool form: the less trusted one decides.
    if (!byForm.has(form) || !trusted.includes(source)) byForm.set(form, source);
  }
  const body = String(toolName ?? '').slice('mcp__'.length);
  const readings = [];
  for (let i = body.indexOf('__'); i >= 0; i = body.indexOf('__', i + 1)) if (i > 0 && i + 2 < body.length) readings.push(body.slice(0, i));
  if (!readings.length) return 'unknown';
  let result = null;
  for (const r of readings) {
    const source = byForm.get(r);
    if (source === undefined) continue;
    if (result === null || !trusted.includes(source)) result = source;
  }
  return result ?? 'unknown';
}
