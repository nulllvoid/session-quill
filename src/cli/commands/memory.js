// `quill memory` (spec §6.4, ADR 0027): the owner's terminal view of run memory and the changes the
// CLI may make. list and show read the journal (inside an agent run without the quarantine, which
// runs never see); retire, pin and note go to the worker as revision-checked requests (the
// dispatcher refuses them inside a run); approve and edit are dashboard-only and refused here.
import { loadContext } from '../context.js';
import { replayState } from './sync.js';
import { submitCliRequest } from './handoff.js';
import { memoryListing } from '../../core/memory.js';
import { TrackerError } from '../../lib/errors.js';

export const TRUST_LABELS = { owner: 'Owner', verified: 'Verified', sourced: 'Sourced', observed: 'Observed', quarantined: 'Quarantined' };

const USAGE = 'usage: quill memory list [--repo <id>] [--machine] [--quarantine] [--json] | show <id> [--json] | retire <id> | pin <id> [--unpin] | note "<text>" (--repo <id> | --machine) [--section s] [--key k]';

// Memory text is agent output: control and format characters (escape sequences, bidi overrides,
// zero-width marks) never reach the terminal, and an entry prints on one line.
export function terminalText(value, max = 0) {
  const s = String(value ?? '').replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return max && s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const inRun = (env) => typeof env.QUILL_HANDOFF_ID === 'string' && env.QUILL_HANDOFF_ID !== '';

function listing(ctx, env) {
  const { state } = replayState(ctx, { readOnly: true });
  return { state, ...memoryListing(state, Date.now(), { includeQuarantine: !inRun(env) }) };
}

function find(entries, ref) {
  if (typeof ref !== 'string' || !ref) throw new TrackerError('usage', USAGE);
  const exact = entries.find((e) => e.id === ref);
  if (exact) return exact;
  const matches = entries.filter((e) => e.id.toLowerCase().startsWith(ref.toLowerCase()));
  if (!matches.length) throw new TrackerError('memory-entry-unknown', `no memory entry starts with ${terminalText(ref, 40)}; list them with \`quill memory list\``);
  if (matches.length > 1) throw new TrackerError('memory-entry-ambiguous', `${terminalText(ref, 40)} matches ${matches.length} entries; give more of the id`);
  return matches[0];
}

function chips(e) {
  return [TRUST_LABELS[e.trust] ?? e.trust, e.pinned ? 'Pinned' : null, e.staleness === 'stale' ? 'Stale' : null, e.conflict_key ? 'Conflict' : null].filter(Boolean).join(' · ');
}

function line(e) {
  const where = e.scope === 'repo' ? `repo ${terminalText(e.repo_id, 30)}` : e.scope;
  const held = e.trust === 'quarantined' ? `  (held: ${terminalText(e.quarantine_reason || 'awaiting approval', 120)})` : '';
  return `${e.id.slice(0, 8)}  ${chips(e).padEnd(22)} ${where.padEnd(16)} ${terminalText(e.section || '-', 16).padEnd(14)} ${terminalText(e.text, 160)}${held}`;
}

function list(ctx, io, flags, env) {
  const { entries, conflicts } = listing(ctx, env);
  let shown = entries;
  if (flags.quarantine) shown = shown.filter((e) => e.trust === 'quarantined');
  else if (flags.machine) shown = shown.filter((e) => e.scope === 'machine' && e.trust !== 'quarantined');
  else if (typeof flags.repo === 'string') shown = shown.filter((e) => e.scope === 'repo' && e.repo_id === flags.repo && e.trust !== 'quarantined');
  if (flags.json) { io.json({ entries: shown, conflicts }); return 0; }
  if (!entries.length) { io.println('No memory yet. Runs file what they learn when they finish; add your own with `quill memory note`.'); return 0; }
  if (!shown.length) { io.println('No entries match.'); return 0; }
  const groups = [['Machine', (e) => e.scope === 'machine' && e.trust !== 'quarantined'], ['Repo', (e) => e.scope === 'repo' && e.trust !== 'quarantined'], ['Quarantine (approve or retire on the dashboard Memory page)', (e) => e.trust === 'quarantined']];
  for (const [title, keep] of groups) {
    const rows = shown.filter(keep);
    if (!rows.length) continue;
    io.println(`${title}:`);
    for (const e of rows) io.println(`  ${line(e)}`);
  }
  if (conflicts.length) io.println(`${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'}: entries with the same key disagree; resolve on the dashboard Memory page or retire one.`);
  return 0;
}

function show(ctx, io, args, flags, env) {
  const e = find(listing(ctx, env).entries, args[0]);
  if (flags.json) { io.json(e); return 0; }
  const rows = [
    ['Id', e.id], ['Trust', chips(e)], ['Scope', e.scope === 'repo' ? `repo ${e.repo_id}` : e.scope], ['Section', e.section || '-'], ['Key', e.key ?? '-'],
    ['Text', e.text], ['Source', e.derived_from ?? '-'], ['Run', e.run_id ?? '-'], ['Confirmed', `${e.confirmations}×, last ${e.last_confirmed_at}`], ['Revision', String(e.revision)],
  ];
  if (e.trust === 'quarantined') rows.push(['Held', e.quarantine_reason || 'awaiting approval']);
  if (e.conflict_key) rows.push(['Conflict', `another entry with key ${e.conflict_key} says something else`]);
  for (const x of e.evidence) rows.push(['Evidence', x]);
  for (const [k, v] of rows) io.println(`${`${k}:`.padEnd(11)}${terminalText(v, 2000)}`);
  return 0;
}

async function change(ctx, io, kind, args, flags, env, payload = {}) {
  const e = find(listing(ctx, env).entries, args[0]);
  const terminal = await submitCliRequest(ctx, io, { kind, target_id: e.id, expected_revision: e.revision, payload }, flags);
  if (terminal.state !== 'applied') {
    const err = terminal.error ?? {};
    throw new TrackerError(err.code ?? terminal.state, `memory ${kind.slice(7)} ${terminal.state}: ${err.message ?? ''}`);
  }
  return e;
}

async function note(ctx, io, args, flags) {
  const text = args.join(' ').trim();
  if (!text) throw new TrackerError('usage', USAGE);
  const repo = typeof flags.repo === 'string' ? flags.repo : null;
  if (!repo && flags.machine !== true) throw new TrackerError('usage', 'say where the note belongs: --repo <id> or --machine');
  const payload = { scope: repo ? 'repo' : 'machine', text };
  if (repo) payload.repo_id = repo;
  if (typeof flags.section === 'string') payload.section = flags.section;
  if (typeof flags.key === 'string') payload.key = flags.key;
  const terminal = await submitCliRequest(ctx, io, { kind: 'memory-note', target_id: null, expected_revision: null, payload }, flags);
  if (terminal.state !== 'applied') {
    const err = terminal.error ?? {};
    throw new TrackerError(err.code ?? terminal.state, `memory note ${terminal.state}: ${err.message ?? ''}`);
  }
  io.println(`Added owner note ${String(terminal.result.entry_id).slice(0, 8)} (${repo ? `repo ${terminalText(repo, 30)}` : 'machine'}). Owner notes are delivered first and never go stale.`);
  return 0;
}

export async function run({ args, flags, io, env }) {
  const [sub, ...rest] = args;
  if (sub === 'approve' || sub === 'edit') {
    throw new TrackerError(`memory-${sub}-dashboard-only`, `${sub === 'approve' ? 'approving a learning' : 'editing a memory entry'} is a dashboard action: open Memory with \`quill ui\``);
  }
  const ctx = loadContext(env);
  switch (sub) {
    case 'list': return list(ctx, io, flags, env);
    case 'show': return show(ctx, io, rest, flags, env);
    case 'retire': {
      const e = await change(ctx, io, 'memory-forget', rest, flags, env);
      io.println(`Retired ${e.id.slice(0, 8)}: ${terminalText(e.text, 120)}. Runs no longer receive it.`);
      return 0;
    }
    case 'pin': {
      const pinned = flags.unpin !== true;
      const e = await change(ctx, io, 'memory-pin', rest, flags, env, { pinned });
      io.println(`${pinned ? 'Pinned' : 'Unpinned'} ${e.id.slice(0, 8)}: ${terminalText(e.text, 120)}.${pinned ? ' Pinned entries are delivered first and never go stale.' : ''}`);
      return 0;
    }
    case 'note': return note(ctx, io, rest, flags);
    default: throw new TrackerError('usage', USAGE);
  }
}
