import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDashboardMotion } from '../../ui/lib/motion.js';

function harness(reduced = false) {
  const calls = [];
  let listener;
  const media = {
    matches: reduced,
    addEventListener(type, fn) { listener = fn; },
    removeEventListener() { listener = null; },
  };
  const elements = new Map();
  function element(name) {
    if (!elements.has(name)) elements.set(name, {
      animate(frames, options) {
        let finish;
        const animation = { finished: new Promise((resolve) => { finish = resolve; }), cancelled: false, cancel() { this.cancelled = true; finish(); } };
        calls.push({ name, frames, options, animation, finish });
        return animation;
      },
    });
    return elements.get(name);
  }
  const root = { querySelector: element, querySelectorAll: () => [element('card-1'), element('card-2')] };
  const motion = createDashboardMotion(root, media);
  return { motion, calls, media, element, preference(value) { media.matches = value; listener?.(); } };
}

test('unchanged worker polls do not replay entrances; navigation and filters do', () => {
  const h = harness();
  const state = { view: 'picknext', results: 'all', detail: null, receipt: null };
  h.motion.update(state);
  const initial = h.calls.length;
  h.motion.update({ ...state });
  assert.equal(h.calls.length, initial);
  h.motion.update({ ...state, results: 'search' });
  assert.equal(h.calls.at(-1).name, '.main > .view');
  h.motion.update({ ...state, view: 'board' });
  assert.ok(h.calls.length > initial + 1);
  h.motion.destroy();
});

test('opening a ticket animates once and changing tickets animates again', () => {
  const h = harness();
  const state = { view: 'picknext', results: 'all', detail: 'ticket-1' };
  h.motion.update(state);
  h.motion.update({ ...state });
  assert.equal(h.calls.filter((c) => c.name === '#detail').length, 1);
  h.motion.update({ ...state, detail: 'ticket-2' });
  assert.equal(h.calls.filter((c) => c.name === '#detail').length, 2);
  h.motion.destroy();
});

test('reduced motion skips entrances and exits and cancels animations when enabled live', async () => {
  const h = harness(true);
  h.motion.update({ view: 'picknext', detail: 'ticket-1' });
  await h.motion.exit(h.element('#detail'));
  assert.equal(h.calls.length, 0);
  h.preference(false);
  h.motion.update({ view: 'board', detail: 'ticket-1' });
  assert.ok(h.calls.length > 0);
  h.preference(true);
  assert.ok(h.calls.every((c) => c.animation.cancelled));
  h.motion.destroy();
});

test('interrupted exits resolve without unhandled animation rejections', async () => {
  const h = harness();
  const panel = h.element('#detail');
  const exit = h.motion.exit(panel);
  h.motion.cancelElement(panel);
  await exit;
  assert.equal(h.calls[0].animation.cancelled, true);
  h.motion.destroy();
});
