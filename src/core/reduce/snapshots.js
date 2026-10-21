// Run snapshots (ADR 0035): `snapshot-tx` events, journaled by the worker alone, reduce into a fix
// run's `snapshots` list (local-only: never exported, mirrored, published or written to a vault
// note). Each snapshot is a commit in the run's repository, kept alive by a ref under
// refs/quill/snapshots/<run id>/ (refs/quill/archive/<run id>/ once the checkout is removed). The
// reducer stays pure: it records what the worker reports, never runs git. A malformed event is
// rejected; a redelivered one changes nothing.
import { timelineEntry, touch } from './common.js';

export const SNAPSHOT_OPS = ['created', 'restored', 'archived'];
// The step boundaries the worker snapshots at, and the snapshot a restore takes of the checkout first.
export const SNAPSHOT_STEPS = ['start', 'agent', 'before-repair', 'before-self-check', 'before-tests', 'before-test-repair', 'before-commit', 'pre-restore'];
export const STEP_LABELS = {
  start: 'Checkout created',
  agent: "After the agent's turn",
  'before-repair': 'Before the repair turn',
  'before-self-check': 'Before the self-check',
  'before-tests': 'Before the test gate',
  'before-test-repair': 'Before the test repair turn',
  'before-commit': 'Before the commit',
  'pre-restore': 'Before a restore',
};
// At most this many snapshots per run, restores' own snapshots included; a restore needs a free slot.
export const SNAPSHOT_CAP = 20;
export const SNAPSHOT_REF_ROOT = 'refs/quill/snapshots';
export const ARCHIVE_REF_ROOT = 'refs/quill/archive';
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
const count = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
// A ref the worker writes: the root, the run's id, then one path segment of safe characters.
const refUnder = (ref, root, id) => typeof ref === 'string' && ref.startsWith(`${root}/${id}/`) && /^[A-Za-z0-9._-]{1,80}$/.test(ref.slice(root.length + id.length + 2));

function bump(h, ev, result) {
  h.revision = (h.revision ?? 1) + 1;
  h.updated_at = ev.occurred_at;
  result.handoffsChanged.add(h.id);
}

function created(h, p, ev, result) {
  const list = Array.isArray(h.snapshots) ? h.snapshots : [];
  if (!nonEmpty(p.id)) return { rejected: 'snapshot-invalid' };
  if (list.some((s) => s.id === p.id)) return { duplicate: true };
  if (list.length >= SNAPSHOT_CAP) return { rejected: 'snapshot-limit' };
  if (!SNAPSHOT_STEPS.includes(p.step) || !FULL_SHA.test(p.tree ?? '') || !FULL_SHA.test(p.commit ?? '') || !refUnder(p.ref, SNAPSHOT_REF_ROOT, h.id)) return { rejected: 'snapshot-invalid' };
  const snap = {
    id: p.id,
    n: list.length,
    step: p.step,
    label: nonEmpty(p.label) ? p.label.slice(0, 120) : STEP_LABELS[p.step],
    tree: p.tree,
    commit: p.commit,
    ref: p.ref,
    files_changed: count(p.files_changed),
    at: ev.occurred_at,
    restored_at: null,
    archived_at: null,
  };
  // A pre-restore snapshot names the restore request and the snapshot it was taken before.
  if (nonEmpty(p.request_id)) snap.request_id = p.request_id.slice(0, 64);
  if (nonEmpty(p.restores)) snap.restores = p.restores.slice(0, 64);
  h.snapshots = [...list, snap];
  bump(h, ev, result);
  return {};
}

export function applySnapshotTx(state, ev, result) {
  const p = ev.payload;
  if (!p || !SNAPSHOT_OPS.includes(p.op)) return { rejected: 'snapshot-op-unknown' };
  const h = typeof p.handoff_id === 'string' ? state.handoffs.get(p.handoff_id) : null;
  if (!h) return { rejected: 'handoff-unknown' };
  if (p.op === 'created') return created(h, p, ev, result);
  const snap = (Array.isArray(h.snapshots) ? h.snapshots : []).find((s) => s.id === p.id);
  if (!snap) return { rejected: 'snapshot-unknown' };
  if (p.op === 'archived') {
    if (snap.archived_at) return { duplicate: true };
    if (!refUnder(p.ref, ARCHIVE_REF_ROOT, h.id)) return { rejected: 'snapshot-invalid' };
    snap.ref = p.ref;
    snap.archived_at = ev.occurred_at;
    bump(h, ev, result);
    return {};
  }
  // restored: the latest restore of this snapshot, as counts (the paths stay in the checkout).
  snap.restored_at = ev.occurred_at;
  snap.restore = {
    request_id: nonEmpty(p.request_id) ? p.request_id.slice(0, 64) : null,
    pre_restore_id: nonEmpty(p.pre_restore_id) ? p.pre_restore_id.slice(0, 64) : null,
    restored: count(p.restored),
    removed: count(p.removed),
    skipped: count(p.skipped),
  };
  bump(h, ev, result);
  return {};
}

// The request transaction of an applied `restore-snapshot` (mutation `snapshot-restore`): the
// ticket's timeline says what happened, and what did not.
export function applySnapshotRestore(state, ev, m, result) {
  const h = state.handoffs.get(m.handoff_id);
  const snap = h ? (h.snapshots ?? []).find((s) => s.id === m.snapshot_id) : null;
  if (!snap) return;
  bump(h, ev, result);
  const ticket = state.tickets.get(h.ticket_id);
  if (!ticket) return;
  ticket.timeline.push(timelineEntry(ev, 'handoff', `Checkout of run ${h.id.slice(0, 8)} restored to snapshot ${String(snap.n + 1).padStart(2, '0')} (${snap.label}); the commit, branch and pull request are unchanged`));
  touch(state, ticket, ev, result);
}
