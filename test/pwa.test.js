import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { startApp } from './helpers.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

describe('aplikace k instalaci (PWA): co posílá server', () => {
  let ctx;
  before(async () => {
    ctx = await startApp();
  });
  after(() => ctx.stop());

  test('manifest je platný, má správný typ a všechny ikony existují', async () => {
    const res = await ctx.client().get('/manifest.webmanifest', { headers: { accept: '*/*' } });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /application\/manifest\+json/);
    const manifest = JSON.parse(res.raw.toString('utf8'));
    assert.equal(manifest.start_url, '/');
    assert.equal(manifest.scope, '/');
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.lang, 'cs');
    assert.ok(manifest.name && manifest.short_name.length <= 12);
    const purposes = new Set();
    for (const icon of manifest.icons) {
      purposes.add(`${icon.purpose}:${icon.sizes}`);
      const file = await ctx.client().get(icon.src, { headers: { accept: '*/*' } });
      assert.equal(file.status, 200, icon.src);
      assert.equal(file.headers['content-type'], 'image/png', icon.src);
      const [width, height] = icon.sizes.split('x').map(Number);
      // Rozměry z hlavičky PNG musí odpovídat tomu, co manifest tvrdí.
      assert.deepEqual([file.raw.readUInt32BE(16), file.raw.readUInt32BE(20)], [width, height], icon.src);
    }
    for (const needed of ['any:192x192', 'any:512x512', 'maskable:512x512']) assert.ok(purposes.has(needed), needed);
  });

  test('service worker se podává z kořene, bez dlouhého ukládání a s bezpečnostními hlavičkami', async () => {
    const res = await ctx.client().get('/sw.js', { headers: { accept: '*/*' } });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /javascript/);
    assert.equal(res.headers['cache-control'], 'no-cache', 'nová verze se musí projevit hned');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.match(res.headers['content-security-policy'], /worker-src 'self'/);
    assert.match(res.headers['content-security-policy'], /connect-src 'self'/);
  });

  test('stránka odkazuje na manifest a ikonu pro iOS', async () => {
    const html = (await ctx.client().get('/', { headers: { accept: 'text/html' } })).raw.toString('utf8');
    assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest"/);
    assert.match(html, /<link rel="apple-touch-icon" href="\/icon-180\.png"/);
    assert.match(html, /name="theme-color"/);
  });
});

// Service worker se tu spouští v izolovaném prostředí s náhražkou sítě
// a mezipaměti, takže jde ověřit, co ukládá a co ne.
function loadWorker() {
  const stores = new Map();
  const cacheFor = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const entries = stores.get(name);
    const key = (request) => (typeof request === 'string' ? new URL(request, 'https://ukoly.test').href : request.url);
    return {
      match: async (request) => entries.get(key(request))?.clone(),
      put: async (request, response) => void entries.set(key(request), response),
      add: async (request) => void entries.set(key(request), await network.fetch(request)),
      delete: async (request) => entries.delete(key(request)),
      keys: async () => [...entries.keys()].map((url) => new Request(url)),
    };
  };
  const network = {
    online: true,
    requests: [],
    responses: new Map(),
    async fetch(request) {
      const url = typeof request === 'string' ? request : request.url;
      network.requests.push(new URL(url).pathname);
      if (!network.online) throw new TypeError('Failed to fetch');
      const make = network.responses.get(new URL(url).pathname);
      const response = make ? make() : new Response(`obsah ${new URL(url).pathname}`, { status: 200, headers: { 'content-type': 'text/plain' } });
      // Odpověď ze sítě stejného původu má typ „basic“.
      Object.defineProperty(response, 'type', { value: 'basic', configurable: true });
      const clone = response.clone.bind(response);
      response.clone = () => {
        const copy = clone();
        Object.defineProperty(copy, 'type', { value: 'basic', configurable: true });
        return copy;
      };
      return response;
    },
  };
  const handlers = {};
  const self = {
    location: new URL('https://ukoly.test/sw.js'),
    addEventListener: (type, handler) => (handlers[type] = handler),
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };
  const context = vm.createContext({
    self,
    caches: { open: async (name) => cacheFor(name), keys: async () => [...stores.keys()], delete: async (name) => stores.delete(name) },
    fetch: (request) => network.fetch(request),
    // V prohlížeči se relativní adresy vztahují k umístění service workeru.
    Request: class extends Request {
      constructor(input, init) {
        super(typeof input === 'string' ? new URL(input, 'https://ukoly.test').href : input, init);
      }
    },
    Response,
    URL,
    Promise,
    Set,
    Math,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(fs.readFileSync(path.join(publicDir, 'sw.js'), 'utf8'), context, { filename: 'sw.js' });

  /** Pošle požadavek service workeru; vrátí odpověď, nebo null, když ho nechal být. */
  async function request(pathname, { method = 'GET', mode = 'no-cors', origin = 'https://ukoly.test' } = {}) {
    let answer = null;
    const req = new Request(origin + pathname, { method });
    Object.defineProperty(req, 'mode', { value: mode });
    handlers.fetch({ request: req, respondWith: (promise) => (answer = promise) });
    return answer;
  }
  async function lifecycle(type) {
    let work = Promise.resolve();
    handlers[type]({ waitUntil: (promise) => (work = promise) });
    await work;
  }
  return { network, stores, request, lifecycle };
}

describe('service worker', () => {
  test('API, zápisy a cizí adresy nechává být a nic z nich neukládá', async () => {
    const sw = loadWorker();
    await sw.lifecycle('install');
    sw.network.requests.length = 0;
    for (const [pathname, options] of [
      ['/api/me', {}],
      ['/api/tasks', {}],
      ['/api/tasks?rooms=1', {}],
      ['/api/photos/AAAAAAAAAAAAAAAAAAAAAA/original', {}],
      ['/api/auth/login', { method: 'POST' }],
      ['/ukol/1', { method: 'POST', mode: 'navigate' }],
      ['/cokoliv.js', { origin: 'https://jinde.example' }],
    ]) {
      assert.equal(await sw.request(pathname, options), null, `${options.method ?? 'GET'} ${pathname}`);
    }
    assert.deepEqual(sw.network.requests, [], 'service worker kvůli nim nic nestahoval');
    const stored = [...sw.stores.values()].flatMap((entries) => [...entries.keys()]);
    assert.ok(stored.every((url) => !url.includes('/api/')), 'v mezipaměti není nic z API');
  });

  test('stránka aplikace: online ze sítě, offline z poslední kopie, a to pro každou adresu', async () => {
    const sw = loadWorker();
    const html = (version) => () => new Response(`<!doctype html>${version}`, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    sw.network.responses.set('/', html('v1'));
    sw.network.responses.set('/ukol/12', html('v2'));
    await sw.lifecycle('install');

    const online = await sw.request('/ukol/12', { mode: 'navigate' });
    assert.equal(await (await online).text(), '<!doctype html>v2', 'online je vždy čerstvá verze');

    sw.network.online = false;
    for (const pathname of ['/', '/ukol/99', '/mistnosti', '/prihlaseni']) {
      const offline = await (await sw.request(pathname, { mode: 'navigate' }));
      assert.equal(offline.status, 200, pathname);
      assert.equal(await offline.text(), '<!doctype html>v2', 'offline poslední načtená verze');
    }
  });

  test('chybová odpověď serveru nepřepíše uloženou stránku', async () => {
    const sw = loadWorker();
    sw.network.responses.set('/', () => new Response('<!doctype html>dobra', { status: 200, headers: { 'content-type': 'text/html' } }));
    await sw.lifecycle('install');
    sw.network.responses.set('/', () => new Response('chyba', { status: 502, headers: { 'content-type': 'text/html' } }));
    const failing = await (await sw.request('/', { mode: 'navigate' }));
    assert.equal(failing.status, 502, 'chybu uživatel uvidí');
    sw.network.online = false;
    assert.equal(await (await (await sw.request('/', { mode: 'navigate' }))).text(), '<!doctype html>dobra');
  });

  test('bez uložené stránky dá offline srozumitelnou odpověď', async () => {
    const sw = loadWorker();
    sw.network.online = false;
    const res = await (await sw.request('/', { mode: 'navigate' }));
    assert.equal(res.status, 503);
    assert.match(await res.text(), /bez připojení/);
  });

  test('skripty a styly: online vždy nová verze, offline poslední uložená', async () => {
    const sw = loadWorker();
    let version = 1;
    sw.network.responses.set('/js/main.js', () => new Response(`verze ${version}`, { status: 200 }));
    assert.equal(await (await (await sw.request('/js/main.js'))).text(), 'verze 1');
    version = 2;
    assert.equal(await (await (await sw.request('/js/main.js'))).text(), 'verze 2', 'po aktualizaci serveru přijde nová verze');
    sw.network.online = false;
    assert.equal(await (await (await sw.request('/js/main.js'))).text(), 'verze 2');
    await assert.rejects(async () => (await sw.request('/js/nikdy-nenacteny.js')), 'co nikdy nebylo načteno, offline není');
  });

  test('nenalezený soubor se neukládá', async () => {
    const sw = loadWorker();
    sw.network.responses.set('/js/neni.js', () => new Response('nenalezeno', { status: 404 }));
    assert.equal((await (await sw.request('/js/neni.js'))).status, 404);
    sw.network.online = false;
    await assert.rejects(async () => (await sw.request('/js/neni.js')));
  });

  test('fotky se berou z mezipaměti a jejich počet má strop', async () => {
    const sw = loadWorker();
    const first = '/media/AAAAAAAAAAAAAAAAAAAAAA/thumb';
    await (await sw.request(first));
    sw.network.requests.length = 0;
    await (await sw.request(first));
    assert.deepEqual(sw.network.requests, [], 'podruhé už bez sítě');

    for (let i = 0; i < 320; i += 1) await (await sw.request(`/media/${String(i).padStart(22, 'B')}/thumb`));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const media = [...sw.stores.entries()].find(([name]) => name.includes('fotky'))[1];
    assert.ok(media.size <= 300, `uloženo ${media.size}`);
    assert.ok(!media.has(`https://ukoly.test${first}`), 'nejstarší fotka vypadla');
  });

  test('po aktivaci zmizí mezipaměti starších verzí, cizí zůstanou', async () => {
    const sw = loadWorker();
    sw.stores.set('ukolnicek-aplikace-v0', new Map());
    sw.stores.set('ukolnicek-fotky-v0', new Map());
    sw.stores.set('neco-jineho', new Map());
    await sw.lifecycle('install');
    await sw.lifecycle('activate');
    assert.deepEqual([...sw.stores.keys()].sort(), ['neco-jineho', 'ukolnicek-aplikace-v1']);
  });
});
