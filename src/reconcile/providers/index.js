import { createGithubProvider } from './github.js';
import { createNullProvider } from './null.js';

export function defaultProviders(config = {}) {
  const cache = new Map();
  return {
    for(repo) {
      const id = repo ? repo.id : null;
      const kind = repo && repo.provider ? repo.provider : null;
      const key = `${kind}:${id}`;
      if (!cache.has(key)) cache.set(key, kind === 'github' ? createGithubProvider() : createNullProvider(id ?? 'unknown'));
      return cache.get(key);
    },
  };
}
