// Journaled retry state: one bounded record per polling target, never an attempt history.
import { HOUR, DAY, addMs } from '../lib/time.js';

export const OLD_TARGET_AGE_MS = 30 * DAY;
export const OLD_TARGET_INTERVAL_MS = DAY;
const MAX_FAILURE_COUNT = 32;
const KINDS = new Set(['ticket-pr', 'run-pr', 'branch']);

export function checkKey(kind, repoId, targetId) {
  return JSON.stringify([kind, repoId ?? null, targetId]);
}

export function applyReconcileChecks(state, checks) {
  if (!(state.reconcileChecks instanceof Map)) state.reconcileChecks = new Map();
  for (const check of Array.isArray(checks) ? checks : []) {
    if (!check || !KINDS.has(check.kind) || typeof check.target_id !== 'string' || !Number.isFinite(Date.parse(check.last_attempt_at)) || !Number.isFinite(Date.parse(check.next_check_at))) continue;
    const key = checkKey(check.kind, check.repo_id, check.target_id);
    if (check.key !== key) continue;
    const previous = state.reconcileChecks.get(key);
    if (previous && Date.parse(previous.last_attempt_at) > Date.parse(check.last_attempt_at)) continue;
    state.reconcileChecks.set(key, {
      key, kind: check.kind, target_id: check.target_id, repo_id: check.repo_id ?? null,
      last_attempt_at: check.last_attempt_at,
      last_success_at: Number.isFinite(Date.parse(check.last_success_at)) ? check.last_success_at : previous?.last_success_at ?? null,
      next_check_at: check.next_check_at,
      failure_count: Math.min(MAX_FAILURE_COUNT, Math.max(0, Number.isInteger(check.failure_count) ? check.failure_count : 0)),
      error: typeof check.error === 'string' ? check.error.slice(0, 300) : null,
    });
  }
}

export function selectChecks(state, targets, limit, now, manual = false) {
  const eligible = targets.filter((target) => {
    const check = state.reconcileChecks?.get(target.key);
    return manual || !check?.next_check_at || Date.parse(check.next_check_at) <= Date.parse(now);
  });
  eligible.sort((a, b) => {
    const at = state.reconcileChecks?.get(a.key)?.last_attempt_at;
    const bt = state.reconcileChecks?.get(b.key)?.last_attempt_at;
    return (at ? Date.parse(at) : -Infinity) - (bt ? Date.parse(bt) : -Infinity) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  });
  const selected = eligible.slice(0, limit);
  const selectedKeys = new Set(selected.map((t) => t.key));
  // For deferred targets, report the oldest attempt (or originating activity if never checked).
  const unchecked = targets.filter((t) => !selectedKeys.has(t.key))
    .map((t) => state.reconcileChecks?.get(t.key)?.last_attempt_at ?? t.activity_at)
    .filter((at) => Number.isFinite(Date.parse(at))).sort((a, b) => Date.parse(a) - Date.parse(b));
  return { selected, coverage: { targets: targets.length, checked: selected.length, failed: 0, deferred: targets.length - selected.length, remaining_eligible: eligible.length - selected.length, oldest_unchecked_at: unchecked[0] ?? null } };
}

export function recordCheck(state, target, now, error = null) {
  const previous = state.reconcileChecks?.get(target.key);
  const failureCount = error ? Math.min(MAX_FAILURE_COUNT, (previous?.failure_count ?? 0) + 1) : 0;
  const old = Date.parse(now) - Date.parse(target.activity_at) > OLD_TARGET_AGE_MS;
  const interval = Math.max(HOUR, (state.meta.sync_interval_hours || 2) * HOUR, old ? OLD_TARGET_INTERVAL_MS : 0);
  const delay = error ? Math.max(interval, Math.min(OLD_TARGET_INTERVAL_MS, HOUR * 2 ** failureCount)) : interval;
  return {
    key: target.key, kind: target.kind, target_id: target.target_id, repo_id: target.repo_id ?? null,
    last_attempt_at: now, last_success_at: error ? previous?.last_success_at ?? null : now,
    failure_count: failureCount, next_check_at: addMs(now, delay), error: error ? String(error).slice(0, 300) : null,
  };
}
