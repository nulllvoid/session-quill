const root = document.documentElement;
const themeButton = document.querySelector('.theme-toggle');
const themeLabel = () => {
  const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
  themeButton.textContent = `${next[0].toUpperCase()}${next.slice(1)} mode`;
  themeButton.setAttribute('aria-label', `Switch to ${next} theme`);
};
themeLabel();
themeButton.addEventListener('click', () => {
  root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('quill-site-theme', root.dataset.theme); } catch { /* optional */ }
  themeLabel();
});

const previews = {
  pick: { src: 'assets/dashboard-pick-next.jpg', alt: 'Session Quill Pick next dashboard, showing workspace statistics and unlinked work', caption: 'Pick next: the work that deserves your attention.' },
  board: { src: 'assets/dashboard-board-detail.jpg', alt: 'Session Quill Board with a selected ticket, its details, and next action', caption: 'Board: the whole picture, with the next action in reach.' },
};
const productImage = document.querySelector('#product-image');
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
let paused = false;
document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => {
  const preview = previews[button.dataset.view];
  productImage.src = preview.src;
  productImage.alt = preview.alt;
  document.querySelector('#preview-caption').textContent = preview.caption;
  document.querySelectorAll('[data-view]').forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
  if (!reduced.matches && !paused && window.gsap) gsap.fromTo(productImage, { opacity: .3, scale: 1.015 }, { opacity: 1, scale: 1, duration: .45, overwrite: true });
}));
const dialog = document.querySelector('.image-dialog');
document.querySelector('.expand-preview').addEventListener('click', () => {
  const image = dialog.querySelector('img'); image.src = productImage.src; image.alt = productImage.alt;
  dialog.showModal();
});
document.querySelector('.close-dialog').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', (event) => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } });

document.querySelectorAll('[data-copy]').forEach((button) => button.addEventListener('click', async () => {
  const status = document.querySelector('#copy-status');
  try {
    await navigator.clipboard.writeText(button.dataset.copy);
    status.textContent = 'Copied. Paste this command inside Claude Code.';
    button.textContent = 'Copied ✓';
    clearTimeout(button.resetTimer);
    button.resetTimer = setTimeout(() => { button.textContent = 'Copy ↗'; }, 2200);
  } catch {
    status.textContent = 'Clipboard unavailable. Select and copy the command above.';
    const range = document.createRange(); range.selectNodeContents(button.closest('.command-group').querySelector('code'));
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  }
}));

let motionContext;
let mediaContext;
const captions = [
  'A task gets a stable identity, independent of the session.',
  'Switch tasks. Earlier changes keep their original attribution.',
  'Another session can continue the same task, with its history intact.',
];
function showStep(step, animate = true) {
  document.querySelector('#diagram-caption').textContent = captions[step];
  const states = [['.route-b', step === 2 ? 1 : .18], ['.route-c', step === 1 ? 1 : .18], ['.route-d', 1], ['.route-a', step === 1 ? .35 : 1]];
  for (const [selector, opacity] of states) {
    if (animate && window.gsap && !reduced.matches && !paused) gsap.to(selector, { opacity, duration: .65, overwrite: true });
    else document.querySelector(selector).style.opacity = opacity;
  }
  if (animate && window.gsap && !reduced.matches && !paused) gsap.fromTo('.main-task', { y: 8 }, { y: 0, duration: .6, ease: 'power3.out', overwrite: true });
}
function setupMotion() {
  mediaContext?.revert(); motionContext?.revert();
  if (window.gsap) {
    gsap.killTweensOf('.route, .main-task, #product-image');
    gsap.set('.main-task, #product-image', { clearProps: 'transform,opacity' });
  }
  if (!window.gsap || !window.ScrollTrigger || reduced.matches || paused) { showStep(2, false); return; }
  gsap.registerPlugin(ScrollTrigger);
  motionContext = gsap.context(() => {
    gsap.from('.hero h1 .line > span', { yPercent: 110, opacity: 0, duration: 1.2, stagger: .13, ease: 'power4.out' });
    gsap.from('.hero-enter', { y: 20, opacity: 0, duration: .9, stagger: .1, delay: .25, ease: 'power3.out' });
    gsap.from('.hero-art', { opacity: 0, scale: .92, duration: 1.6, ease: 'power3.out', delay: .15 });
    gsap.utils.toArray('.reveal').forEach((element) => gsap.from(element, { y: 42, opacity: 0, duration: .9, ease: 'power3.out', scrollTrigger: { trigger: element, start: 'top 92%', once: true } }));
    gsap.to('.route', { strokeDashoffset: -66, duration: 3.5, ease: 'none', repeat: -1 });
  });
  mediaContext = gsap.matchMedia();
  mediaContext.add('(min-width: 768px)', () => {
    gsap.to('.hero-art img', { y: 90, rotate: 8, ease: 'none', scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: 1 } });
    gsap.from('.screenshot-stage', { rotateX: 7, y: 35, scale: .96, transformOrigin: 'center bottom', ease: 'none', scrollTrigger: { trigger: '.product-figure', start: 'top 90%', end: 'center center', scrub: 1 } });
    document.querySelectorAll('.story-step').forEach((step) => ScrollTrigger.create({ trigger: step, start: 'top 60%', end: 'bottom 60%', onEnter: () => showStep(Number(step.dataset.step)), onEnterBack: () => showStep(Number(step.dataset.step)) }));
    gsap.to('.ownership-visual img', { rotate: 0, scale: 1, ease: 'none', scrollTrigger: { trigger: '.ownership', start: 'top bottom', end: 'bottom top', scrub: 1 } });
  });
  mediaContext.add('(max-width: 767px)', () => showStep(2, false));
}
document.querySelector('.motion-toggle').addEventListener('click', (event) => {
  paused = !paused; root.dataset.motion = paused ? 'paused' : 'playing';
  event.currentTarget.textContent = paused ? 'Resume motion' : 'Pause motion';
  event.currentTarget.setAttribute('aria-pressed', String(paused));
  setupMotion();
});
reduced.addEventListener('change', setupMotion);
setupMotion();
window.addEventListener('pagehide', () => { mediaContext?.revert(); motionContext?.revert(); });
window.addEventListener('pageshow', (event) => { if (event.persisted) setupMotion(); });
