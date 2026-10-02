// PMLA profile: maps legacy frontmatter into contract records (TRD §Migration and rollout).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deterministicId } from '../lib/ids.js';
import { isIsoZ, toIso, isDate } from '../lib/time.js';
import { CATEGORIES, PRIORITIES } from '../core/state.js';
import { slugify } from '../core/keys.js';
import { TrackerError } from '../lib/errors.js';

const PROFILES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'profiles');
const JIRA_KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;

export function loadProfile(nameOrPath) {
  const file = nameOrPath.endsWith('.json') ? path.resolve(nameOrPath) : path.join(PROFILES_DIR, nameOrPath, 'profile.json');
  if (!fs.existsSync(file)) throw new TrackerError('profile-missing', `migration profile not found: ${file}`);
  const profile = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!profile.fields || !profile.status_map) throw new TrackerError('profile-invalid', `profile ${file} lacks fields/status_map`);
  return profile;
}

function iso(value) {
  if (value === null || value === undefined || value === '') return null;
  try {
    if (value instanceof Date) return toIso(value);
    const s = String(value);
    if (isIsoZ(s)) return s;
    if (isDate(s)) return `${s}T00:00:00Z`;
    return toIso(s);
  } catch {
    return null;
  }
}

function providerOf(url) {
  if (/bitbucket\.org|bitbucket/i.test(url)) return 'bitbucket';
  if (/github\.com/i.test(url)) return 'github';
  if (/gitlab/i.test(url)) return 'gitlab';
  return 'unknown';
}

export function mapRecord(record, profile, { fallbackTime = null } = {}) {
  const fm = record.frontmatter ?? {};
  const f = (name) => fm[profile.fields[name] ?? name];
  const issues = [];
  const title = typeof f('title') === 'string' && f('title').trim() ? f('title').trim() : null;
  if (!title) issues.push('title-missing');
  const rawStatus = typeof f('status') === 'string' ? f('status').trim().toLowerCase() : '';
  let target = profile.status_map[rawStatus];
  if (!target) { issues.push('status-unknown'); target = 'todo'; }
  if (target === 'todo-or-active') target = (f('in_progress') === true || record.hasTimeline) ? 'active' : 'todo';

  const prUrl = typeof f('pr') === 'string' && f('pr').trim() ? f('pr').trim() : null;
  const mergedAt = iso(f('merged_at'));
  const deployedAt = iso(f('deployed_at'));
  const prs = [];
  const deployments = [];
  const needsMerge = rawStatus === 'merged' || rawStatus === 'deployed' || target === 'deploy-pending';
  if (prUrl) {
    const prState = needsMerge ? 'merged' : (rawStatus === 'pr_raised' || target === 'review' ? 'open' : 'unknown');
    prs.push({ id: deterministicId(`pmla:pr:${prUrl}`), provider: providerOf(prUrl), url: prUrl, state: prState, opened_at: iso(f('pr_opened_at')), merged_at: prState === 'merged' ? (mergedAt ?? fallbackTime) : null, base_branch: null, head_branch: null, observed_at: null, error: null, evidence_id: `migration:${prUrl}:${prState}` });
  } else if (needsMerge) {
    issues.push('pr-missing');
  }
  if (needsMerge && prs.length) {
    if (!mergedAt) issues.push('merged-date-unknown');
    const skipped = f('deploy_skipped') === true || String(f('deploy_skipped')).toLowerCase() === 'true';
    const reason = typeof f('deploy_skip_reason') === 'string' && f('deploy_skip_reason').trim() ? f('deploy_skip_reason').trim() : null;
    for (const environment of profile.environments ?? ['production']) {
      const base = { id: deterministicId(`pmla:dep:${prUrl}:${environment}`), pr_id: prs[0].id, environment, merged_at: mergedAt ?? fallbackTime, deployed_at: null, evidence: null, waiver_reason: null, source_event_id: null };
      if (rawStatus === 'deployed') {
        if (!deployedAt) issues.push('deployed-date-unknown');
        deployments.push({ ...base, state: 'deployed', deployed_at: deployedAt ?? fallbackTime, evidence: 'imported from PMLA (status deployed)' });
      } else if (skipped && reason) {
        deployments.push({ ...base, state: 'waived', waiver_reason: reason, evidence: 'imported waiver from PMLA (deploy_skipped)' });
      } else if (skipped) {
        issues.push('missing-waiver-reason');
        deployments.push({ ...base, state: 'pending' });
      } else {
        deployments.push({ ...base, state: 'pending' });
      }
    }
  }
  if (target === 'deploy-pending' && deployments.length && deployments.every((d) => d.state !== 'pending')) target = 'done';
  if (target === 'deploy-pending' && !deployments.length) { target = 'review'; }

  let blocker = null;
  if (target === 'blocked') {
    blocker = typeof f('blocker') === 'string' && f('blocker').trim() ? f('blocker').trim() : null;
    if (!blocker) { issues.push('blocker-missing'); blocker = 'Blocker text missing in source (review required)'; }
  }
  const priority = PRIORITIES.includes(f('priority')) ? f('priority') : (profile.default_priority ?? 'P2');
  const category = CATEGORIES.includes(f('category')) ? f('category') : (profile.default_category ?? 'research');
  const jiraKey = typeof f('jira') === 'string' && JIRA_KEY_RE.test(f('jira').trim()) ? f('jira').trim() : null;
  const parentRaw = typeof f('parent') === 'string' && f('parent').trim() ? f('parent').trim() : null;
  const due = isDate(String(f('due') ?? '')) ? String(f('due')) : null;
  const lastActivity = iso(f('last_activity')) ?? iso(f('updated')) ?? fallbackTime;
  const createdAt = iso(f('created')) ?? lastActivity ?? fallbackTime;
  return {
    title: title ?? '(untitled import)',
    status: target,
    source_status: rawStatus || null,
    blocker,
    priority,
    category,
    next_action: typeof f('next_action') === 'string' ? f('next_action').trim() : '',
    due,
    jira: jiraKey ? { key: jiraKey, url: null, validation: 'pending', validated_at: null, error: 'imported from PMLA; remote validation pending' } : null,
    jira_key: jiraKey,
    prs,
    deployments,
    last_activity: lastActivity,
    created_at: createdAt,
    parent_key: parentRaw,
    issues,
  };
}

export function keyFor(mapped, relPath, prefix = 'LOCAL') {
  if (mapped.jira_key) return mapped.jira_key;
  return `${prefix}-${slugify(mapped.title)}-${deterministicId(`pmla:${relPath}`).slice(0, 8)}`;
}
