// Animate user-driven changes, never the worker's two-second polling cycle.
export function createDashboardMotion(root, media) {
  let previous = null;
  const running = new Map();
  const ease = 'cubic-bezier(0.22, 1, 0.36, 1)';

  function cancelElement(element) {
    running.get(element)?.cancel();
    running.delete(element);
  }

  function play(element, frames, options = {}) {
    if (!element || media.matches || !element.animate) return Promise.resolve();
    cancelElement(element);
    const animation = element.animate(frames, { duration: 320, easing: ease, ...options });
    running.set(element, animation);
    return animation.finished.catch(() => {}).finally(() => {
      if (running.get(element) === animation) running.delete(element);
    });
  }

  function enter(element, delay = 0, distance = 10) {
    return play(element, [
      { opacity: 0, transform: `translateY(${distance}px)` },
      { opacity: 1, transform: 'translateY(0)' },
    ], { delay, fill: 'backwards' });
  }

  function update(state) {
    const last = previous;
    previous = { ...state };
    if (media.matches) return;
    if (!last || last.view !== state.view) {
      enter(root.querySelector('.page-heading'), 0, 8);
      // Animate groups, not every row in large tables or every card in the board.
      const groups = root.querySelectorAll('.work-overview, .inbox, .picknext-grid > .card, .blocked-list, .board > .column, .tree, .table-wrap, .env-matrix, .view > .empty, .today-day');
      [...groups].slice(0, 12).forEach((element, i) => enter(element, Math.min(i * 35, 175), 12));
      if (last) play(root.querySelector('.nav-item[aria-selected="true"]'), [{ opacity: .55 }, { opacity: 1 }], { duration: 200 });
    } else if (last.results !== state.results) {
      // Search must remain immediate, including during fast typing.
      play(root.querySelector('.main > .view'), [
        { opacity: .6, transform: 'translateY(4px)' },
        { opacity: 1, transform: 'translateY(0)' },
      ], { duration: 180 });
    }
    if (state.detail && state.detail !== last?.detail) {
      play(root.querySelector('#detail'), [
        { opacity: 0, transform: `translateX(${last?.detail ? 8 : 24}px)` },
        { opacity: 1, transform: 'translateX(0)' },
      ], { duration: 300 });
    }
    if (state.receipt && state.receipt !== last?.receipt) enter(root.querySelector('.receipt'), 0, -5);
  }

  function cancelAll() {
    for (const animation of running.values()) animation.cancel();
    running.clear();
  }
  const onPreference = () => { if (media.matches) cancelAll(); };
  media.addEventListener?.('change', onPreference);

  return {
    update,
    cancelElement,
    exit: (element) => play(element, [
      { opacity: 1, transform: 'translateX(0)' },
      { opacity: 0, transform: 'translateX(16px)' },
    ], { duration: 150, easing: 'cubic-bezier(0.4, 0, 1, 1)' }),
    destroy() { cancelAll(); media.removeEventListener?.('change', onPreference); },
  };
}
