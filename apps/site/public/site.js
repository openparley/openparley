// Visitors get the links-only demo. `?dogfood=true` switches this browser to the team's own
// workspace (remembered, so links between pages keep it); `?dogfood=false` switches back.
(() => {
  const key = 'openparley-site:dogfood';
  const flag = new URLSearchParams(location.search).get('dogfood');
  let dogfood = flag === 'true';
  try {
    if (flag === 'true') localStorage.setItem(key, '1');
    else if (flag === 'false') localStorage.removeItem(key);
    else dogfood = localStorage.getItem(key) === '1';
  } catch {}
  const script = document.createElement('script');
  if (dogfood) {
    script.src = 'https://dogfood.openparley.dev/openparley.js';
    script.dataset.project = 'yo-Lp4il1bUc5Kba';
  } else {
    script.src = '/openparley.js';
  }
  document.head.append(script);
})();

// A copy button on every code block (setup commands, the script tag, the AGENTS.md snippet).
document.addEventListener('DOMContentLoaded', () => {
  if (!navigator.clipboard) return;
  for (const pre of document.querySelectorAll('pre')) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'copy';
    button.textContent = 'Copy';
    button.addEventListener('click', () => {
      navigator.clipboard.writeText(pre.querySelector('code')?.textContent ?? '').then(() => {
        button.textContent = 'Copied';
        setTimeout(() => (button.textContent = 'Copy'), 1500);
      });
    });
    pre.append(button);
  }
});
