// Read-only loopback server for the design reference. Does not start Quill's worker.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flag = process.argv.indexOf('--port');
const port = flag < 0 ? 47322 : Number(process.argv[flag + 1]);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Use --port 0–65535');
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.md': 'text/plain', '.txt': 'text/plain' };
const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
  try {
    let name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (name === '/') name = '/docs/design-system/index.html';
    const allowed = ['/ui/assets/', '/ui/fonts/', '/docs/design-system/'].some((prefix) => name.startsWith(prefix)) || ['/docs/AGENT-HANDOVER-ORCHESTRATION-1.0.md', '/LICENSE', '/DESIGN.md', '/CLAUDE.md'].includes(name);
    const file = path.resolve(root, `.${name}`);
    const relative = path.relative(root, file);
    if (!allowed || relative.startsWith('..') || path.isAbsolute(relative) || name.includes('\\') || name.split('/').some((part) => part.startsWith('.'))) { res.writeHead(404); res.end('Not found'); return; }
    const body = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': `${types[path.extname(file)] ?? 'application/octet-stream'}${['.html','.css','.js','.json','.md','.txt'].includes(path.extname(file)) ? '; charset=utf-8' : ''}`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch { res.writeHead(404); res.end('Not found'); }
});
server.on('error', (error) => { console.error(`Preview server: ${error.message}. Choose another --port.`); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(`Quill design system: http://127.0.0.1:${server.address().port}/docs/design-system/index.html`));
