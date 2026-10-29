// Only typed artifact references in this owner's current store authorize blob reads. Text,
// request payloads, nested generated JSON and arbitrary *_ref fields cannot grant access.
import { updateContentRefs } from '../updates/extension.js';

export function authorizedContentRefs(state) {
  const refs = new Set();
  const add = ref => { if (typeof ref === 'string' && /^[0-9a-f]{64}$/.test(ref)) refs.add(ref); };
  for (const checkpoint of state.checkpoints?.values() ?? []) add(checkpoint.content_ref);
  for (const ticket of state.tickets.values()) {
    for (const field of ['timeline', 'plans', 'conclusions']) {
      for (const item of ticket[field] ?? []) add(item.content_ref);
    }
  }
  for (const run of state.handoffs?.values() ?? []) {
    for (const field of ['result_ref', 'patch_ref', 'critic_ref', 'plan_ref', 'source_plan_ref', 'reviewed_context_ref']) add(run[field]);
    add(run.plan_context?.manifest_ref);
  }
  for (const ref of updateContentRefs(state)) add(ref);
  return refs;
}
