// Temporary folders a test file made, removed once its tests are done.
import { after } from 'node:test';
import fs from 'node:fs';

const dirs = [];
after(() => {
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* still in use on Windows; the OS temp cleaner gets it */ }
  }
});

export function track(dir) {
  dirs.push(dir);
  return dir;
}
