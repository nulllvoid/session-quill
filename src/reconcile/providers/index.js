import { createGithubProvider } from './github.js';
import { createBitbucketProvider } from './bitbucket.js';
import { createNullProvider } from './null.js';

// One provider per repository kind: GitHub through the authenticated gh CLI, Bitbucket over REST
// with a token from a named environment variable (ADR 0007), and an explicit "none" otherwise.
export function defaultProviders(config = {}, env = process.env) {
  const cache = new Map();
  return {
    for(repo) {
      const id = repo ? repo.id : null;
      const kind = repo && repo.provider ? repo.provider : null;
      const key = `${kind}:${id}:${repo ? repo.provider_url ?? '' : ''}`;
      if (!cache.has(key)) {
        let provider;
        if (kind === 'github') provider = createGithubProvider();
        else if (kind === 'bitbucket') provider = createBitbucketProvider({ baseUrl: repo.provider_url ?? null, tokenEnv: repo.token_env ?? 'BITBUCKET_TOKEN', usernameEnv: repo.username_env ?? null, env });
        else provider = createNullProvider(id ?? 'unknown');
        cache.set(key, provider);
      }
      return cache.get(key);
    },
  };
}
