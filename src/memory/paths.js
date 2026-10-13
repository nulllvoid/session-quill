// Where the memory projections live (spec §6.1): under quillHome()/memory, so QUILL_HOME (and with
// it a dev-seed store) isolates them, and never under store_path. Pass quillHome(env).
import path from 'node:path';
import { createHash } from 'node:crypto';

const PLAIN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
// Names Windows reserves whatever the extension, and stems that would collide with the owner and
// docs files of another repository (`x.owner` + `.md` = the owner file of `x`).
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;
const SUFFIXED = /\.(owner|docs)$/i;

/** A file-name stem for a repository id: the id itself when it is a plain name, else a cleaned
 * form plus a short hash of the id, so two different ids never share a file. */
export function repoStem(id) {
  const s = String(id ?? '');
  if (PLAIN.test(s) && !RESERVED.test(s) && !SUFFIXED.test(s) && !s.endsWith('.')) return s;
  const clean = s.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'repo';
  return `${clean}-${createHash('sha256').update(s).digest('hex').slice(0, 10)}`;
}

/**
 * @param {string} quillHomeDir  quillHome(env)
 * @returns {{ root: string, repos: string, machine: string, quarantine: string, index: string,
 *   repo: (id: string) => string, repoOwner: (id: string) => string, repoDocs: (id: string) => string }}
 */
export function memoryPaths(quillHomeDir) {
  const root = path.join(path.resolve(quillHomeDir), 'memory');
  const repos = path.join(root, 'repos');
  return {
    root,
    repos,
    machine: path.join(root, '_machine.md'),
    quarantine: path.join(root, '_quarantine.md'),
    // Hashes of the generated owner-notes sections (src/lib/marked-section.js), so an edit inside one is noticed.
    index: path.join(root, '.owner-sections.json'),
    repo: (id) => path.join(repos, `${repoStem(id)}.md`),
    repoOwner: (id) => path.join(repos, `${repoStem(id)}.owner.md`),
    repoDocs: (id) => path.join(repos, `${repoStem(id)}.docs.md`),
  };
}
