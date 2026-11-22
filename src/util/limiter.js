/**
 * Počítadlo neúspěšných pokusů v klouzavém okně, držené v paměti.
 * Klíčů je nejvýš `maxKeys`; při přeplnění se zahazují nejstarší.
 */
export class AttemptLimiter {
  #entries = new Map();

  constructor({ limit, windowMs, maxKeys = 20000 }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
  }

  #fresh(key, now) {
    const entry = this.#entries.get(key);
    if (!entry) return null;
    if (now - entry.start >= this.windowMs) {
      this.#entries.delete(key);
      return null;
    }
    return entry;
  }

  /** Kolik sekund zbývá do odblokování; 0 znamená, že pokus je povolen. */
  retryAfter(key, now = Date.now()) {
    const entry = this.#fresh(key, now);
    if (!entry || entry.count < this.limit) return 0;
    return Math.max(1, Math.ceil((entry.start + this.windowMs - now) / 1000));
  }

  fail(key, now = Date.now()) {
    const entry = this.#fresh(key, now);
    if (entry) {
      entry.count += 1;
      return;
    }
    if (this.#entries.size >= this.maxKeys) {
      const oldest = this.#entries.keys().next().value;
      this.#entries.delete(oldest);
    }
    this.#entries.set(key, { start: now, count: 1 });
  }

  reset(key) {
    this.#entries.delete(key);
  }
}
