import { HttpError } from '../http/errors.js';

export const storageUnavailable = () =>
  new HttpError(503, 'storage_unavailable', 'Úložiště fotek teď není dostupné. Zkuste to prosím později');

// Chyby, kterými se ohlašuje úložiště mimo provoz (typicky síťový disk):
// spojení spadlo, server neodpovídá, připojení je neplatné.
const OUTAGE_CODES = new Set([
  'ESTORAGETIMEOUT',
  'EIO',
  'EHOSTDOWN',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTCONN',
  'ECONNABORTED',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ESTALE',
  'ENODEV',
  'ENXIO',
  'EAGAIN',
  'EREMOTEIO',
  'ENOLINK',
  'ECOMM',
]);

const timedOut = () => Object.assign(new Error('úložiště neodpovědělo včas'), { code: 'ESTORAGETIMEOUT' });

/**
 * Pojistka pro práci s úložištěm fotek, které může být na síťovém disku.
 *
 * Čtení z disku, který neodpovídá, může viset desítky sekund a nejde zrušit.
 * Souborové operace přitom sdílejí několik málo pracovních vláken se zbytkem
 * aplikace, takže by výpadek fotek dokázal zastavit celý web. Proto:
 *
 *  - na úložiště smí sahat nejvýš `concurrency` operací najednou; i kdyby
 *    všechny uvízly, zbylá vlákna dál obsluhují ostatní soubory,
 *  - volající čeká nejdéle `timeoutMs` a pak dostane chybu, i když operace
 *    sama dál visí (své místo drží, dokud neskončí),
 *  - po takové chybě se úložiště na `retryMs` považuje za nedostupné a
 *    požadavky se odmítají hned, bez sahání na disk; potom se pustí jediný
 *    zkušební požadavek a podle něj se úložiště vrátí do provozu, nebo ne.
 */
export function createStorageGuard({ concurrency = 2, timeoutMs = 8000, retryMs = 30_000, log, now = Date.now } = {}) {
  let active = 0;
  const waiting = [];
  let down = false;
  let downUntil = 0;
  let probing = false;

  const acquire = () => {
    if (active < concurrency) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => waiting.push(resolve));
  };
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };

  function markDown(reason, { quiet = false } = {}) {
    if (!down && !quiet) log?.error(`Úložiště fotek neodpovídá (${reason}). Fotky se nezobrazí a nepůjdou nahrávat, dokud se nevrátí`);
    down = true;
    downUntil = now() + retryMs;
  }
  function markUp() {
    if (down) log?.info('Úložiště fotek je zpátky');
    down = false;
  }

  /**
   * Provede operaci nad úložištěm. Při výpadku skončí chybou 503; ostatní
   * chyby operace (třeba chybějící soubor) propouští beze změny.
   */
  async function run(operation, { timeout = timeoutMs } = {}) {
    let probe = false;
    if (down) {
      if (now() < downUntil || probing) throw storageUnavailable();
      probing = true;
      probe = true;
    }

    let timer;
    let expired = false;
    const work = (async () => {
      await acquire();
      try {
        // Než přišla řada, volající už to vzdal nebo úložiště vypadlo.
        if (expired) throw timedOut();
        if (down && !probe) throw storageUnavailable();
        return await operation();
      } finally {
        release();
      }
    })();
    const limit = new Promise((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        reject(timedOut());
      }, timeout);
    });

    try {
      const result = await Promise.race([work, limit]);
      markUp();
      return result;
    } catch (err) {
      if (OUTAGE_CODES.has(err?.code)) {
        markDown(err.code === 'ESTORAGETIMEOUT' ? `bez odpovědi do ${Math.round(timeout / 1000)} s` : err.code);
        throw storageUnavailable();
      }
      throw err;
    } finally {
      clearTimeout(timer);
      if (probe) probing = false;
      // Operace, která doběhne až po limitu, už nikoho nezajímá.
      work.catch(() => {});
    }
  }

  return {
    run,
    markDown,
    get down() {
      return down;
    },
    get busy() {
      return active;
    },
  };
}
