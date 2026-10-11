import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ticketCard, filterTickets, normalizeSnapshot, requestFeedback, NEEDS_CLONE_FILTER, EMPTY_FILTERS } from '../../ui/components.js';
import { renderCloneDialog, remoteHost } from '../../ui/views/dialogs.js';
import { snapshot, ticket } from './fixtures.js';

const NOW = '2026-10-02T12:30:00Z';
const ONBOARDING = { clone_hosts: ['github.com', 'gitlab.com', 'bitbucket.org'], auto_clone_dir: 'C:\\Users\\me\\quill-repos', import_assigned: true };
const needsClone = (n, resolution = {}) => ticket(n, { repo_id: null, repo_state: 'needs-clone', repo_resolution: { state: 'needs-clone', remote: 'git@github.com:acme/api.git', existing_path: null, rule: 'repo_map', via: 'PROJ', ...resolution } });
const snap = (tickets, extra = {}) => normalizeSnapshot(snapshot({ tickets, meta: { ...snapshot().meta, onboarding: ONBOARDING }, ...extra }));

test('cards show Needs clone with a Clone… action, Cloning with a pulse, and No code', () => {
  const t1 = needsClone(1);
  const t2 = ticket(2, { repo_id: null, repo_state: 'cloning' });
  const t3 = ticket(3, { repo_id: null, repo_state: 'no-code', tags: ['quill/no-code'] });
  const s = snap([t1, t2, t3]);
  const c1 = ticketCard(t1, s, { now: NOW });
  assert.match(c1, /<span class="chip warning small" data-repo-state="needs-clone">.*Needs clone<\/span><button type="button" class="btn small" data-action="clone-repo" data-ticket="[^"]+" aria-label="Clone the repository for [^"]+">Clone…<\/button>/);
  assert.match(ticketCard(t2, s, { now: NOW }), /data-repo-state="cloning"><span class="dot pulse" aria-hidden="true"><\/span>Cloning<\/span>/);
  assert.match(ticketCard(t3, s, { now: NOW }), /data-repo-state="no-code">No code<\/span>/);
  assert.doesNotMatch(ticketCard(ticket(4), s, { now: NOW }), /data-repo-state/, 'a ticket with a repository shows its name only');
  const readOnly = normalizeSnapshot({ ...snapshot({ tickets: [t1] }), capabilities: { read: true } });
  assert.doesNotMatch(ticketCard(t1, readOnly, { now: NOW }), /clone-repo/, 'a read-only copy cannot clone');
});

test('the Repo filter value Needs clone keeps only tickets waiting for a clone', () => {
  const s = snap([needsClone(1), ticket(2), ticket(3, { repo_id: null, repo_state: 'no-code' })]);
  assert.deepEqual(filterTickets(s, { ...EMPTY_FILTERS, repo: NEEDS_CLONE_FILTER }).map((t) => t.title), ['Ticket 1']);
  assert.equal(filterTickets(s, { ...EMPTY_FILTERS, repo: 'demo' }).length, 1);
});

test('the clone dialog shows the remote, the target folder and the host check before anything is cloned', () => {
  const t = needsClone(1);
  const html = renderCloneDialog(t, snap([t]));
  assert.match(html, /data-form="repo-clone"[^>]*data-url="git@github.com:acme\/api.git"/);
  assert.match(html, /<dt>Remote<\/dt><dd><code>git@github.com:acme\/api.git<\/code><\/dd>/);
  assert.match(html, /<dt>Folder<\/dt><dd><code>C:\\Users\\me\\quill-repos\\api<\/code>/);
  assert.match(html, /<span class="chip good small">github.com is in clone_hosts<\/span>/);
  assert.match(html, /Found from your \[tracker.repo_map\] entry PROJ/);
  assert.match(html, /<button type="submit" class="btn primary">Clone<\/button>/);

  const evil = needsClone(2, { remote: 'https://evil.example/x/<b>y</b>.git', rule: 'issue' });
  const refused = renderCloneDialog(evil, snap([evil]));
  assert.match(refused, /<span class="chip critical small">evil.example is not in clone_hosts<\/span>/);
  assert.match(refused, /<button type="submit" class="btn primary" disabled>Clone<\/button>/);
  assert.doesNotMatch(refused, /<b>y<\/b>/, 'the remote is escaped');

  const onDisk = needsClone(3, { existing_path: 'C:\\src\\api', rule: 'scan' });
  const register = renderCloneDialog(onDisk, snap([onDisk]));
  assert.match(register, /Register the repository/);
  assert.match(register, /<code>C:\\src\\api<\/code>/);
  assert.match(register, /Already cloned; nothing is downloaded/);
  assert.match(register, />Register<\/button>/);
});

test('remote hosts are read from https, ssh and scp-like addresses only', () => {
  assert.equal(remoteHost('https://GitHub.com/acme/api'), 'github.com');
  assert.equal(remoteHost('ssh://git@gitlab.com:22/g/p.git'), 'gitlab.com');
  assert.equal(remoteHost('git@bitbucket.org:team/repo.git'), 'bitbucket.org');
  assert.equal(remoteHost('file:///etc'), null);
  assert.equal(remoteHost('ext::sh'), null);
});

test('a pending clone request is labelled clone and names its remote', () => {
  const html = requestFeedback({ id: 'r', kind: 'repo-clone', state: 'applying', payload: { url: 'git@github.com:acme/api.git' } }, { now: NOW });
  assert.match(html, /<span class="label">clone<\/span> → <span class="proposed">git@github.com:acme\/api.git<\/span>/);
});

test('ticket detail carries the same repository chip and Clone… action', async () => {
  const { renderDetail } = await import('../../ui/views/detail.js');
  const t = needsClone(1);
  assert.match(renderDetail(t, snap([t]), { now: NOW }), /data-repo-state="needs-clone"[\s\S]*data-action="clone-repo"/);
});
