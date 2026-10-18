// Privacy-preserving projection for shared/offline snapshots (TRD §Local dashboard; PRD NFR Privacy):
// no local paths, credentials, content references, request state or mutation capabilities.

export const DEFAULT_FIELDS = ['key', 'title', 'status', 'category', 'priority', 'next_action', 'blocker', 'due', 'last_activity', 'stale', 'prs', 'deployments', 'children_ids', 'jira', 'external'];
export const SELECTABLE_FIELDS = ['key', 'title', 'status', 'category', 'priority', 'next_action', 'blocker', 'due', 'last_activity', 'stale', 'tags', 'prs', 'deployments', 'files_touched_count', 'plans_count', 'children_ids', 'summary', 'timeline', 'files_touched', 'conclusions', 'plans', 'aliases', 'jira', 'external'];
const ALWAYS = ['schema_version', 'id', 'revision', 'created_at', 'updated_at', 'project_id', 'project_name', 'parent_id', 'children_done_count', 'validation_issues', 'session_ids', 'handoff_ids', 'repo_id', 'status_source'];

// Any absolute path: Windows drive paths, UNC paths, `~/…`, and POSIX paths with at least one
// directory segment. URLs survive because their slashes follow `:` or another `/`; relative paths
// like `src/a.js` and ratios like `1/2` survive because their `/` follows a word character.
const ABS_PATH_RE = /(?:[A-Za-z]:\\(?:[^\\\s"'<>|]+\\?)+|\\\\[^\s"'<>|]+|~\/[^\s"'<>|]*|(?<![\w:/.~])\/(?:[^\s"'<>|/]+\/)+[^\s"'<>|/]*)/g;
const INTERNAL_URI_RE = /quill:\/\/[^\s)]*/g;

export function redactText(value) {
  if (typeof value !== 'string') return value;
  return value.replace(ABS_PATH_RE, '[path redacted]').replace(INTERNAL_URI_RE, '[internal link removed]');
}

function redactDeep(value) {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v);
    return out;
  }
  return value;
}

function parseList(value, fallback) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === 'string' && value.trim()) return value.split(',').map((s) => s.trim()).filter(Boolean);
  return fallback;
}

export function normalizeOptions(opts = {}) {
  const fields = parseList(opts.fields, DEFAULT_FIELDS).filter((f) => SELECTABLE_FIELDS.includes(f));
  const projects = parseList(opts.projects, null);
  const truthy = (v) => v === true || v === '1' || v === 'true';
  return {
    fields: fields.length ? fields : DEFAULT_FIELDS,
    projects: projects && projects.length ? projects : null,
    includeLinks: truthy(opts.includeLinks ?? opts.include_links),
    includeCheckpoints: truthy(opts.includeCheckpoints ?? opts.include_checkpoints),
    exportedAt: opts.exportedAt ?? opts.exported_at ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

function sanitizePr(pr, { includeLinks }) {
  const { url, evidence_id, ...rest } = pr;
  return includeLinks ? { ...rest, url } : rest;
}

function sanitizeTicket(t, o) {
  const out = {};
  for (const k of ALWAYS) if (k in t) out[k] = t[k];
  for (const f of o.fields) {
    if (!(f in t)) continue;
    if (f === 'prs') out.prs = (t.prs ?? []).map((p) => sanitizePr(p, o));
    else if (f === 'deployments') {
      out.deployments = (t.deployments ?? []).map(({ source_event_id, evidence, ...d }) => ({ ...d, evidence: o.includeLinks ? evidence : (evidence ? '[evidence omitted]' : null) }));
      out.environments = (t.environments ?? []).map(({ evidence, ...e }) => ({ ...e, evidence: o.includeLinks ? evidence ?? null : (evidence ? '[evidence omitted]' : null) }));
    }
    else if (f === 'timeline') out.timeline = (t.timeline ?? []).map(({ content_ref, event_id, ...e }) => e);
    else if (f === 'plans') out.plans = (t.plans ?? []).map(({ content_ref, preview, ...p }) => (o.includeCheckpoints ? { ...p, preview } : p));
    else if (f === 'conclusions') out.conclusions = (t.conclusions ?? []).map(({ content_ref, preview, ...c }) => (o.includeCheckpoints ? { ...c, preview } : c));
    // The parsed description travels only with the summary it comes from (ADR 0014).
    else if (f === 'summary') { out.summary = t.summary; if (t.description) out.description = t.description; }
    else if (f === 'jira') out.jira = t.jira ? (o.includeLinks ? { ...t.jira } : (({ url, ...j }) => j)(t.jira)) : null;
    // Remote tracker data (assignees, fix versions) stays on the owner's dashboard (ADR 0011).
    else if (f === 'external') out.external = t.external ? (({ remote, ...x }) => (o.includeLinks ? x : (({ url, ...y }) => y)(x)))(t.external) : null;
    else if (f === 'files_touched') out.files_touched = (t.files_touched ?? []).map((x) => ({ repo_id: x.repo_id, relative_path: x.relative_path, first_seen: x.first_seen, last_seen: x.last_seen }));
    else out[f] = t[f];
  }
  // Run notes and the critical-change spec are owner-only, whatever fields were selected.
  delete out.run_notes;
  delete out.critical_spec;
  if (!('files_touched_count' in out)) out.files_touched_count = t.files_touched_count;
  if (!('plans_count' in out)) out.plans_count = t.plans_count;
  return out;
}

// Relationship references to a local-only ticket would leak its id; remove them (and nothing else).
function hideLinks(t, hidden) {
  if (!hidden.size) return t;
  const out = { ...t };
  if (Array.isArray(out.children_ids)) out.children_ids = out.children_ids.filter((id) => !hidden.has(id));
  if (Array.isArray(out.handoff_ids)) out.handoff_ids = out.handoff_ids.filter((id) => !hidden.has(id));
  if (hidden.has(out.parent_id)) out.parent_id = null;
  return out;
}

function dropHidden(s, hidden) {
  if (!hidden.size) return s;
  return {
    ...s,
    ticket_ids: (s.ticket_ids ?? []).filter((id) => !hidden.has(id)),
    current_ticket_id: hidden.has(s.current_ticket_id) ? null : s.current_ticket_id,
    bindings: (s.bindings ?? []).filter((b) => !hidden.has(b.ticket_id)),
  };
}

function sanitizeSession(s, o) {
  const keep = ['id', 'host_session_id', 'agent_id', 'machine_name', 'state', 'started_at', 'ended_at', 'last_event_at', 'successful_write_count', 'change_coverage', 'ticket_ids', 'current_ticket_id', 'current_binding_revision', 'unpromoted', 'gate_enabled', 'project_ids'];
  const out = {};
  for (const k of keep) if (k in s) out[k] = s[k];
  out.bindings = (s.bindings ?? []).map(({ source_event_id, ...b }) => b);
  if (o.includeCheckpoints) out.last_checkpoint_preview = s.last_checkpoint_preview ?? '';
  return out;
}

// Allow-list (never a spread): a field added to a run record later stays local until it is named here.
// Fields copied as they are today, then fields that are reshaped, redacted or opt-in below.
const HANDOFF_PLAIN_FIELDS = ['schema_version', 'store_id', 'id', 'revision', 'created_at', 'updated_at', 'ticket_id', 'request_id', 'mode', 'note', 'permissions', 'access', 'base_ticket_revision', 'base_next_action', 'repo_id', 'base_commit', 'branch', 'state', 'requested_at', 'started_at', 'finished_at', 'deadline_at', 'error', 'children_ids', 'test_results', 'commit_sha', 'uncertain_effects', 'retry_of', 'batch_id', 'recipe', 'legacy', 'outputs', 'deadline_ms', 'timings', 'cancel_requested', 'proposal_id', 'proposal'];
const HANDOFF_SHAPED_FIELDS = ['test_gate', 'file_effects', 'suggestions', 'pr_url', 'result_summary', 'result_confidence', 'result_sources', 'changed_files'];
// Counts and the recorded stage stand in for the attempt, learning and critical-change records, which stay local.
// scope_count (R53) says how many write scopes a run had, so an export can say "Autonomous + scopes (n)"; the
// scope names, targets and fingerprints never travel.
const HANDOFF_COUNT_FIELDS = ['attempt_count', 'learning_count', 'critical_count', 'recorded_stage', 'scope_count'];
export const HANDOFF_EXPORT_FIELDS = [...HANDOFF_PLAIN_FIELDS, ...HANDOFF_SHAPED_FIELDS, ...HANDOFF_COUNT_FIELDS];

// Local-only tickets never leave the machine: not in exports, mirrors, publishers or tracker pushes.
export function isExportableTicket(ticket) {
  return !(ticket && ticket.local_only === true);
}

function countOf(h, list, count) {
  if (Array.isArray(h[list])) return h[list].length;
  return Number.isInteger(h[count]) ? h[count] : undefined;
}

function sanitizeHandoff(h, o) {
  const { result_ref, pr_url, result_summary, result_confidence, result_sources, changed_files, suggestions, files, file_effects, test_gate } = h;
  const out = {};
  for (const k of HANDOFF_PLAIN_FIELDS) if (k in h) out[k] = h[k];
  // The test gate's result travels; its command and output (paths, env, secrets) never do.
  if (test_gate) out.test_gate = Object.fromEntries(Object.entries(test_gate).filter(([k]) => ['status', 'exit_code', 'ms', 'attempts', 'repaired'].includes(k)));
  // File runs (ADR 0015) name absolute paths and trash locations: never exported, only counted.
  out.file_effects = (file_effects ?? []).length;
  // Agent output, like the result summary, is shared only when checkpoints are included.
  out.suggestions = o.includeCheckpoints ? (suggestions ?? []) : [];
  if (o.includeLinks) out.pr_url = pr_url ?? null;
  if (o.includeCheckpoints) {
    out.result_summary = result_summary ?? null;
    // Sources name files and commits, so they travel with the summary and not otherwise.
    out.result_confidence = result_confidence ?? null;
    out.result_sources = result_sources ?? [];
  }
  out.changed_files = (changed_files ?? []).length;
  const attempts = countOf(h, 'attempts', 'attempt_count');
  const learnings = countOf(h, 'learnings', 'learning_count');
  const critical = countOf(h, 'critical_changes', 'critical_count');
  if (attempts !== undefined) out.attempt_count = attempts;
  if (learnings !== undefined) out.learning_count = learnings;
  if (critical !== undefined) out.critical_count = critical;
  if (typeof h.recorded_stage === 'string') out.recorded_stage = h.recorded_stage;
  const scopes = countOf(h, 'scopes', 'scope_count');
  if (scopes) out.scope_count = scopes;
  return out;
}

export function sanitizeSnapshot(snapshot, options = {}) {
  const o = normalizeOptions(options);
  const hidden = new Set(snapshot.tickets.filter((t) => !isExportableTicket(t)).map((t) => t.id));
  const tickets = snapshot.tickets.filter((t) => isExportableTicket(t) && (!o.projects || o.projects.includes(t.project_id)));
  const ids = new Set(tickets.map((t) => t.id));
  const meta = { ...snapshot.meta, onboarding: null, autonomy: null, owner_machine_id: null, exported_at: o.exportedAt, active_sync_request_id: null, oldest_pending_event_at: null };
  // The slot caps stay; the batch budget is the owner's spend setting and never leaves (spec §9).
  if (meta.handoff_limits && typeof meta.handoff_limits === 'object') meta.handoff_limits = { readonly: meta.handoff_limits.readonly, fix: meta.handoff_limits.fix };
  const out = {
    schema_version: snapshot.schema_version ?? 1,
    generation_id: snapshot.generation_id,
    generated_at: snapshot.generated_at,
    capabilities: { read: true, edit_tickets: false, handoff: false, refresh: false, cancel_requests: false, export: false },
    tickets: tickets.map((t) => hideLinks(sanitizeTicket(t, o), hidden)),
    sessions: (snapshot.sessions ?? []).filter((s) => !((s.ticket_ids ?? []).length && (s.ticket_ids ?? []).every((id) => hidden.has(id)))).filter((s) => !o.projects || (s.ticket_ids ?? []).some((id) => ids.has(id)) || !(s.ticket_ids ?? []).length).map((s) => sanitizeSession(dropHidden(s, hidden), o)),
    checkpoints: o.includeCheckpoints ? (snapshot.checkpoints ?? []).filter((c) => !c.ticket_id || ids.has(c.ticket_id)).map(({ content_ref, ...c }) => c) : [],
    handoffs: (snapshot.handoffs ?? []).filter((h) => ids.has(h.ticket_id)).map((h) => sanitizeHandoff(h, o)),
    requests: [],
    picknext: (snapshot.picknext ?? []).filter((p) => ids.has(p.ticket_id)),
    blocked: (snapshot.blocked ?? []).filter((b) => ids.has(b.ticket_id)),
    deployments_outstanding: (snapshot.deployments_outstanding ?? []).filter((d) => ids.has(d.ticket_id)).map(({ pr_url, ...d }) => (o.includeLinks ? { ...d, pr_url } : d)),
    meta,
    repos: (snapshot.repos ?? []).map(({ id, project_id, display_name, default_branch, deployment_environments }) => ({ id, project_id, display_name, default_branch, deployment_environments })),
    unresolved: [],
    export: { fields: o.fields, projects: o.projects, include_links: o.includeLinks, include_checkpoints: o.includeCheckpoints },
  };
  return redactDeep(out);
}

export function previewExport(snapshot, options = {}) {
  const o = normalizeOptions(options);
  const tickets = snapshot.tickets.filter((t) => isExportableTicket(t) && (!o.projects || o.projects.includes(t.project_id)));
  const excluded = ['Local absolute paths (redacted everywhere)', 'Request queue, owner token, CSRF and local store URI', 'Full checkpoint bodies and content references'];
  if (!o.includeCheckpoints) excluded.push('Checkpoint previews and handoff result summaries');
  if (!o.includeLinks) excluded.push('PR and Jira links (states and dates stay)');
  for (const f of SELECTABLE_FIELDS) if (!o.fields.includes(f)) excluded.push(`Field ${f}`);
  return {
    fields: o.fields,
    projects: o.projects ?? [...new Set(snapshot.tickets.filter(isExportableTicket).map((t) => t.project_id))],
    ticket_count: tickets.length,
    session_count: (snapshot.sessions ?? []).length,
    include_links: o.includeLinks,
    include_checkpoints: o.includeCheckpoints,
    last_sync: snapshot.meta ? snapshot.meta.last_sync : null,
    excluded,
  };
}
