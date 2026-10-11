/* Landing page only: the hero dispatch sequence and scroll reveals (GSAP). */
(() => {
const { root, reduced, announce } = window.quillSite;
let paused = false;
const pauseButton = document.querySelector('[data-pause]');
function updatePause() {
  root.dataset.motion = paused ? 'paused' : 'playing';
  pauseButton.textContent = paused ? 'Resume animation' : 'Pause animation';
  pauseButton.setAttribute('aria-pressed', String(paused));
}
pauseButton?.addEventListener('click', () => {
  paused = !paused;
  heroTimeline?.paused(paused);
  updatePause();
});

/* Hero: five cards selected, one batch queued, two read-only runs at a time, every run self-checked. */
const hero = {
  cards: [...document.querySelectorAll('[data-card]')],
  bulkbar: document.querySelector('[data-bulkbar]'),
  count: document.querySelector('[data-count]'),
  analyze: document.querySelector('[data-analyze]'),
  strip: document.querySelector('[data-strip]'),
  stripChip: document.querySelector('[data-strip] .chip'),
  stripText: document.querySelector('[data-strip-text]'),
  receipt: document.querySelector('[data-receipt]'),
};
let heroTimeline;
function setCard(card, state) {
  const [runChip, checkChip] = card.querySelectorAll('.chip');
  const input = card.querySelector('input');
  if (state === 'reset') { input.checked = false; runChip.hidden = true; checkChip.hidden = true; return; }
  if (state === 'checked') { input.checked = true; return; }
  input.checked = false;
  runChip.hidden = false;
  runChip.dataset.state = state;
  runChip.innerHTML = state === 'running' ? '<span class="dot pulse"></span>Running' : state === 'done' ? 'Done' : 'Queued';
  checkChip.hidden = state !== 'done';
}
function setStrip(text, state) {
  hero.stripText.textContent = text;
  hero.stripChip.dataset.state = state;
  const dot = hero.stripChip.querySelector('.dot');
  if (dot) dot.classList.toggle('pulse', state === 'running');
}
function heroStatic(final) {
  heroTimeline?.kill(); heroTimeline = null;
  hero.cards.forEach((card) => setCard(card, final ? 'done' : 'reset'));
  hero.bulkbar.hidden = true; hero.bulkbar.style.cssText = '';
  hero.strip.hidden = !final;
  if (final) { setStrip('5 done, 0 failed', 'done'); hero.receipt.textContent = 'Batch 7f3a finished: 5 suggestions ready'; }
  else hero.receipt.textContent = 'Select mode on';
}
function heroPlay() {
  if (!hero.cards.length) return;
  if (!window.gsap || reduced.matches || paused) { heroStatic(true); return; }
  heroStatic(false);
  const tl = gsap.timeline({ delay: .9 });
  hero.cards.forEach((card, index) => {
    tl.call(() => {
      setCard(card, 'checked');
      hero.count.textContent = String(index + 1);
      hero.receipt.textContent = `${index + 1} selected`;
      if (index === 0) { hero.bulkbar.hidden = false; gsap.fromTo(hero.bulkbar, { y: 10, opacity: 0 }, { y: 0, opacity: 1, duration: .35, ease: 'power3.out' }); }
    }, null, .35 * index);
  });
  tl.call(() => hero.analyze.classList.add('pressed'), null, '+=.6');
  tl.call(() => hero.analyze.classList.remove('pressed'), null, '+=.2');
  tl.call(() => {
    gsap.to(hero.bulkbar, { opacity: 0, y: 8, duration: .25, onComplete: () => { hero.bulkbar.hidden = true; hero.bulkbar.style.cssText = ''; } });
    hero.cards.forEach((card) => setCard(card, 'queued'));
    hero.strip.hidden = false;
    gsap.fromTo(hero.strip, { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: .35 });
    setStrip('5 queued', 'running');
    hero.receipt.textContent = 'Queued 5 analyse runs (batch 7f3a)';
    announce('Five analyse runs queued as one batch');
  }, null, '+=.15');
  const waves = [[0, 1], [2, 3], [4]];
  let done = 0;
  waves.forEach((wave) => {
    tl.call(() => { wave.forEach((i) => setCard(hero.cards[i], 'running')); setStrip(`${wave.length} running, ${5 - done - wave.length} queued`, 'running'); }, null, '+=.7');
    tl.call(() => { wave.forEach((i) => setCard(hero.cards[i], 'done')); done += wave.length; setStrip(done === 5 ? '5 done, 0 failed' : `${done} done, ${5 - done} queued`, done === 5 ? 'done' : 'running'); if (done === 5) hero.receipt.textContent = 'Batch 7f3a finished: 5 suggestions ready'; }, null, '+=1.3');
  });
  heroTimeline = tl;
}
document.querySelector('[data-replay]')?.addEventListener('click', () => { if (reduced.matches) return; paused = false; updatePause(); heroPlay(); });

/* Scroll reveals */
let motionContext;
function setupMotion() {
  motionContext?.revert();
  if (!window.gsap || !window.ScrollTrigger || reduced.matches || paused) { document.querySelectorAll('.reveal').forEach((el) => { el.style.opacity = ''; el.style.transform = ''; }); return; }
  gsap.registerPlugin(ScrollTrigger);
  motionContext = gsap.context(() => {
    gsap.from('.hero h1 .line > span', { yPercent: 110, opacity: 0, duration: 1.1, stagger: .12, ease: 'power4.out' });
    gsap.from('.hero-enter', { y: 18, opacity: 0, duration: .8, stagger: .1, delay: .2, ease: 'power3.out' });
    gsap.utils.toArray('.reveal').forEach((element) => gsap.from(element, { y: 36, opacity: 0, duration: .85, ease: 'power3.out', scrollTrigger: { trigger: element, start: 'top 92%', once: true } }));
  });
}
reduced.addEventListener('change', () => { setupMotion(); heroPlay(); });
setupMotion();
// Start the demonstration when it is visible, not while the visitor reads the hero.
const previewObserver = new IntersectionObserver((entries) => {
  if (entries.some((entry) => entry.isIntersecting)) {
    heroPlay();
    previewObserver.disconnect();
  }
}, { threshold: .2 });
previewObserver.observe(document.querySelector('.hero-visual'));
window.addEventListener('pagehide', () => { motionContext?.revert(); heroTimeline?.kill(); });
window.addEventListener('pageshow', (event) => { if (event.persisted) { setupMotion(); heroPlay(); } });
})();
