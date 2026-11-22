// Adresy aplikace: / (nástěnka), /ukol/12 (detail), /prihlaseni,
// /registrace a /uzivatele (správa).

const listeners = new Set();

export function parse(pathname = window.location.pathname) {
  const task = /^\/ukol\/(\d{1,15})\/?$/.exec(pathname);
  if (task) return { name: 'task', id: Number(task[1]) };
  if (pathname === '/prihlaseni') return { name: 'login' };
  if (pathname === '/registrace') return { name: 'register' };
  if (pathname === '/uzivatele') return { name: 'users' };
  return { name: 'board' };
}

export const route = () => parse();

export function onRoute(listener) {
  listeners.add(listener);
}

function emit() {
  for (const listener of listeners) listener(parse());
}

const depth = () => window.history.state?.depth ?? 0;

export function navigate(path, { replace = false } = {}) {
  if (path === window.location.pathname) return;
  if (replace) window.history.replaceState({ depth: depth() }, '', path);
  else window.history.pushState({ depth: depth() + 1 }, '', path);
  emit();
}

/**
 * Zavření detailu nebo dialogu. Když se sem uživatel dostal klikáním
 * v aplikaci, vrátí se o krok zpět, takže tlačítko Zpět v prohlížeči dává smysl.
 */
export function back(fallback = '/') {
  if (depth() > 0) window.history.back();
  else navigate(fallback, { replace: true });
}

window.addEventListener('popstate', emit);

// Odkazy uvnitř aplikace se obsluhují bez načtení stránky.
document.addEventListener('click', (event) => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const link = event.target.closest?.('a[data-link]');
  if (!link || link.origin !== window.location.origin) return;
  event.preventDefault();
  navigate(link.pathname);
});
