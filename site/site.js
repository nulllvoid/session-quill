/* Shared on every page: theme toggle, copy buttons, live announcements. */
(() => {
const root = document.documentElement;
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const live = document.querySelector('#live');
const announce = (text) => { if (live) live.textContent = text; };

/* Theme */
const themeButton = document.querySelector('.theme-toggle');
function themeLabel() {
  const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
  themeButton.textContent = next === 'dark' ? 'Dark' : 'Light';
  themeButton.setAttribute('aria-label', `Switch to ${next} theme`);
}
themeLabel();
themeButton.addEventListener('click', () => {
  root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('quill-site-theme', root.dataset.theme); } catch { /* optional */ }
  themeLabel();
});

/* Copy buttons */
const copyStatus = document.querySelector('#copy-status');
document.querySelectorAll('[data-copy]').forEach((button) => button.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(button.dataset.copy);
    if (copyStatus) copyStatus.textContent = 'Copied. Paste it inside Claude Code or a terminal.';
    button.textContent = 'Copied';
    announce('Command copied');
    clearTimeout(button.resetTimer);
    button.resetTimer = setTimeout(() => { button.textContent = 'Copy'; }, 2200);
  } catch {
    if (copyStatus) copyStatus.textContent = 'Clipboard unavailable. Select and copy the command above.';
    const code = button.closest('.command-group')?.querySelector('code');
    if (code) { const range = document.createRange(); range.selectNodeContents(code); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); }
  }
}));

window.quillSite = { root, reduced, announce };
})();
