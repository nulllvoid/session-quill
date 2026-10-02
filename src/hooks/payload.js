// Extracts only the fields the data contract allows from raw hook input. Never retains whole
// prompts, environments, credentials or command output (PRD NFR Privacy).
import path from 'node:path';

export const PREVIEW_CHARS = 1500;
export const TITLE_CHARS = 80;

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export function sanitizeTitle(text) {
  return String(text ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TITLE_CHARS);
}

export function relativeWritePath(filePath, cwd) {
  if (!filePath) return null;
  const abs = path.resolve(cwd ?? '', filePath);
  const rel = cwd ? path.relative(cwd, abs) : abs;
  const normalized = rel.split(path.sep).join('/');
  if (!normalized || normalized.startsWith('..')) return abs.split(path.sep).join('/');
  return normalized;
}

export function writePathsFor(toolName, toolInput, cwd) {
  if (!WRITE_TOOLS.has(toolName) || !toolInput) return [];
  const raw = [];
  if (toolName === 'NotebookEdit') raw.push(toolInput.notebook_path);
  else raw.push(toolInput.file_path);
  if (toolName === 'MultiEdit' && Array.isArray(toolInput.edits)) for (const e of toolInput.edits) raw.push(e && e.file_path);
  return [...new Set(raw.filter(Boolean).map((p) => relativeWritePath(p, cwd)))];
}

function responseText(resp) {
  if (resp === null || resp === undefined) return '';
  if (typeof resp === 'string') return resp;
  if (typeof resp === 'object') {
    if (typeof resp.stdout === 'string') return `${resp.stdout}\n${resp.stderr ?? ''}`;
    if (typeof resp.output === 'string') return resp.output;
    try { return JSON.stringify(resp); } catch { return ''; }
  }
  return String(resp);
}

export function commitFromBash(command, response) {
  if (typeof command !== 'string' || !/^\s*git\s+commit\b/.test(command)) return null;
  const text = responseText(response);
  const m = /\[[^\]\s]+(?:\s+\([^)]*\))?\s+([0-9a-f]{7,40})\]\s*(.*)/.exec(text);
  if (!m) return null;
  return { sha: m[1], message: (m[2] ?? '').trim().slice(0, 200) || null };
}

export function prFromBash(command, response) {
  if (typeof command !== 'string' || !/\bgh\s+pr\s+create\b/.test(command)) return null;
  const text = responseText(response);
  const m = /(https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+)/.exec(text);
  if (!m) return null;
  return { provider: 'github', url: m[1], state: /--draft\b|-d\b/.test(command) ? 'draft' : 'open' };
}

export function planFromExitPlanMode(toolInput, toolResponse) {
  const plan = toolInput && typeof toolInput.plan === 'string' ? toolInput.plan : null;
  if (!plan) return null;
  const text = responseText(toolResponse).toLowerCase();
  if (/rejected|cancelled|canceled|denied|did not approve|not approved/.test(text)) return null;
  return plan;
}

export function extractConclusions(text) {
  if (typeof text !== 'string') return [];
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const inline = /^\s*(?:[-*]\s*)?\**conclusions?\**\s*:\s*\**\s*(.+?)\s*$/i.exec(line);
    if (inline) { out.push(inline[1].trim()); continue; }
    if (/^\s*#{1,6}\s*conclusions?\s*$/i.test(line)) {
      const body = [];
      for (let j = i + 1; j < lines.length; j += 1) {
        if (/^\s*#{1,6}\s/.test(lines[j])) break;
        if (!lines[j].trim()) { if (body.length) break; continue; }
        body.push(lines[j].trim().replace(/^[-*]\s*/, ''));
      }
      if (body.length) out.push(body.join(' '));
    }
  }
  return out.map((c) => c.slice(0, PREVIEW_CHARS));
}

export function preview(text) {
  return String(text ?? '').slice(0, PREVIEW_CHARS);
}
