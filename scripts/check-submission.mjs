// Local packaging preflight, not a replacement for the directory's validator or security scan.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', windowsHide: true }).split('\0').filter(Boolean);
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const failures = [];
const warnings = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
const plugin = JSON.parse(read('.claude-plugin/plugin.json'));
const pkg = JSON.parse(read('package.json'));
const market = JSON.parse(read('.claude-plugin/marketplace.json'));
check(plugin.version === pkg.version, 'Package and plugin versions differ.');
check(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(plugin.version), 'Plugin needs a semantic version.');
check(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(plugin.name), 'Plugin name has invalid characters or length.');
check(Boolean(plugin.description && plugin.author?.name && plugin.license), 'Plugin description, author and license are required.');
check(market.plugins.some((p) => p.name === plugin.name && p.source === './'), 'Marketplace must reference the root plugin.');
check(read('README.md').replace(/```[\s\S]*?```/g, '').split(/\s+/).length >= 40, 'README needs explanatory prose.');
check(files.includes('LICENSE'), 'LICENSE missing.');
check(files.length <= 10000, 'Repository file count exceeds the broad archive limit.');
if (files.length > 512) warnings.push('More than 512 files; expect directory review.');

const seen = new Set();
let total = 0;
for (const file of files) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) { failures.push(`Missing tracked file: ${file}`); continue; }
  const stat = fs.lstatSync(full);
  check(stat.isFile() && !stat.isSymbolicLink(), `Not a regular file: ${file}`);
  if (!stat.isFile()) continue;
  total += stat.size;
  check(stat.size < 5 * 1024 * 1024, `File reaches 5 MiB: ${file}`);
  const imageOrFont = /\.(png|jpe?g|gif|webp|woff2?|ttf|otf)$/i.test(file);
  if (!imageOrFont && stat.size >= 256 * 1024) warnings.push(`Large non-image/font: ${file}`);
  const key = file.toLowerCase();
  check(!seen.has(key), `Case-colliding path: ${file}`); seen.add(key);
  for (const part of file.split('/')) {
    check(!/[<>:"\\|?*\x00-\x1f]|[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part), `Nonportable path: ${file}`);
    check(!/^(\.ds_store|thumbs\.db|desktop\.ini|__macosx)$/i.test(part), `OS metadata: ${file}`);
  }
  if (path.basename(file) === '.gitattributes') check(!/(?:^|\s)(?:[-!]?export-(?:ignore|subst)|filter(?:=|\s|$))/m.test(read(file)), `Archive-rewriting attribute: ${file}`);
  if (/\.(zip|pdf|exe|dll|ico|mcpb|dxt)$/i.test(file)) warnings.push(`Binary format may need review: ${file}`);
}
check(total < 256 * 1024 * 1024, 'Unpacked files exceed 256 MiB.');
// This project's hooks deliberately use separate Node command/args fields.
const hooks = JSON.parse(read('hooks/hooks.json')).hooks;
check(Boolean(hooks && Object.keys(hooks).length), 'Hooks missing.');
let hookCount = 0;
for (const groups of Object.values(hooks ?? {})) for (const group of groups) for (const hook of group.hooks ?? []) {
  hookCount++;
  check(hook.type === 'command' && hook.command === 'node', 'Unexpected hook launcher; inspect manually.');
  const entry = hook.args?.[0];
  check(typeof entry === 'string' && entry.startsWith('${CLAUDE_PLUGIN_ROOT}/'), 'Hook entry must be plugin-relative.');
  if (typeof entry === 'string') check(files.includes(entry.replace('${CLAUDE_PLUGIN_ROOT}/', '')), `Hook target missing: ${entry}`);
}
for (const entry of plugin.agents ?? []) check(entry.startsWith('./') && files.includes(entry.slice(2)), `Agent target missing: ${entry}`);
if (files.includes('package-lock.json')) warnings.push('Root package lockfile may trigger install review.');
if (read('src/tracker/client.js').includes('env[tokenEnv]')) warnings.push('Optional tracker authentication reads environment credentials; disclose for directory review.');

console.log(`Local preflight: ${files.length} files, ${(total / 1024 / 1024).toFixed(2)} MiB, ${hookCount} hook entries, version ${plugin.version}.`);
for (const message of warnings) console.log(`REVIEW: ${message}`);
for (const message of failures) console.error(`FAIL: ${message}`);
console.log(failures.length ? `${failures.length} local packaging failures.` : 'Local packaging checks passed. Portal validation and security review are still required.');
process.exitCode = failures.length ? 1 : 0;
