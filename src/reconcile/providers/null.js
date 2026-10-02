import { TrackerError } from '../../lib/errors.js';

// A missing provider yields unknown evidence, never fabricated PR or deployment state.
export function createNullProvider(repoId) {
  return {
    name: 'none',
    async fetchPr() {
      throw new TrackerError('provider-missing', `no PR provider configured for repository ${repoId}; evidence stays as last observed`);
    },
  };
}
