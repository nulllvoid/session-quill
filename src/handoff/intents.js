// Product intent is resolved before the existing recipe/permission validation.
import { TrackerError } from '../lib/errors.js';

export const INTENTS = ['read-only', 'plan', 'auto', 'full'];
export const INSTRUCTIONS_MAX = 4000;
const CONTRACTS = {
  'read-only': { recipe: 'analyse', mode: 'analyse', access: 'autonomous' },
  plan: { recipe: 'plan', mode: 'analyse', access: 'autonomous' },
  auto: { recipe: 'attempt-fix', mode: 'attempt-fix', access: 'autonomous' },
  full: { recipe: 'attempt-fix', mode: 'attempt-fix', access: 'full' },
};

export function validateIntent(payload, recipe = null) {
  if (payload.intent === undefined || payload.intent === null) return null;
  const c = CONTRACTS[payload.intent];
  if (!INTENTS.includes(payload.intent)) throw new TrackerError('intent-invalid', `intent must be one of ${INTENTS.join(', ')}`);
  const ref = payload.recipe;
  const name = typeof ref === 'string' ? ref : ref?.name;
  if ((name && name !== c.recipe) || (ref?.source && ref.source !== 'builtin') || (recipe && (recipe.name !== c.recipe || recipe.source !== 'builtin'))) throw new TrackerError('intent-recipe-mismatch', `${payload.intent} requires the built-in ${c.recipe} template`);
  if (payload.mode != null && payload.mode !== c.mode) throw new TrackerError('intent-mode-mismatch', `${payload.intent} requires ${c.mode} execution`);
  if (payload.access != null && payload.access !== c.access) throw new TrackerError('intent-access-mismatch', `${payload.intent} requires ${c.access} access`);
  if (payload.instructions != null && typeof payload.instructions !== 'string') throw new TrackerError('instructions-invalid', 'instructions must be plain text');
  if ((payload.instructions ?? '').length > INSTRUCTIONS_MAX) throw new TrackerError('instructions-too-long', `instructions exceed ${INSTRUCTIONS_MAX} characters`);
  if (c.mode === 'analyse' && ((payload.scopes?.length ?? 0) || Object.entries(payload.permissions ?? {}).some(([k, v]) => k !== 'read_source' && v === true))) throw new TrackerError('intent-permission-mismatch', `${payload.intent} cannot grant edits, delivery or write scopes`);
  return c;
}

export function resolveIntentPayload(payload, { repo = null, recipes = null, sourceAvailable = !!repo } = {}) {
  const c = validateIntent(payload);
  if (!c) return payload;
  if (c.mode === 'attempt-fix' && !repo) throw new TrackerError('repo-required', `${payload.intent} requires a registered repository`);
  if (c.mode === 'attempt-fix' && !sourceAvailable) throw new TrackerError('repo-unavailable', `${payload.intent} requires a usable registered repository on this machine`);
  const recipe = recipes?.builtin(c.recipe);
  if (!recipe || recipe.error) throw new TrackerError('recipe-invalid', `built-in ${c.recipe} template is unavailable`);
  if (payload.recipe?.hash && payload.recipe.hash !== recipe.hash) throw new TrackerError('recipe-changed', 'the built-in template changed; review and queue a new run');
  const permissions = { read_source: !!sourceAvailable, edit_source: c.mode === 'attempt-fix', ...(payload.permissions ?? {}) };
  return { ...payload, intent: payload.intent, instructions: payload.instructions ?? '', mode: c.mode, access: c.access, recipe: { name: recipe.name, source: 'builtin', hash: recipe.hash }, permissions, legacy: false, suggest: true };
}
