const T = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

export function ticket(n, overrides = {}) {
  return {
    schema_version: 1, store_id: 's', id: T(n), revision: 1, created_at: '2026-10-01T08:00:00Z', updated_at: '2026-10-01T08:00:00Z',
    key: `LOCAL-ticket-${n}-abcdef0${n}`, title: `Ticket ${n}`, project_id: 'demo', project_name: 'Demo', status: 'todo', category: 'feature', priority: 'P2',
    parent_id: null, due: null, blocker: null, repo_id: 'demo', jira: null, next_action: '', summary: '', user_notes: '', last_activity: '2026-10-01T08:00:00Z', stale: false,
    status_source: 'manual', status_evidence_id: null, manual_status_evidence_floor: 0, aliases: [], children_ids: [], session_ids: [], tags: ['tracker/status/todo', 'tracker/cat/feature'],
    files_touched: [], plans: [], conclusions: [], timeline: [], timeline_total: 0, prs: [], deployments: [], handoff_ids: [], validation_issues: [],
    files_touched_count: 0, plans_count: 0, children_done_count: 0, ...overrides,
  };
}

export function snapshot(overrides = {}) {
  const tickets = [
    ticket(1, { status: 'todo', next_action: 'Write the plan', priority: 'P1' }),
    ticket(2, { status: 'active', stale: true, last_activity: '2026-09-20T08:00:00Z', tags: ['tracker/status/active', 'tracker/cat/feature', 'tracker/stale'], title: 'Stale <script>alert(1)</script> work' }),
    ticket(3, { status: 'blocked', blocker: 'Waiting on infra' }),
    ticket(4, { status: 'done' }),
    ticket(5, { status: 'review', prs: [{ id: 'pr1', provider: 'github', url: 'https://github.com/acme/demo/pull/5', state: 'open', opened_at: '2026-09-30T08:00:00Z', merged_at: null, base_branch: 'main', head_branch: 'f', observed_at: '2026-10-02T08:00:00Z', error: null, evidence_id: 'e' }] }),
    ticket(6, { status: 'deploy-pending', prs: [{ id: 'pr6', provider: 'github', url: 'https://github.com/acme/demo/pull/6', state: 'merged', opened_at: '2026-09-28T08:00:00Z', merged_at: '2026-09-29T08:00:00Z', base_branch: 'main', head_branch: 'g', observed_at: '2026-10-02T08:00:00Z', error: null, evidence_id: 'e6' }], deployments: [{ id: 'd6', pr_id: 'pr6', environment: 'production', state: 'pending', merged_at: '2026-09-29T08:00:00Z', deployed_at: null, evidence: null, waiver_reason: null, source_event_id: 'x' }] }),
    ticket(7, { parent_id: T(1), key: 'LOCAL-ticket-1-abcdef01.1', title: 'Child of one', status: 'done' }),
  ];
  tickets[0].children_ids = [T(7)];
  tickets[0].children_done_count = 1;
  return {
    schema_version: 1, generation_id: 'gen-00000003', generated_at: '2026-10-02T12:00:00Z',
    capabilities: { read: true, edit_tickets: true, handoff: true, refresh: true, cancel_requests: true, export: true },
    tickets,
    sessions: [{ id: 'sess-1', host_session_id: 'host-1', agent_id: null, machine_name: 'laptop', state: 'live', started_at: '2026-10-02T11:00:00Z', last_event_at: '2026-10-02T11:58:00Z', successful_write_count: 3, change_coverage: 'complete', current_ticket_id: T(2), current_binding_revision: 1, bindings: [{ revision: 1, ticket_id: T(2), project_id: 'demo', bound_at: '2026-10-02T11:00:00Z', unbound_at: null, source_event_id: 'e' }], ticket_ids: [T(2)], last_checkpoint_id: 'cp1', last_checkpoint_preview: 'Checkpoint preview text', unpromoted: true, gate_enabled: false, capture_health: { status: 'ok', reason: null, observed_at: '2026-10-02T11:58:00Z' }, ended_at: null, title: 'Fix things' }],
    checkpoints: [{ id: 'cp1', session_id: 'sess-1', ticket_id: T(2), binding_revision: 1, recorded_at: '2026-10-02T11:58:00Z', content_ref: 'a'.repeat(64), preview: 'Checkpoint preview text', complete: true, approved_at: null, approval_provenance: null }, { id: 'cp2', session_id: 'sess-1', ticket_id: T(2), binding_revision: 1, recorded_at: '2026-10-02T11:30:00Z', content_ref: null, preview: '', complete: false, approved_at: null, approval_provenance: null }],
    handoffs: [{ id: 'h1', ticket_id: T(5), request_id: 'r1', mode: 'analyse-followups', note: 'look', permissions: { read_source: false, edit_source: false, commit: false, push_branch: false, open_draft_pr: false }, base_ticket_revision: 1, repo_id: 'demo', state: 'timed-out', requested_at: '2026-10-02T09:00:00Z', started_at: '2026-10-02T09:01:00Z', finished_at: '2026-10-02T09:21:00Z', error: { code: 'timeout', message: 'exceeded 20 min' }, result_ref: 'b'.repeat(64), result_summary: 'Partial analysis', children_ids: [], changed_files: [], test_results: [], commit_sha: null, pr_url: null, uncertain_effects: [] }],
    requests: [],
    picknext: [{ rank: 1, ticket_id: T(1), raw_score: 115, score: 100, reasons: ['Priority P1: +25', 'Has next action: +10'], limitations: [] }, { rank: 2, ticket_id: T(2), raw_score: 20, score: 20, reasons: ['Stale (no activity for 5+ days): +10'], limitations: ['PR state unknown: provider evidence unavailable'] }],
    blocked: [{ ticket_id: T(3), blocker: 'Waiting on infra' }],
    deployments_outstanding: [{ ticket_id: T(6), ticket_key: tickets[5].key, ticket_status: 'deploy-pending', pr_id: 'pr6', pr_url: 'https://github.com/acme/demo/pull/6', environment: 'production', merged_at: '2026-09-29T08:00:00Z', deployment_id: 'd6' }],
    meta: { store_id: 's', store_name: 'Tracker', tracker_version: '0.1.0', schema_version: 1, owner_machine_id: 'm', timezone: 'UTC', sync_interval_hours: 2, last_sync: '2026-10-02T09:30:00Z', next_sync_due: '2026-10-02T11:30:00Z', last_capture_at: '2026-10-02T11:58:00Z', oldest_pending_event_at: null, worker_seen_at: '2026-10-02T12:00:00Z', capture_health: { status: 'ok', reason: null, observed_at: '2026-10-02T12:00:00Z' }, projection_health: { status: 'ok', reason: null, observed_at: '2026-10-02T12:00:00Z' }, provider_health: [{ provider: 'github', last_success_at: '2026-10-02T06:00:00Z', last_attempt_at: '2026-10-02T11:00:00Z', error: 'gh: auth required' }], counts_by_status: { todo: 1, active: 1, blocked: 1, review: 1, 'deploy-pending': 1, done: 2 }, stale_ticket_count: 1, unresolved_event_count: 0, active_sync_request_id: null },
    repos: [{ id: 'demo', project_id: 'demo', display_name: 'demo', default_branch: 'main', deployment_environments: ['production'] }],
    ...overrides,
  };
}

export const TID = T;
