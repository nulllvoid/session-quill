// Deliberately small read-only shell grammar (TRD §Ticket gate). Add forms only with fixtures;
// never a write-command blacklist.

const FORBIDDEN_CHARS = /[|&;<>$`(){}\n\r#*?[\]~!="']/;
const PATH_TOKEN = /^[A-Za-z0-9._/\\:-]+$/;
const GIT_STATUS_OPTIONS = new Set(['--short', '--branch', '--porcelain']);

function deny(reason) {
  return { allowed: false, reason };
}

function allow(form) {
  return { allowed: true, reason: null, form };
}

export function isLiteralPath(token) {
  if (!PATH_TOKEN.test(token)) return false;
  if (token.startsWith('-')) return false;
  const segments = token.split(/[\\/]/);
  if (segments.some((s) => s === '..')) return false;
  return true;
}

function tokenize(command) {
  if (typeof command !== 'string' || command.length === 0) return { error: 'empty command' };
  if (command !== command.trim()) return { error: 'leading or trailing whitespace' };
  if (FORBIDDEN_CHARS.test(command)) return { error: 'shell metacharacters, quoting, globbing, comments or assignments are not in the read-only grammar' };
  if (/\s\s/.test(command) || /\t/.test(command)) return { error: 'tokens must be separated by single spaces' };
  return { tokens: command.split(' ') };
}

function classifyBash(tokens) {
  const [cmd, ...rest] = tokens;
  if (cmd === 'pwd') return rest.length === 0 ? allow('pwd') : deny('pwd takes no arguments');
  if (cmd === 'git') {
    if (rest[0] !== 'status') return deny('only `git status` is in the read-only grammar');
    const opts = rest.slice(1);
    const seen = new Set();
    for (const opt of opts) {
      if (!GIT_STATUS_OPTIONS.has(opt)) return deny(`git status option not allowed: ${opt}`);
      if (seen.has(opt)) return deny(`repeated option: ${opt}`);
      seen.add(opt);
    }
    return allow('git-status');
  }
  if (cmd === 'ls' || cmd === 'cat') {
    if (cmd === 'cat' && rest.length === 0) return deny('cat requires literal paths');
    for (const token of rest) if (!isLiteralPath(token)) return deny(`not a literal path: ${token}`);
    return allow(cmd);
  }
  return deny(`command not in the read-only grammar: ${cmd}`);
}

function classifyPowerShell(tokens) {
  const [cmd, ...rest] = tokens;
  if (cmd === 'Get-Location') return rest.length === 0 ? allow('Get-Location') : deny('Get-Location takes no arguments');
  if (cmd === 'Get-ChildItem' || cmd === 'Get-Content') {
    let sawPathOption = false;
    const paths = [];
    for (let i = 0; i < rest.length; i += 1) {
      const token = rest[i];
      if (token === '-Path') {
        if (sawPathOption) return deny('-Path may appear once');
        sawPathOption = true;
        const next = rest[i + 1];
        if (!next || !isLiteralPath(next)) return deny('-Path requires a literal path');
        paths.push(next);
        i += 1;
        continue;
      }
      if (!isLiteralPath(token)) return deny(`not a literal path or allowed option: ${token}`);
      paths.push(token);
    }
    if (cmd === 'Get-Content' && paths.length === 0) return deny('Get-Content requires a literal path');
    return allow(cmd);
  }
  return deny(`command not in the read-only grammar: ${cmd}`);
}

export function classifyShell(command, { shell = 'bash' } = {}) {
  const t = tokenize(command);
  if (t.error) return deny(t.error);
  if (shell === 'bash') return classifyBash(t.tokens);
  if (shell === 'powershell') return classifyPowerShell(t.tokens);
  return deny(`unsupported shell: ${shell}`);
}
