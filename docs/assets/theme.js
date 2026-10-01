// Light/dark theme. Loaded in <head> so the choice is applied before the page
// paints. A saved choice wins; otherwise the theme follows the system setting.
(() => {
  const root = document.documentElement;
  const system = matchMedia('(prefers-color-scheme: light)');
  let choice = null;
  try { choice = localStorage.getItem('theme'); } catch {}

  function apply() {
    root.dataset.theme = choice === 'light' || choice === 'dark' ? choice : system.matches ? 'light' : 'dark';
    const button = document.getElementById('themeToggle');
    if (button) button.setAttribute('aria-label', `Switch to ${root.dataset.theme === 'dark' ? 'light' : 'dark'} mode`);
  }

  apply();
  system.addEventListener('change', apply);
  // Another tab changed the theme.
  addEventListener('storage', (e) => { if (e.key === 'theme') { choice = e.newValue; apply(); } });
  document.addEventListener('DOMContentLoaded', () => {
    apply();
    document.getElementById('themeToggle')?.addEventListener('click', () => {
      choice = root.dataset.theme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem('theme', choice); } catch {}
      apply();
    });
  });
})();
