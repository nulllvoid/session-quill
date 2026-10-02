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
