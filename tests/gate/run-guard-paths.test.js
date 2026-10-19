// The guard against the file system: roots, links and junctions, wildcards, `..` and directory
// changes, checked on a throwaway machine (guard-fixture.js). The decision rows are in
// run-guard-rows.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { decide, isWithin, INSTALL_ROOT, GUARD_CODE, MAX_GLOB_MATCHES } from '../../src/gate/run-guard.js';
import {
  base, at, dir, file, home, runDir, checkout, tmp, install, outside, VARS, ENV, EDIT, grantWith,
  bash, pwsh, call, q, ARGO_STG, PIN_STG, denied, CLIMBS, OUT_W, IN_INSTALL, run
} from './guard-fixture.js';

test('roots: a path equal to a root is inside it, a sibling sharing its prefix is not', () => {
  const root = path.join(base, 'repo');
  assert.equal(isWithin(root, root), true);
  assert.equal(isWithin(path.join(root, 'a', 'b'), root), true);
  assert.equal(isWithin(`${root}-other`, root), false);
  assert.equal(isWithin(path.join(`${root}-other`, 'x'), root), false);
  assert.equal(isWithin(path.join(root, 'A'), root.toUpperCase()), process.platform === 'win32');
});

test('roots compare case-insensitively on Windows', { skip: process.platform !== 'win32' && 'case-sensitive file system' }, () => {
  const upper = path.join(install.toUpperCase(), 'SRC', 'Gate', 'RUN-GUARD.JS');
  const r = run(call('Edit', { file_path: upper, old_string: 'x', new_string: 'y' }), IN_INSTALL);
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, denied('protected-path'));
  const ok = run(call('Read', { file_path: path.join(checkout.toUpperCase(), 'SRC', 'APP.JS') }), {});
  assert.equal(ok.decision, 'allow', ok.reason);
});

test('a junction or directory link inside the checkout cannot reach outside the roots (R10)', (t) => {
  const escape = path.join(checkout, 'escape');
  const guard = path.join(checkout, 'guardlink');
  fs.symlinkSync(outside, escape, 'junction');
  fs.symlinkSync(path.join(install, 'src', 'gate'), guard, 'junction');
  t.after(() => { fs.rmSync(escape, { force: true }); fs.rmSync(guard, { force: true }); });
  const edit = { grant: { permissions: EDIT } };
  const cases = [
    [call('Write', { file_path: path.join(escape, 'new.txt'), content: 'x' }), edit, 'outside-writable'],
    [call('Read', { file_path: path.join(escape, 'secret.txt') }), {}, 'outside-readable'],
    [bash('echo x > escape/new.txt'), edit, 'outside-writable'],
    [bash('cat escape/secret.txt'), {}, 'outside-readable'],
    [call('Write', { file_path: path.join(guard, 'run-guard.js'), content: 'x' }), edit, 'protected-path'],
  ];
  for (const [c, opts, code] of cases) {
    const r = run(c, opts);
    assert.equal(r.decision, 'deny', `${JSON.stringify(c)}: ${r.reason}`);
    assert.match(r.reason, denied(code));
  }
});

test('a dangling link is followed to where writing through it would land (R10)', (t) => {
  const link = path.join(checkout, 'dangling');
  fs.symlinkSync(path.join(outside, 'not-yet'), link, 'junction');
  t.after(() => fs.rmSync(link, { force: true }));
  const r = run(call('Write', { file_path: path.join(link, 'x.txt'), content: 'x' }), { grant: { permissions: EDIT } });
  assert.equal(r.decision, 'deny', r.reason);
  assert.match(r.reason, denied('outside-writable'));
});

test('a path a call names is resolved afresh on every decision', (t) => {
  const later = path.join(checkout, 'later');
  const target = path.join(later, 'credentials');
  assert.equal(run(call('Read', { file_path: target }), {}).decision, 'allow', 'not there yet: inside the checkout');
  fs.symlinkSync(outside, later, 'junction');
  t.after(() => fs.rmSync(later, { force: true }));
  const r = run(call('Read', { file_path: target }), {});
  assert.equal(r.decision, 'deny', r.reason);
  assert.match(r.reason, denied('outside-readable'));
});

test('a file symlink to a credential is neither readable nor writable (R10)', (t) => {
  const link = path.join(checkout, 'creds.txt');
  try {
    fs.symlinkSync(path.join(home, '.aws', 'config'), link, 'file');
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES') return t.skip('this account may not create file symlinks');
    throw err;
  }
  t.after(() => fs.rmSync(link, { force: true }));
  const read = run(call('Read', { file_path: link }), {});
  assert.match(read.reason, denied('outside-readable'));
  const write = run(call('Write', { file_path: link, content: 'x' }), { grant: { permissions: EDIT } });
  assert.match(write.reason, denied('protected-path'));
});

test('a wildcard that matches too many entries is refused rather than checked (C1)', (t) => {
  const big = path.join(checkout, 'big');
  fs.mkdirSync(big);
  t.after(() => fs.rmSync(big, { recursive: true, force: true }));
  for (let i = 0; i <= MAX_GLOB_MATCHES; i += 1) fs.writeFileSync(path.join(big, `f${i}.txt`), '');
  const r = run(bash('cat big/*'), {});
  assert.equal(r.decision, 'deny', r.reason);
  assert.match(r.reason, denied('wildcard-too-broad'));
  fs.rmSync(path.join(big, 'f0.txt'));
  assert.equal(run(bash('cat big/*'), {}).decision, 'allow', 'exactly at the cap is still checked');
});

test('protected names ignore case where the file system does (M2)', () => {
  const r = run(call('Write', { file_path: path.join(checkout, '.MCP.JSON'), content: '{}' }), { grant: { permissions: EDIT } });
  if (process.platform === 'win32' || process.platform === 'darwin') {
    assert.match(r.reason, denied('protected-path'));
  } else {
    assert.equal(r.decision, 'allow', r.reason);
  }
});

test('with the default Quill home under ~/.claude, the checkout and run dir stay writable (R13)', () => {
  const qh2 = path.join(home, '.claude', 'quill');
  const co2 = path.join(qh2, 'handoffs', 'worktrees', 'run9');
  const rd2 = path.join(qh2, 'handoffs', 'runs', 'run9');
  fs.mkdirSync(path.join(co2, 'src'), { recursive: true });
  fs.mkdirSync(rd2, { recursive: true });
  const { QUILL_HOME, ...vars } = VARS;
  const env = { ...ENV, cwd: co2, vars: { ...vars, QUILL_HANDOFF_ID: 'run9' } };
  const grant = grantWith({ permissions: EDIT, readableRoots: [co2, rd2, tmp], writableRoots: [co2, rd2, tmp], protectedPaths: [] });
  const cases = [
    [call('Write', { file_path: path.join(co2, 'src', 'a.js'), content: 'x' }), 'allow'],
    [call('Write', { file_path: path.join(rd2, 'notes.txt'), content: 'x' }), 'allow'],
    [call('Write', { file_path: path.join(co2, '.claude', 'settings.json'), content: '{}' }), 'deny'],
    [call('Write', { file_path: path.join(rd2, 'grant.json'), content: '{}' }), 'deny'],
    [call('Write', { file_path: path.join(qh2, 'memory', 'x.md'), content: 'x' }), 'deny'],
  ];
  for (const [c, want] of cases) {
    const r = decide(c, grant, env);
    assert.equal(r.decision, want, `${c.tool_input.file_path}: ${r.reason}`);
  }
});

test('a checkout whose own path has brackets: only the supplied text is scanned (C1b, R15)', () => {
  for (const name of ['proj [1]', 'proj[ab]']) {
    const co = dir(name);
    fs.mkdirSync(path.join(co, 'src'), { recursive: true });
    fs.writeFileSync(path.join(co, 'src', 'app.js'), 'x\n');
    fs.symlinkSync(outside, path.join(co, 'esc'), 'junction');
    const env = { ...ENV, cwd: co };
    const grant = grantWith({ readableRoots: [co, runDir, tmp], writableRoots: [runDir, tmp] });
    for (const command of ['cat esc*/credentials', 'cat e?c/credentials', 'cat */credentials']) {
      const r = decide(bash(command), grant, env);
      assert.equal(r.decision, 'deny', `${name}: ${command}: ${r.reason}`);
      assert.match(r.reason, denied('outside-readable'));
    }
    const ok = decide(bash('cat src/*.js'), grant, env);
    assert.equal(ok.decision, 'allow', `${name}: the brackets in the checkout path are literal: ${ok.reason}`);
  }
});

test('wildcard characters the call spells in the cwd path are scanned (N1)', () => {
  const cases = [
    ['work1', 'proj[ab]', 'proja'],
    ['work2', 'proj [1]', 'proj 1'],
  ];
  for (const [work, name, sibling] of cases) {
    const co = dir(work, name);
    fs.mkdirSync(path.join(co, 'src'), { recursive: true });
    fs.writeFileSync(path.join(co, 'src', 'app.js'), 'x\n');
    file(work, sibling, 'secret');
    const env = { ...ENV, cwd: co };
    const grant = grantWith({ readableRoots: [co, runDir, tmp], writableRoots: [runDir, tmp] });
    const abs = path.join(co, 'secret');
    const msys = process.platform === 'win32' ? `/${abs[0].toLowerCase()}${abs.slice(2).replace(/\\/g, '/')}` : abs;
    const bashName = name.replace(/ /g, '\\ ');
    const calls = [
      bash(`cat ../${bashName}/secret`),
      bash(`cd .. && cat ${bashName}/secret`),
      bash(`cat ${msys.replace(/ /g, '\\ ')}`),
      bash(`cat ${q(abs.replace(/\\/g, '/'))}`),
      bash(`cat ../${bashName}/src/*.js`),
      pwsh(`Get-Content ${q(`..${path.sep}${name}${path.sep}secret`)}`),
      pwsh(`Get-Content ${q(abs)}`),
    ];
    for (const c of calls) {
      const r = decide(c, grant, env);
      assert.equal(r.decision, 'deny', `${name}: ${c.tool_input.command}: ${r.reason}`);
      assert.match(r.reason, denied('outside-readable'), c.tool_input.command);
    }
    const ok = decide(bash('cat src/*.js'), grant, env);
    assert.equal(ok.decision, 'allow', `${name}: the cwd's own brackets stay literal: ${ok.reason}`);
  }
});

test('one wildcard budget per call, with memoised listings, keeps a decision quick (N2)', (t) => {
  const fastestMs = (fn) => {
    let best = Infinity;
    for (let i = 0; i < 3; i += 1) {
      const t0 = process.hrtime.bigint();
      fn();
      best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
    }
    return best;
  };
  const files = path.join(checkout, 'many');
  const links = path.join(checkout, 'links');
  fs.mkdirSync(files);
  fs.mkdirSync(links);
  t.after(() => { fs.rmSync(files, { recursive: true, force: true }); fs.rmSync(links, { recursive: true, force: true }); });
  for (let i = 0; i < 500; i += 1) fs.writeFileSync(path.join(files, `f${i}.txt`), '');
  for (let i = 0; i < 200; i += 1) fs.symlinkSync(path.join(checkout, 'src'), path.join(links, `l${i}`), 'junction');

  assert.equal(run(bash('cat many/*'), {}).decision, 'allow', 'one wildcard over 500 entries is within the budget');
  const manyPaths = bash(`cat ${Array.from({ length: 1000 }, (_, i) => `many/*${i}`).join(' ')}`);
  let r;
  const ms1 = fastestMs(() => { r = run(manyPaths, {}); });
  assert.match(r.reason, denied('wildcard-too-broad'));
  assert.ok(ms1 < 250, `1,000 wildcard paths over 500 files took ${ms1.toFixed(1)} ms`);
  const linkPaths = bash(`cat ${Array.from({ length: 20 }, (_, i) => `links/*${i}`).join(' ')}`);
  const ms2 = fastestMs(() => { r = run(linkPaths, {}); });
  assert.match(r.reason, denied('wildcard-too-broad'));
  assert.ok(ms2 < 250, `20 wildcard paths over 200 junctions took ${ms2.toFixed(1)} ms`);
});

test('`..` handling is linear in the number of segments (R17.1, NB)', () => {
  const fastestMs = (fn) => {
    let best = Infinity;
    for (let i = 0; i < 3; i += 1) {
      const t0 = process.hrtime.bigint();
      fn();
      best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
    }
    return best;
  };
  for (const n of [300, 1200]) {
    const cases = [
      [bash(`cat ${'a/'.repeat(n)}..`), CLIMBS],
      [bash(`cat ${Array.from({ length: n / 4 }, (_, i) => `b${i}/..`).join('/')}/src/app.js`), CLIMBS],
      [bash(`cat ../${'a/'.repeat(n)}x`), /^QUILL_DENIED (outside-readable|unparseable): /],
      [bash(`cd src && cat ${'../'.repeat(n)}x`), /^QUILL_DENIED (outside-readable|unparseable): /],
      [bash(`cd ${'a/'.repeat(n)}; cat ../x`), /^QUILL_DENIED unparseable: /],
      [bash(`cat src/*/${Array.from({ length: n }, (_, i) => `c${i}`).join('/')}`), 'allow'],
    ];
    for (const [c, want] of cases) {
      let r;
      const ms = fastestMs(() => { r = run(c, {}); });
      const label = `${n} segments: ${c.tool_input.command.slice(0, 40)}…`;
      if (want === 'allow') assert.equal(r.decision, 'allow', `${label}: ${r.reason}`);
      else assert.match(r.reason, want, label);
      assert.ok(ms < 250, `${label} took ${ms.toFixed(1)} ms`);
    }
  }
});

test('a leading .. is resolved from the real path of the directory a cd moved to (R19.1)', (t) => {
  // L is an in-tree junction to deep/B; deep/esc is a plain directory; esc leads outside
  fs.mkdirSync(path.join(checkout, 'deep', 'B'), { recursive: true });
  fs.mkdirSync(path.join(checkout, 'deep', 'esc'), { recursive: true });
  fs.symlinkSync(path.join(checkout, 'deep', 'B'), path.join(checkout, 'L'), 'junction');
  t.after(() => { fs.rmSync(path.join(checkout, 'L'), { force: true }); fs.rmSync(path.join(checkout, 'deep'), { recursive: true, force: true }); });
  const edit = { grant: { permissions: EDIT } };
  const cases = [
    [bash('cd L && cd ../esc && cat ../secret.txt'), {}, denied('outside-readable')],
    [bash('cd L && cd ../esc && echo x > ../zz'), edit, OUT_W],
    [bash('cd L && cd ../esc && git -C .. init zA'), edit, /^QUILL_DENIED (outside-readable|outside-writable|protected-path): /],
    [bash('cd L && cd ../esc && cd -P .. && cat secret.txt'), {}, denied('unparseable')],
    [bash('cd L; cd ../esc; cat ../secret.txt'), {}, denied('outside-readable')],
    [pwsh('Set-Location L; Set-Location ..\\esc; Get-Content ..\\secret.txt'), {}, denied('outside-readable')],
  ];
  for (const [c, opts, want] of cases) {
    const r = run(c, opts);
    assert.equal(r.decision, 'deny', `${c.tool_input.command}: ${r.reason}`);
    assert.match(r.reason, want, c.tool_input.command);
  }
  for (const command of ['cd L && cat ../B/../B/x', 'cd L && ls', 'cd deep/esc && cat ../B/x']) {
    if (command.includes('B/../')) continue;
    const r = run(bash(command), {});
    assert.equal(r.decision, 'allow', `${command}: ${r.reason}`);
  }
});

test('a scope covers a call by where it really runs: the checkout through a link, never a link out of it', (t) => {
  // macOS: a checkout recorded under /var/folders/… runs in /private/var/folders/…, which is what
  // the hook reports as its cwd
  const alias = at('checkout-alias');
  fs.symlinkSync(checkout, alias, 'junction');
  t.after(() => fs.rmSync(alias, { force: true }));
  const grant = { scopes: [ARGO_STG], actionPins: [PIN_STG] };
  const pinned = bash('argocd app sync pay-stg');
  assert.equal(run(pinned, { grant }).decision, 'allow', 'the plain case');
  assert.equal(run(pinned, { grant: { ...grant, checkoutRoot: alias } }).decision, 'allow', 'the grant names the checkout through a link, the hook its real path');
  assert.equal(run(pinned, { grant, env: { cwd: alias } }).decision, 'allow', 'the hook names the checkout through a link');
  const out = run(pinned, { grant, env: { cwd: path.join(checkout, 'esc') } });
  assert.equal(out.decision, 'deny', 'a directory inside the checkout that is a link to somewhere else');
  assert.match(out.reason, /does not run inside the run's checkout/);
});

test('a symbolic link target is resolved where the link is, also inside an existing directory (R17.4)', (t) => {
  // `ln -s ../../q x/y/L` where x/y/L is a junction to the shallow directory sh: the link lands
  // in sh, and its target climbs from there
  const deep = path.join(checkout, 'x', 'y');
  const shallow = path.join(checkout, 'sh');
  fs.mkdirSync(deep, { recursive: true });
  fs.mkdirSync(shallow);
  fs.symlinkSync(shallow, path.join(deep, 'L'), 'junction');
  t.after(() => { fs.rmSync(path.join(checkout, 'x'), { recursive: true, force: true }); fs.rmSync(shallow, { recursive: true, force: true }); });
  const edit = { grant: { permissions: EDIT } };
  // from x/y (the cwd and the link's directory) ../../q stays inside the checkout; from sh it
  // climbs out of it
  const r = run(bash('cd x/y && ln -s ../../q L'), edit);
  assert.equal(r.decision, 'deny', r.reason);
  assert.match(r.reason, /^QUILL_DENIED (outside-writable|protected-path): /);
  // an existing file as the link path: the link is not made inside it
  assert.equal(run(bash('ln -sf ../app.js src/app.js'), edit).decision, 'allow');
});

test('Claude configuration behind a link in the checkout stays protected (R13b)', (t) => {
  const co = dir('linked');
  const target = dir('linked', 'config', 'claude');
  fs.writeFileSync(path.join(target, 'settings.json'), '{}');
  fs.symlinkSync(target, path.join(co, '.claude'), 'junction');
  t.after(() => fs.rmSync(path.join(co, '.claude'), { force: true }));
  const env = { ...ENV, cwd: co };
  const grant = grantWith({ permissions: EDIT, readableRoots: [co, runDir, tmp], writableRoots: [co, runDir, tmp] });
  const cases = [
    [call('Write', { file_path: path.join(co, '.claude', 'settings.local.json'), content: '{}' }), /needs a full-access run or a manual edit/],
    [call('Edit', { file_path: path.join(co, '.claude', 'settings.json'), old_string: '{', new_string: '[' }), /needs a full-access run or a manual edit/],
    [bash('echo x > .claude/settings.local.json'), /needs a full-access run or a manual edit/],
    [call('Write', { file_path: path.join(target, 'settings.json'), content: '{}' }), denied('protected-path')],
    [bash('rm -rf config'), denied('protected-path')],
  ];
  for (const [c, want] of cases) {
    const r = decide(c, grant, env);
    assert.equal(r.decision, 'deny', `${JSON.stringify(c.tool_input)}: ${r.reason}`);
    assert.match(r.reason, want);
  }
  const ok = decide(call('Write', { file_path: path.join(co, 'config', 'other.txt'), content: 'x' }), grant, env);
  assert.equal(ok.decision, 'allow', ok.reason);
});

test('GUARD_CODE covers every local module the guard loads', () => {
  const entries = ['src/gate/run-guard.js', 'src/handoff/grant.js', 'bin/quill-guard.js'].map((p) => path.join(INSTALL_ROOT, p)).filter((p) => fs.existsSync(p));
  const seen = new Set();
  const stack = [...entries];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) stack.push(path.resolve(path.dirname(f), m[1]));
  }
  assert.ok(seen.size >= 4, `walked ${seen.size} modules`);
  for (const f of seen) assert.ok(GUARD_CODE.some((g) => isWithin(f, path.join(INSTALL_ROOT, g))), `${path.relative(INSTALL_ROOT, f)} is not in GUARD_CODE`);
});
