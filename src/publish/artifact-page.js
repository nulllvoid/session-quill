// The page an artifact publisher publishes (ADR 0010). It holds no ticket data itself: rows live in
// the artifact's shared db (`tickets/<key>`, `meta/page`) and render live, as text nodes only.
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Page code only a two-way page carries (ADR 0011): editors' controls and the viewer's identity.
const EDIT_JS = `function save(r, field, value) {
  const edits = {};
  edits[field] = { by: uid, at: new Date().toISOString() };
  const patch = { _edits: edits };
  patch[field] = value;
  dbRef.doc('tickets/' + r.__id).update(patch).then(() => {
    document.getElementById('status').textContent = 'Saved. Session Quill applies it on its next publish.';
  }, (e) => { document.getElementById('status').textContent = 'Could not save (' + (e && e.code ? e.code : 'error') + ').'; });
}
function editCell(r) {
  const td = node('td', undefined, 'edit');
  if (EDITABLE.includes('status')) {
    const sel = node('select');
    sel.setAttribute('aria-label', 'Status of ' + r.key);
    for (const st of EDIT_STATUSES) { const o = node('option', STATUS[st] || st); o.value = st; if (st === r.status) o.selected = true; sel.append(o); }
    sel.addEventListener('change', () => save(r, 'status', sel.value));
    td.append(sel);
  }
  if (EDITABLE.includes('next')) {
    const input = node('input');
    input.type = 'text';
    input.value = r.next || '';
    input.maxLength = 2000;
    input.setAttribute('aria-label', 'Next action for ' + r.key);
    const btn = node('button', 'Save');
    btn.type = 'button';
    btn.addEventListener('click', () => save(r, 'next', input.value.trim()));
    td.append(input, btn);
  }
  return td;
}
`;
const USER_JS = `if (db && EDITABLE.length) {
  const user = await claude.use("user");
  canEdit = user ? !!(await user.canEdit()) : false;
  uid = user && canEdit ? await user.id() : null;
}
`;

export const PAGE_CAPABILITIES = { db: { rules: [{ path: '', read: 'interact', write: 'admin' }] } };

const LABELS = { key: 'Key', title: 'Title', status: 'Status', category: 'Category', priority: 'Priority', next: 'Next', blocker: 'Blocker', due: 'Due', updated: 'Updated', pr: 'PRs', deployments: 'Deployments', stale: 'Stale', external: 'Tracker' };

// twoWay (ADR 0011): editors get status and next-action controls; each edit records who and when,
// and Session Quill brings it back as a revision-checked request on its next publish.
export function renderArtifactPage({ title, fields, twoWay = false }) {
  const editable = twoWay ? ['status', 'next'].filter((f) => fields.includes(f)) : [];
  const cols = fields.filter((f) => f !== 'status');
  return `<title>${esc(title)}</title>
<style>
:root { --bg: #f6f7f9; --surface: #ffffff; --text: #1b1f24; --muted: #5b6572; --border: #d6dbe1; --accent: #2f6fde; --warn: #9a6700; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #0f1216; --surface: #171b21; --text: #e6e9ed; --muted: #9aa4b1; --border: #2b323b; --accent: #7aa7ff; --warn: #e3b341; color-scheme: dark; } }
:root[data-theme="dark"] { --bg: #0f1216; --surface: #171b21; --text: #e6e9ed; --muted: #9aa4b1; --border: #2b323b; --accent: #7aa7ff; --warn: #e3b341; color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding-inline: 16px; padding-block: 24px 48px; }
h1 { font-size: 22px; margin: 0 0 4px; }
.meta { color: var(--muted); margin: 0 0 20px; }
section { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; margin-bottom: 16px; overflow: hidden; }
h2 { font-size: 15px; margin: 0; padding: 10px 14px; border-bottom: 1px solid var(--border); }
.wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; vertical-align: top; padding: 8px 14px; border-top: 1px solid var(--border); overflow-wrap: anywhere; }
thead th { border-top: 0; color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
td.key { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; white-space: nowrap; }
#status { color: var(--warn); }
td.edit { white-space: nowrap; }
td.edit select, td.edit input, td.edit button { font: inherit; color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 3px 6px; margin-right: 4px; }
td.edit input { width: 14em; max-width: 100%; }
td.edit :focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
</style>
<main>
  <h1>${esc(title)}</h1>
  <p class="meta" id="meta">Published by Session Quill.</p>
  <p id="status" role="status"></p>
  <div id="groups"></div>
</main>
<script type="module">
const COLS = ${JSON.stringify(cols)};
const EDITABLE = ${JSON.stringify(editable)};
let canEdit = false;
let uid = null;
let dbRef = null;
const EDIT_STATUSES = ['todo', 'active', 'review', 'deploy-pending', 'done'];
const LABELS = ${JSON.stringify(LABELS)};
const ORDER = ['active', 'review', 'deploy-pending', 'blocked', 'todo', 'done'];
const STATUS = { todo: 'To do', active: 'Active', review: 'Review', 'deploy-pending': 'Deploy pending', blocked: 'Blocked', done: 'Done' };
const node = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
let rows = [];
let meta = null;
${twoWay ? EDIT_JS : ''}function render() {
  const groups = document.getElementById('groups');
  groups.replaceChildren();
  if (meta && meta.published_at) document.getElementById('meta').textContent = 'Published by Session Quill · updated ' + new Date(meta.published_at).toLocaleString();
  for (const status of ORDER) {
    const list = rows.filter((r) => (r.status || 'todo') === status).sort((a, b) => String(a.key).localeCompare(String(b.key)));
    if (!list.length) continue;
    const section = node('section');
    section.append(node('h2', (STATUS[status] || status) + ' (' + list.length + ')'));
    const table = node('table');
    const head = node('tr');
    for (const c of COLS) { const th = node('th', LABELS[c] || c); th.scope = 'col'; head.append(th); }
    if (canEdit && EDITABLE.length) { const th = node('th', 'Edit'); th.scope = 'col'; head.append(th); }
    table.append(node('thead')); table.tHead.append(head);
    const body = node('tbody');
    for (const r of list) {
      const tr = node('tr');
      for (const c of COLS) tr.append(node('td', r[c] === true ? 'yes' : r[c] === false ? '' : String(r[c] ?? ''), c === 'key' ? 'key' : undefined));
      ${twoWay ? 'if (canEdit && EDITABLE.length) tr.append(editCell(r));' : ''}
      body.append(tr);
    }
    table.append(body);
    const wrap = node('div', undefined, 'wrap');
    wrap.append(table);
    section.append(wrap);
    groups.append(section);
  }
  if (!rows.length) groups.append(node('p', 'Tickets appear here, grouped by status, each time Session Quill publishes.', 'meta'));
}
render();
const claude = window.claude;
const db = claude && typeof claude.use === 'function' ? await claude.use("db") : null;
dbRef = db;
${twoWay ? USER_JS : ''}if (!db) {
  document.getElementById('status').textContent = 'Open this page on claude.ai to see the live rows.';
} else {
  db.collection('tickets').onSnapshot((snap) => {
    rows = snap.docs.map((d) => Object.assign({ __id: d.id }, d.data())).filter((r) => r && !(r._quill && r._quill.in_scope === false));
    render();
  }, (e) => { document.getElementById('status').textContent = 'The rows are unavailable right now (' + e.code + ').'; });
  db.doc('meta/page').onSnapshot((d) => { meta = d.exists ? d.data() : null; render(); }, () => {});
}
</script>
`;
}
