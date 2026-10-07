try {
  const saved = localStorage.getItem('quill-site-theme');
  if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
} catch { /* Storage is optional. The graphite brand theme remains usable. */ }
