// [[schedule]] tables from user config (ADR 0007). Repository config cannot schedule jobs.
import path from 'node:path';
import os from 'node:os';
import { parseCron, parseInterval, nextAfter } from './cron.js';

export const JOBS = ['reconcile', 'agent', 'digest'];
export const DIGEST_TARGETS = ['vault-daily', 'file'];
export const AGENT_SCOPES = ['deploy-pending', 'active', 'review', 'blocked', 'open'];
export const AGENT_LIMIT_MAX = 25;
// Named by the zero-command proposal and accepted in config so later releases need no migration.
export const PLANNED_JOBS = ['stale-sweep', 'publish', 'tracker-sync'];
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function defaultSchedules(config = {}) {
  const hours = Number.isInteger(config.sync_interval_hours) && config.sync_interval_hours > 0 ? config.sync_interval_hours : 2;
  return [{ name: 'reconcile', job: 'reconcile', cron: null, every: `${hours}h`, spec: null, interval_ms: hours * 3_600_000, enabled: true }];
}

export function normalizeSchedules(config = {}, { timeZone = 'UTC', now = Date.now() } = {}) {
  if (config.schedule === undefined) return { schedules: defaultSchedules(config), warnings: [] };
  if (!Array.isArray(config.schedule)) return { schedules: defaultSchedules(config), warnings: ['[[schedule]] must be a list of tables; using the default reconcile schedule'] };
  const schedules = [];
  const warnings = [];
  const names = new Set();
  config.schedule.forEach((raw, i) => {
    const where = `schedule ${raw && typeof raw.name === 'string' ? `"${raw.name}"` : `#${i + 1}`}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { warnings.push(`${where}: must be a table`); return; }
    if (typeof raw.name !== 'string' || !NAME_RE.test(raw.name)) { warnings.push(`${where}: name must use lowercase letters, digits and dashes`); return; }
    if (names.has(raw.name)) { warnings.push(`${where}: duplicate name; ignored`); return; }
    if (PLANNED_JOBS.includes(raw.job)) { warnings.push(`${where}: job "${raw.job}" arrives in a later release; skipped`); return; }
    if (!JOBS.includes(raw.job)) { warnings.push(`${where}: unknown job "${raw.job}"; available jobs: ${JOBS.join(', ')}`); return; }
    if ((raw.cron === undefined) === (raw.every === undefined)) { warnings.push(`${where}: set exactly one of cron or every`); return; }
    let extra = {};
    if (raw.job === 'agent') {
      if (typeof raw.recipe !== 'string' || !raw.recipe.trim()) { warnings.push(`${where}: an agent schedule needs recipe = "<name>"`); return; }
      const scope = raw.scope ?? 'open';
      if (!AGENT_SCOPES.includes(scope)) { warnings.push(`${where}: scope must be one of ${AGENT_SCOPES.join(', ')}`); return; }
      const limit = raw.limit ?? 10;
      if (!Number.isInteger(limit) || limit < 1 || limit > AGENT_LIMIT_MAX) { warnings.push(`${where}: limit must be a whole number from 1 to ${AGENT_LIMIT_MAX}`); return; }
      extra = { recipe: raw.recipe.trim(), scope, limit };
    }
    if (raw.job === 'digest') {
      const to = raw.to ?? ['vault-daily'];
      if (!Array.isArray(to) || !to.length || to.some((t) => !DIGEST_TARGETS.includes(t))) { warnings.push(`${where}: to may contain ${DIGEST_TARGETS.join(', ')}`); return; }
      if (to.includes('file') && (typeof raw.path !== 'string' || !raw.path.trim())) { warnings.push(`${where}: a file digest needs path = "<file.md>"`); return; }
      // A file path is resolved against the store (never the worker's working directory); ~ is home.
      let file = null;
      if (to.includes('file')) {
        const p = raw.path.trim();
        if (!/\.md$/i.test(p)) { warnings.push(`${where}: path must end in .md`); return; }
        file = p.startsWith('~') ? path.join(os.homedir(), p.slice(1).replace(/^[\\/]/, '')) : path.resolve(config.store_path ?? os.homedir(), p);
      }
      const day = raw.day ?? 'today';
      if (!['today', 'yesterday'].includes(day)) { warnings.push(`${where}: day must be today or yesterday`); return; }
      extra = { to: [...new Set(to)], path: file, day };
    }
    try {
      const enabled = raw.enabled !== false;
      if (raw.cron !== undefined) {
        const spec = parseCron(raw.cron);
        if (nextAfter(spec, now, timeZone) === null) throw new Error('this cron expression never fires');
        schedules.push({ name: raw.name, job: raw.job, cron: spec.expr, every: null, spec, interval_ms: null, enabled, ...extra });
      } else {
        schedules.push({ name: raw.name, job: raw.job, cron: null, every: String(raw.every).trim(), spec: null, interval_ms: parseInterval(raw.every), enabled, ...extra });
      }
      names.add(raw.name);
    } catch (err) {
      warnings.push(`${where}: ${err.message}`);
    }
  });
  return { schedules, warnings };
}
