// Service worker Úkolníčku.
//
// Co dělá:
//  - Aplikace (stránka, skripty, styly, písma, ikony) se bere ze sítě, a když
//    síť není nebo je moc pomalá, z poslední uložené kopie. Online je tedy vždy
//    aktuální verze, offline ta naposledy načtená.
//  - Náhledy a fotky (/media/…) se po prvním načtení berou z mezipaměti; soubor
//    pod danou adresou se nikdy nemění.
//
// Co záměrně nedělá:
//  - Na /api/… vůbec nesahá. Odpovědi API závisí na přihlášeném uživateli
//    a do mezipaměti zařízení (třeba sdíleného tabletu) nepatří.
//  - Neukládá nic jiného než GET ze stejné adresy.

const VERSION = 'v1';
const SHELL_CACHE = `ukolnicek-aplikace-${VERSION}`;
const MEDIA_CACHE = `ukolnicek-fotky-${VERSION}`;
const SHELL_URL = '/';
const MEDIA_LIMIT = 300;
const SLOW_NETWORK_MS = 4000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.add(new Request(SHELL_URL, { cache: 'reload' })))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, MEDIA_CACHE]);
      for (const name of await caches.keys()) {
        if (name.startsWith('ukolnicek-') && !keep.has(name)) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (url.pathname.startsWith('/media/')) event.respondWith(mediaFromCache(request));
  else if (request.mode === 'navigate') event.respondWith(page(request));
  else event.respondWith(networkFirst(request));
});

const storable = (response) => response && response.status === 200 && response.type === 'basic';

/** Odpověď ze sítě; `null`, když do limitu nepřijde (síť dál běží na pozadí). */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Stránka aplikace. Všechny adresy (/, /ukol/12, /mistnosti…) vrací tentýž
 * dokument, proto se ukládá pod jedním klíčem.
 */
async function page(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    const type = response.headers.get('content-type') || '';
    if (storable(response) && type.includes('text/html')) await cache.put(SHELL_URL, response.clone());
    return response;
  } catch {
    const cached = await cache.match(SHELL_URL);
    if (cached) return cached;
    return new Response('Úkolníček je teď bez připojení. Zkuste to znovu, až budete online.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

/** Skripty, styly, písma a ikony: nejdřív síť, při výpadku uložená kopie. */
async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  const network = fetch(request).then(async (response) => {
    if (storable(response)) await cache.put(request, response.clone());
    return response;
  });
  if (!cached) return network;
  // Uloženou kopii použijeme, jen když síť selže nebo je nepoužitelně pomalá.
  network.catch(() => {});
  try {
    return (await withTimeout(network, SLOW_NETWORK_MS)) ?? cached;
  } catch {
    return cached;
  }
}

/** Fotky: nejdřív mezipaměť, jinak síť; počet uložených má strop. */
async function mediaFromCache(request) {
  const cache = await caches.open(MEDIA_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (storable(response)) {
    await cache.put(request, response.clone());
    trim(cache).catch(() => {});
  }
  return response;
}

async function trim(cache) {
  const keys = await cache.keys();
  // Klíče jsou v pořadí vložení; pryč jdou nejstarší.
  for (const key of keys.slice(0, Math.max(0, keys.length - MEDIA_LIMIT))) await cache.delete(key);
}
