// Resolves the gate mode, tracker and project that apply to a hook call from the runtime identity:
// the registered repository with the longest path containing cwd wins (ADR 0005).
import path from 'node:path';

function norm(p) {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

export function scopeFor(identity, cwd) {
  const base = { gate_mode: identity.gate_mode ?? 'strict', tracker: identity.tracker ?? null, project_id: identity.default_project_id ?? null, repo_id: null };
  if (typeof cwd !== 'string' || !cwd || !Array.isArray(identity.repos)) return base;
  const c = norm(cwd);
  let best = null;
  let bestLen = -1;
  for (const r of identity.repos) {
    if (!r || typeof r.path !== 'string') continue;
    const rp = norm(r.path);
    const within = c === rp || c.startsWith(rp.endsWith(path.sep) ? rp : rp + path.sep);
    if (within && rp.length > bestLen) { best = r; bestLen = rp.length; }
  }
  if (!best) return base;
  return { gate_mode: best.gate_mode ?? base.gate_mode, tracker: best.tracker ?? null, project_id: best.project_id ?? base.project_id, repo_id: best.repo_id ?? null };
}
