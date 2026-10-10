/* Runs before first paint. Follows the OS like the dashboard; a saved choice wins. */
(function () {
  var theme = null;
  try { var saved = localStorage.getItem('quill-site-theme'); if (saved === 'light' || saved === 'dark') theme = saved; } catch (e) { /* storage is optional */ }
  if (!theme) theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
})();
