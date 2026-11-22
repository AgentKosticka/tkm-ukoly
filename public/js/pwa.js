// Instalace na plochu a běh bez připojení.
//
// Service worker potřebuje zabezpečené spojení (HTTPS nebo localhost). Přes
// obyčejné HTTP se prostě nezaregistruje a aplikace funguje jako běžný web.

import { refreshBoard, refreshMe } from './store.js';
import { toast } from './ui/toast.js';

let installPrompt = null;
const listeners = new Set();

/** Jde aplikaci právě teď nabídnout k instalaci? */
export const canInstall = () => installPrompt !== null;

/** Zavolá se pokaždé, když se možnost instalace objeví nebo zmizí. */
export function onInstallChange(listener) {
  listeners.add(listener);
}

/** Otevře systémový dialog instalace. Smí se volat jen z kliknutí. */
export async function install() {
  const prompt = installPrompt;
  if (!prompt) return;
  // Jedna výzva jde použít jen jednou.
  installPrompt = null;
  for (const listener of listeners) listener();
  await prompt.prompt();
  await prompt.userChoice.catch(() => {});
}

export function startPwa() {
  window.addEventListener('beforeinstallprompt', (event) => {
    // Místo automatického pruhu prohlížeče nabídne instalaci tlačítko v patičce.
    event.preventDefault();
    installPrompt = event;
    for (const listener of listeners) listener();
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    for (const listener of listeners) listener();
  });

  window.addEventListener('offline', () => {
    toast('Jste bez připojení. Úkoly na obrazovce nemusí být aktuální', { duration: 7000 });
  });
  window.addEventListener('online', () => {
    refreshMe().catch(() => {});
    refreshBoard();
  });

  if ('serviceWorker' in navigator && window.isSecureContext) {
    const register = () =>
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
        // Bez service workeru aplikace běží dál, jen ne offline.
      });
    // Až po načtení stránky, aby registrace nesoupeřila s prvním vykreslením.
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
  }
}
