import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTracker, findKeys, renderUrl, externalTicketId, branchTitle, keyExample, isSafeExternalUrl } from '../../src/core/external-keys.js';

const jira = normalizeTracker({ system: 'jira', domain: 'https://example.atlassian.net/', prefixes: ['PMLA', 'pc'] });

test('normalizeTracker fills defaults per system and validates every field', () => {
  assert.equal(normalizeTracker(undefined), null);
  assert.deepEqual(jira, { system: 'jira', domain: 'https://example.atlassian.net', url_template: '{domain}/browse/{key}', key_pattern: '\\b([A-Z][A-Z0-9]+-\\d+)\\b', prefixes: ['PMLA', 'PC'], sources: ['prompt', 'branch'], on_new_key: 'switch', repo: '' });
  assert.equal(normalizeTracker({ system: 'linear', domain: 'https://linear.app/acme' }).url_template, '{domain}/issue/{key}');
  for (const bad of [{ system: 'trello' }, { key_pattern: '(' }, { key_pattern: '(a+)+$' }, { key_pattern: 'x'.repeat(201) }, { prefixes: ['pm la'] }, { sources: ['email'] }, { on_new_key: 'merge' }, { domain: 'http://insecure.example' }, { domain: 'javascript:alert(1)' }, { repo: 'a b' }]) {
    assert.throws(() => normalizeTracker(bad), (err) => err.code === 'config-invalid', JSON.stringify(bad));
  }
});

test('findKeys returns configured keys in order of appearance without duplicates', () => {
  assert.deepEqual(findKeys('Fix PMLA-1234 and PC-9; PMLA-1234 again; also ABC-1', jira), ['PMLA-1234', 'PC-9']);
  assert.deepEqual(findKeys('nothing here', jira), []);
  assert.deepEqual(findKeys('', jira), []);
  assert.deepEqual(findKeys('PMLA-1', null), []);
});

test('without prefixes common uppercase-dash-number tokens are not ticket keys', () => {
  const any = normalizeTracker({});
  assert.deepEqual(findKeys('UTF-8, SHA-256, ISO-8601, RFC-3339, GPT-4 and CVE-2024 but ENG-42', any), ['ENG-42']);
});

test('branch scanning upper-cases only when asked, and branchTitle keeps the words after the key', () => {
  assert.deepEqual(findKeys('feat/pmla-77-retry-flake', jira, { uppercase: true }), ['PMLA-77']);
  assert.deepEqual(findKeys('feat/pmla-77-retry-flake', jira), []);
  assert.equal(branchTitle('feat/pmla-77-retry-flake', 'PMLA-77'), 'retry flake');
  assert.equal(branchTitle('PMLA-77', 'PMLA-77'), '');
});

test('scanning is bounded for long or adversarial input', () => {
  const long = `${'PMLA-1 '.repeat(20)}${'x'.repeat(200_000)} PMLA-999999`;
  const started = process.hrtime.bigint();
  const keys = findKeys(long, jira);
  assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 50);
  assert.deepEqual(keys, ['PMLA-1']);
  const many = Array.from({ length: 50 }, (_, i) => `PMLA-${i + 1}`).join(' ');
  assert.equal(findKeys(many, jira).length, 10);
});

test('renderUrl fills the template and refuses unsafe or incomplete links', () => {
  assert.equal(renderUrl('PMLA-12', jira), 'https://example.atlassian.net/browse/PMLA-12');
  const gh = normalizeTracker({ system: 'github', domain: 'https://github.com', repo: 'acme/app', key_pattern: '\\b(GH-\\d+)\\b' });
  assert.equal(renderUrl('GH-7', gh), 'https://github.com/acme/app/issues/7');
  assert.equal(renderUrl('PMLA-12', normalizeTracker({ system: 'jira' })), null, 'no domain, no link');
  assert.equal(renderUrl('PMLA-12', normalizeTracker({ system: 'custom' })), null, 'no template, no link');
  assert.equal(isSafeExternalUrl('https://x.example/a b'), false);
  assert.equal(isSafeExternalUrl('https://x.example/"onload'), false);
  assert.equal(isSafeExternalUrl('http://x.example/a'), false);
});

test('review: repeated groups containing quantifiers, groups or alternation are rejected however they are nested', () => {
  for (const pattern of ['\\b(([A-Z0-9]+))+-\\d+\\b', '\\b((?:[A-Z]|[A-Z0-9])+-\\d+)\\b', '((a+))+b', '(a|aa)+', '(\\w+\\s?)+', '(?:a*){2,}', '([A-Z]{1,3})*x']) {
    assert.throws(() => normalizeTracker({ key_pattern: pattern }), /backtracking/, pattern);
  }
  for (const pattern of ['\\b([A-Z][A-Z0-9]+-\\d+)\\b', '\\b(GH-\\d+)\\b', '\\b((?:PROJ|OPS)-\\d+)\\b', '#(\\d+)', '\\b([A-Z]{2,10}-\\d{1,6})\\b', '[(+]x(ab)?']) {
    assert.doesNotThrow(() => normalizeTracker({ key_pattern: pattern }), pattern);
  }
});

test('review: polynomial patterns stay bounded because scans run per short whitespace-separated token', () => {
  const cubic = normalizeTracker({ key_pattern: '\\b([A-Z]+[A-Z]+[A-Z]+-\\d+)\\b' });
  for (const text of ['A'.repeat(4000), `${'A'.repeat(99)} `.repeat(40)]) {
    const started = process.hrtime.bigint();
    assert.deepEqual(findKeys(text, cubic), []);
    assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 500, `${text.length} chars`);
  }
  assert.deepEqual(findKeys(`${'A'.repeat(3000)} PMLA-1`, jira), ['PMLA-1'], 'an over-long token is skipped, later keys still count');
});

test('review: standard and version tokens are not ticket keys without a prefix allowlist', () => {
  const any = normalizeTracker({});
  assert.deepEqual(findKeys('IEEE-754 X86-64 BASE-64 LATIN-1 LLAMA-3 MPEG-4 ERC-20 BIP-32 USB-3 DDR-4 WPA-2 but ENG-7', any), ['ENG-7']);
});

test('externalTicketId is deterministic per store and key; keyExample uses the first prefix', () => {
  assert.equal(externalTicketId('s1', 'PMLA-1'), externalTicketId('s1', 'PMLA-1'));
  assert.notEqual(externalTicketId('s1', 'PMLA-1'), externalTicketId('s2', 'PMLA-1'));
  assert.equal(keyExample(jira), 'PMLA-123');
  assert.equal(keyExample(null), 'PROJ-123');
});
