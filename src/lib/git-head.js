// Reads the current branch from .git/HEAD without spawning git, so hooks stay fast and offline.
import fs from 'node:fs';
import path from 'node:path';

export function gitDirFor(cwd) {
  let dir = path.resolve(cwd);
  for (let depth = 0; depth < 64; depth += 1) {
    const dotGit = path.join(dir, '.git');
    let st = null;
    try { st = fs.statSync(dotGit); } catch { st = null; }
    if (st && st.isDirectory()) return dotGit;
    if (st && st.isFile()) {
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'));
      return m ? path.resolve(dir, m[1]) : null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

// The main working tree of the repository `cwd` is in, when `cwd` is inside a linked worktree
// (`git worktree add`): its .git file points at <repo>/.git/worktrees/<name>, whose `commondir`
// leads back to <repo>/.git. Returns null outside a linked worktree. No git process is spawned.
export function mainWorkTreeOf(cwd) {
  if (typeof cwd !== 'string' || !cwd) return null;
  try {
    const gitDir = gitDirFor(cwd);
    if (!gitDir) return null;
    let common;
    try { common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()); } catch { return null; }
    if (path.resolve(common) === path.resolve(gitDir) || path.basename(common) !== '.git') return null;
    return path.dirname(common);
  } catch {
    return null;
  }
}

export function currentBranch(cwd) {
  if (typeof cwd !== 'string' || !cwd) return null;
  try {
    const gitDir = gitDirFor(cwd);
    if (!gitDir) return null;
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return m ? m[1].slice(0, 255) : null;
  } catch {
    return null;
  }
}
