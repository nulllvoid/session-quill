// Resolves the gate mode, tracker and project that apply to a hook call from the runtime identity:
// the registered repository with the longest path containing cwd wins (ADR 0005).
// Paths are compared in canonical form, so a cwd spelled through a symlink or a Windows short
// name still matches the repository git registered.
import { canonicalPath, isWithin } from '../config/repos.js';

export function scopeFor(identity, cwd) {
  const base = { gate_mode: identity.gate_mode ?? 'strict', tracker: identity.tracker ?? null, project_id: identity.default_project_id ?? null, repo_id: null };
  if (typeof cwd !== 'string' || !cwd || !Array.isArray(identity.repos)) return base;
  let best = null;
  let bestLen = -1;
  for (const r of identity.repos) {
    if (!r || typeof r.path !== 'string') continue;
    const len = canonicalPath(r.path).length;
    if (isWithin(r.path, cwd) && len > bestLen) { best = r; bestLen = len; }
  }
  if (!best) return base;
  return { gate_mode: best.gate_mode ?? base.gate_mode, tracker: best.tracker ?? null, project_id: best.project_id ?? base.project_id, repo_id: best.repo_id ?? null };
}
