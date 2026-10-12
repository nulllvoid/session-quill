// Checks what the agent says it tried against what the run's tool ledger shows it called
// (spec §5.4). The ledger is the worker's own record; the agent's "attempts" are a claim.
//   verified: 'seen'            a matching call is in the ledger
//             'claimed-no-call' the agent names a tool the ledger shows no call of
//             'unverifiable'    the agent named no tool, so nothing can be matched
// A refusal the ledger recorded that the agent did not report is added as a refused attempt.

const SHELL = new Set(['Bash', 'PowerShell']);

const baseName = (token) => String(token ?? '').replace(/^["']|["']$/g, '').split(/[\\/]/).pop().replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();

// The program of every command in a shell line: the first word after the start or a separator.
function binaries(command) {
  const out = [];
  for (const seg of String(command ?? '').split(/&&|\|\||[;|\n]/)) {
    const word = seg.trim().split(/\s+/)[0];
    if (word) out.push(baseName(word));
  }
  return out;
}

// Names a ledger line counts as a call of: the tool itself, plus the binaries of a shell command.
function namesOf(line) {
  const tool = typeof line.tool === 'string' ? line.tool : '';
  if (!tool) return [];
  const names = [tool.toLowerCase()];
  if (SHELL.has(tool)) names.push(...binaries(line.input_summary));
  return names;
}

function claimedName(tool) {
  const t = String(tool ?? '').trim();
  if (!t) return '';
  if (/^mcp__/i.test(t)) return t.toLowerCase();
  return baseName(t.split(/\s+/)[0]);
}

export function reconcileAttempts(attempts, ledgerLines) {
  const ledger = Array.isArray(ledgerLines) ? ledgerLines : [];
  const called = new Set();
  for (const l of ledger) if (l && (l.kind === 'tool_use' || l.kind === 'denial' || l.kind === 'guard')) for (const n of namesOf(l)) called.add(n);
  const reported = new Set();
  const out = (Array.isArray(attempts) ? attempts : []).map((a) => {
    const name = claimedName(a && a.tool);
    if (name) reported.add(name);
    return { ...a, verified: !name ? 'unverifiable' : called.has(name) ? 'seen' : 'claimed-no-call' };
  });
  const added = [];
  const keys = new Set();
  for (const l of ledger) {
    if (!l || (l.kind !== 'denial' && l.kind !== 'guard') || !l.tool) continue;
    const names = namesOf(l);
    if (names.some((n) => reported.has(n))) continue;
    const key = `${l.tool}\u0000${l.input_summary ?? ''}`;
    if (keys.has(key)) continue;
    keys.add(key);
    added.push({
      route: `Refused: ${l.tool}${l.input_summary ? ` ${String(l.input_summary).slice(0, 100)}` : ''}`,
      tool: String(l.tool).slice(0, 200),
      target: String(l.input_summary ?? '').slice(0, 300),
      outcome: 'refused',
      reason: l.kind === 'guard' ? 'blocked by the Quill guard' : 'denied by the run\'s permissions',
      evidence: 'recorded in the run ledger; the agent did not report it',
      verified: 'seen',
      added: true,
    });
  }
  return { attempts: out, added };
}
