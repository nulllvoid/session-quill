// MCP settings for autonomous runs (spec §4.2, ADR 0026), read from the user config only (`handoff`
// and `mcp_policy` are user-only fields, so a repository's .quill.toml cannot widen them):
//
//   [handoff]
//   trusted_mcp_servers = ["repo-db"]   # project (.mcp.json) servers an autonomous run may use
//
//   [mcp_policy]
//   read = ["mcp__kibana__query_logs"]  # tool names (or * patterns) classified as reads
//   [mcp_policy.write]
//   "mcp__argo__sync_app" = "argo.sync" # tool pattern → the scope ("name" or "name:target") that covers it
//
// Servers from claude.ai, the user's settings and plugins are trusted by source; anything else
// (project servers, or a server the run's init event did not list) only by name here. An invalid
// value is ignored with a warning that names the key, never the value.

const isTable = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const SERVER_NAME = /^[^\x00-\x1f\x7f]{1,200}$/;
const TOOL_PATTERN = /^mcp__[A-Za-z0-9_*.-]{1,200}$/;
const SCOPE = /^[a-z][a-z0-9._-]{0,63}(?::[A-Za-z0-9._/@-]{1,128})?$/;

export function mcpSettings(config = {}) {
  const warnings = [];
  const h = config && isTable(config.handoff) ? config.handoff : {};
  const p = config && isTable(config.mcp_policy) ? config.mcp_policy : {};

  const trusted = [];
  if (h.trusted_mcp_servers !== undefined) {
    if (!Array.isArray(h.trusted_mcp_servers)) warnings.push('[handoff] trusted_mcp_servers must be a list of server names; ignored');
    else h.trusted_mcp_servers.forEach((n, i) => {
      if (typeof n === 'string' && SERVER_NAME.test(n.trim())) { if (!trusted.includes(n.trim())) trusted.push(n.trim()); } else warnings.push(`[handoff] trusted_mcp_servers[${i}] is not a server name; ignored`);
    });
  }

  const read = [];
  if (p.read !== undefined) {
    if (!Array.isArray(p.read)) warnings.push('[mcp_policy] read must be a list of MCP tool names; ignored');
    else p.read.forEach((t, i) => {
      if (typeof t === 'string' && TOOL_PATTERN.test(t)) read.push(t); else warnings.push(`[mcp_policy] read[${i}] is not an MCP tool name; ignored`);
    });
  }
  const write = {};
  if (p.write !== undefined) {
    if (!isTable(p.write)) warnings.push('[mcp_policy] write must be a table of MCP tool name = "scope"; ignored');
    else for (const [t, scope] of Object.entries(p.write)) {
      if (!TOOL_PATTERN.test(t)) warnings.push('[mcp_policy.write] an entry is not an MCP tool name; ignored');
      else if (typeof scope !== 'string' || !SCOPE.test(scope)) warnings.push(`[mcp_policy.write] ${t} must name a scope such as "jira.write"; ignored`);
      else write[t] = scope;
    }
  }
  return { mcpPolicy: { read, write }, trustedMcpServers: trusted, warnings };
}
