// Ingress secret redaction (ADR 0029). Credential-shaped strings are assembled from pieces so this
// file holds no literal token an antivirus or a secret scanner would flag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { redactText, redactCapped, redactEvent, REDACTED, IDENTIFIER_KEYS, isIdentifierKey } from '../../src/lib/redact.js';

const alnum = (n, seed = 'aB3') => seed.repeat(Math.ceil(n / seed.length)).slice(0, n);
const b64 = (bytes) => crypto.createHash('sha512').update(String(bytes)).digest('base64').slice(0, bytes);
const SHA1 = crypto.createHash('sha1').update('x').digest('hex');
const SHA256 = crypto.createHash('sha256').update('x').digest('hex');
const UUID = '550e8400-e29b-41d4-a716-446655440000';

// [input, the secret part that must not survive]
const FORMATS = [
  ['github classic', `push with ${'gh' + 'p_'}${alnum(36)} now`],
  ['github fine-grained', `GH ${'github' + '_pat_'}${alnum(40)}`],
  ['gitlab', `use ${'glp' + 'at-'}${alnum(20)}`],
  ['slack bot', `${'xo' + 'xb-'}${alnum(12)}-${alnum(12)}`],
  ['slack user', `${'xo' + 'xp-'}${alnum(30)}`],
  ['npm', `//registry.npmjs.org/:_authToken ${'np' + 'm_'}${alnum(36)}`],
  ['openai', `key ${'s' + 'k-'}proj-${alnum(40)}`],
  ['anthropic', `key ${'s' + 'k-'}ant-api03-${alnum(60)}`],
  ['aws access key', `${'AK' + 'IA'}${'ABCDEFGHIJ234567'}`],
  ['aws session key', `${'AS' + 'IA'}${'QRSTUVWXYZ234567'}`],
  ['bearer', `Authorization: Bearer ${alnum(10, 'q7.')}`],
  ['basic', `Authorization: Basic ${Buffer.from('me:pw-1234').toString('base64')}`],
  ['url userinfo', 'clone https://bob:s3cr3tpw@git.example.com/repo.git'],
  ['password=', "password = 'hunter2'"],
  ['json token', '{"token": "abc123secretvalue"}'],
  ['pem', `${'-----BEGIN '}RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAuZ\n-----END RSA PRIVATE KEY-----`],
  ['env line', 'DB_PASSWORD=hunter2'],
  ['env line, credential name', 'export STRIPE_CREDENTIAL="sk live words"'],
  ['env line, auth name', '  OAUTH_CLIENT=opaque value 77'],
  ['base64 blob', `blob ${b64(40)} end`],
  ['long hex', `key ${'ab12'.repeat(20)}`],
];

test('each known credential format is redacted', () => {
  for (const [name, input] of FORMATS) {
    const out = redactText(input);
    assert.ok(out.includes(REDACTED), `${name}: ${out}`);
    assert.notEqual(out, input, name);
  }
  // The secret itself is gone, not just marked.
  assert.ok(!redactText(FORMATS[0][1]).includes(alnum(36)));
  assert.ok(!redactText('DB_PASSWORD=hunter2').includes('hunter2'));
  assert.ok(!redactText('export STRIPE_CREDENTIAL="sk live words"').includes('live words'));
  assert.ok(!redactText(`x ${b64(40)} y`).includes(b64(40)));
  assert.ok(!redactText('clone https://bob:s3cr3tpw@git.example.com/repo.git').includes('s3cr3tpw'));
  assert.equal(redactText(`${'-----BEGIN '}EC PRIVATE KEY-----\nAAA\n-----END EC PRIVATE KEY----- b`), `${REDACTED} b`);
});

test('identifiers, hashes, paths and ordinary prose survive byte for byte', () => {
  const kept = [
    UUID, UUID.toUpperCase(), SHA1, SHA256, `sha256:${SHA256}`, `commit ${SHA1.slice(0, 7)} on main`,
    'src/a/b.js', 'C:/Users/someone/Downloads/session-tracker-docs/q2-t1/src/lib/redact.js',
    '/home/dev/projects/session-tracker/src/components/RunDetailPanel/View2.js',
    'feat/2.0-t1-ingress-secret-redaction-for-hooks', 'mcp__claude_ai_Atlassian__getJiraIssue',
    'handleRedactEventForIngress2Payload', 'max_tokens=4096', 'MAX_TOKENS=4096', 'tokens: 1234',
    '{"input_tokens": 52, "output_tokens": 7}', 'see https://example.com/a/b', 'a basic understanding of it',
    'Bearer tokens expire', 'PROJ-12 Sync payments to staging', 'run 1a2b3c4d of PROJ-7', 'LOCAL-unknown-status-record-57c8291c',
    'FEAT-12-Sync-Payments-To-Staging-2026',
    `https://github.com/acme/app/blob/${SHA1}/src/x.js`, 'AUTHOR is not a .env line here',
  ];
  for (const s of kept) assert.equal(redactText(s), s);
});

test('redaction is idempotent and deterministic', () => {
  for (const [name, input] of FORMATS) {
    const once = redactText(input);
    assert.equal(redactText(once), once, name);
    assert.equal(redactText(input), once, name);
  }
  assert.equal(redactText('GH_TOKEN="[secret redacted]"'), 'GH_TOKEN="[secret redacted]"');
});

test('non-string input is coerced; the shared token is the existing one', () => {
  assert.equal(REDACTED, '[secret redacted]');
  assert.equal(redactText(null), '');
  assert.equal(redactText(undefined), '');
});

test('redactCapped never leaves the prefix of a cut secret', () => {
  const tok = `${'gh' + 'p_'}${'B'.repeat(200)}`;
  const out = redactCapped(`${'z '.repeat(40)}${tok}`, 100);
  assert.ok(Buffer.byteLength(out) <= 100);
  assert.ok(!out.includes('BBBB'), out);
  assert.equal(redactCapped('short text', 100), 'short text');
});

test('long inputs stay linear', () => {
  for (const big of ['a-'.repeat(512 * 1024), 'aB3/'.repeat(256 * 1024), `${'x'.repeat(1_048_576)}`, 'K=v\n'.repeat(262_144), 'export '.repeat(150_000)]) {
    const started = process.hrtime.bigint();
    redactText(big);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 1000, `1 MB redacted in ${Math.round(ms)} ms`);
  }
});

test('redactEvent redacts payload text and keeps identifier keys byte for byte', () => {
  const tok = `${'gh' + 'p_'}${alnum(36)}`;
  const ev = {
    schema_version: 1, event_id: UUID, kind: 'stop', session_id: 'sess-1', source_identity: `stop:sess-1:${SHA256}:t`,
    payload: {
      preview: `done; token ${tok}`, conclusions: [`used ${tok}`], content_ref: SHA256, length: 42, complete: true,
      write_paths: [`src/${tok}.js`], ticket_id: tok, commit: { sha: SHA1, message: `fix ${tok}` }, branch: `feat/${tok}`,
      pr: { url: `https://github.com/acme/app/pull/1?x=${tok}`, state: 'open' }, nested: { files: [tok], deep: [{ note: tok }] },
      usage: { input_tokens: 5 }, nothing: null,
    },
  };
  const copy = structuredClone(ev);
  const out = redactEvent(ev);
  assert.deepEqual(ev, copy, 'the input is not modified');
  assert.notEqual(out.payload, ev.payload);
  assert.equal(out.payload.preview, `done; token ${REDACTED}`);
  assert.deepEqual(out.payload.conclusions, [`used ${REDACTED}`]);
  assert.equal(out.payload.commit.message, `fix ${REDACTED}`);
  assert.equal(out.payload.nested.deep[0].note, REDACTED);
  for (const k of ['content_ref', 'write_paths', 'ticket_id', 'branch', 'length', 'complete', 'usage', 'nothing']) assert.deepEqual(out.payload[k], ev.payload[k], k);
  assert.equal(out.payload.commit.sha, SHA1);
  assert.equal(out.payload.pr.url, ev.payload.pr.url);
  assert.deepEqual(out.payload.nested.files, [tok]);
  for (const k of ['event_id', 'session_id', 'source_identity', 'kind']) assert.equal(out[k], ev[k]);
  assert.deepEqual(redactEvent(out), out, 'a second pass changes nothing');
});

test('identifier keys cover ids, keys, hashes, refs and paths but not credential-named keys', () => {
  for (const k of ['id', 'ids', 'key', 'ticket_key', 'parent_key', 'ticket_id', 'session_ids', 'commit_sha', 'sha', 'hash', 'body_hash', 'ref', 'plan_ref', 'write_paths', 'paths', 'files', 'source_identity', 'cwd', 'branch', 'url', 'pr_url']) assert.ok(isIdentifierKey(k), k);
  for (const k of ['message', 'preview', 'api_key', 'token', 'access_key', 'access_key_id', 'token_hash', 'private_key', 'client_secret_ref', 'secret', 'error', 'title_candidate', 'write_target', 'comment']) assert.ok(!isIdentifierKey(k), k);
  assert.ok(IDENTIFIER_KEYS.includes('*_id'));
});

test('redactEvent tolerates events without an object payload', () => {
  assert.deepEqual(redactEvent({ kind: 'bind', payload: null }), { kind: 'bind', payload: null });
  assert.equal(redactEvent(null), null);
});

test('a URL identifier keeps its bytes except a user-info credential', () => {
  const ev = { kind: 'post-tool', payload: { url: 'https://bob:ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@github.com/o/r.git', pr_url: 'https://github.com/o/r/pull/7' } };
  const out = redactEvent(ev).payload;
  assert.equal(out.url, 'https://[secret redacted]@github.com/o/r.git');
  assert.equal(out.pr_url, 'https://github.com/o/r/pull/7');
});

test('tool names and planned paths are identifiers: an MCP tool name survives, free text is still redacted', () => {
  const tool = 'mcp__s3v2__putObjectV2InBucket4Region9';
  for (const k of ['tool_name', 'tool', 'planned_paths', 'write_paths', 'other_paths']) assert.ok(isIdentifierKey(k), k);
  assert.ok(!isIdentifierKey('token_paths'), 'a credential-named key is never an identifier');
  const planned = ['src/aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3x.js'];
  const out = redactEvent({ kind: 'post-tool', payload: { tool_name: tool, planned_paths: planned, nested: { tool }, note: `called ${tool}` } });
  assert.equal(out.payload.tool_name, tool);
  assert.deepEqual(out.payload.planned_paths, planned);
  assert.equal(out.payload.nested.tool, tool);
  assert.equal(out.payload.note, `called ${REDACTED}`, 'the same name in prose is text, and the entropy rule still applies');
});

test('filesystem paths are identifiers: a macOS temp folder survives ingress redaction byte for byte', () => {
  const mac = '/var/folders/7x/k9q2m4vb5sd8h1c3xw0zt6r40000gn/T/quill-home-Xk2Rf9/worktrees/demo/FIX-1';
  const out = redactEvent({ kind: 'worktree', payload: { op: 'mounted', path: mac, dir: mac, root: mac, file_path: mac, worktree_path: mac, run_dir: mac } }).payload;
  for (const k of ['path', 'dir', 'root', 'file_path', 'worktree_path', 'run_dir']) assert.equal(out[k], mac, k);
  assert.equal(redactEvent({ kind: 'stop', payload: { message: `see ${mac} and ghp_${'a'.repeat(36)}` } }).payload.message.includes('ghp_'), false, 'free text still redacts');
});
