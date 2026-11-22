// Pružinové animace. Pružina nemá pevnou délku: pokaždé vychází z aktuální
// hodnoty a rychlosti, takže ji jde kdykoliv přerušit a přesměrovat bez
// škubnutí. Parametry odpovídají tomu, jak o pružinách mluví Apple:
//   response – jak rychle se hodnota dostane k cíli (v sekundách),
//   damping  – 1 znamená dojezd bez překmitu, méně znamená lehké zhoupnutí.

const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
export const reducedMotion = () => motionQuery.matches;

const active = new Set();
let frame = 0;
let last = 0;

function tick(now) {
  // Po návratu z pozadí by jeden dlouhý krok pružinu rozhodil.
  const dt = Math.min(0.032, (now - last) / 1000 || 0.016);
  last = now;
  for (const spring of [...active]) spring.step(dt);
  frame = active.size > 0 ? requestAnimationFrame(tick) : 0;
}

function schedule(spring) {
  active.add(spring);
  if (!frame) {
    last = performance.now();
    frame = requestAnimationFrame(tick);
  }
}

export class Spring {
  constructor(value, { response = 0.35, damping = 1, precision = 0.1, onUpdate } = {}) {
    this.value = value;
    this.target = value;
    this.velocity = 0;
    this.response = response;
    this.damping = damping;
    this.precision = precision;
    this.onUpdate = onUpdate;
    this.resolve = null;
  }

  /**
   * Zamíří k novému cíli z aktuální hodnoty. `velocity` je počáteční rychlost
   * v jednotkách za sekundu, typicky rychlost prstu při puštění.
   * Vrací Promise: true, když pružina dojela, false, když ji něco přerušilo.
   */
  to(target, { velocity, response, damping } = {}) {
    this.finish(false);
    this.target = target;
    if (velocity !== undefined) this.velocity = velocity;
    if (response !== undefined) this.response = response;
    if (damping !== undefined) this.damping = damping;
    // Bez pohybu na přání uživatele; a také na pozadí, kde prohlížeč snímky
    // nevykresluje a animace by zůstala viset.
    if (reducedMotion() || document.visibilityState === 'hidden') {
      this.set(target);
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      this.resolve = resolve;
      schedule(this);
    });
  }

  /** Nastaví hodnotu okamžitě, např. při tažení prstem. */
  set(value) {
    this.finish(false);
    this.value = value;
    this.target = value;
    this.velocity = 0;
    this.onUpdate?.(value);
  }

  stop() {
    this.finish(false);
    this.target = this.value;
  }

  get moving() {
    return active.has(this);
  }

  finish(completed) {
    active.delete(this);
    const resolve = this.resolve;
    this.resolve = null;
    resolve?.(completed);
  }

  step(dt) {
    const stiffness = (2 * Math.PI / this.response) ** 2;
    const friction = (4 * Math.PI * this.damping) / this.response;
    // Krátké dílčí kroky drží výpočet stabilní i pro tuhé pružiny.
    const steps = Math.ceil(dt / 0.004);
    const h = dt / steps;
    for (let i = 0; i < steps; i += 1) {
      const force = -stiffness * (this.value - this.target) - friction * this.velocity;
      this.velocity += force * h;
      this.value += this.velocity * h;
    }
    const settled =
      Math.abs(this.value - this.target) < this.precision && Math.abs(this.velocity) < this.precision * 20;
    if (settled) {
      this.value = this.target;
      this.velocity = 0;
    }
    this.onUpdate?.(this.value);
    if (settled) this.finish(true);
  }
}

/**
 * Kam by hodnota dojela setrvačností, kdyby ji nic nezastavilo. Stejný
 * exponenciální dojezd jako u posouvání obsahu.
 */
export function project(velocity, deceleration = 0.998) {
  return ((velocity / 1000) * deceleration) / (1 - deceleration);
}

/** Odpor za hranou: čím dál za ní, tím méně se obsah hýbe. */
export function rubberband(overshoot, dimension, constant = 0.55) {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

/** Sleduje poslední pohyby ukazatele a umí z nich vrátit rychlost v px/s. */
export class VelocityTracker {
  constructor() {
    this.samples = [];
  }

  add(x, y, time = performance.now()) {
    this.samples.push({ x, y, time });
    while (this.samples.length > 2 && time - this.samples[0].time > 100) this.samples.shift();
  }

  get() {
    const first = this.samples[0];
    const lastSample = this.samples[this.samples.length - 1];
    if (!first || first === lastSample) return { x: 0, y: 0 };
    // Když prst před puštěním zastavil, žádná setrvačnost se nepředává.
    if (performance.now() - lastSample.time > 80) return { x: 0, y: 0 };
    const dt = (lastSample.time - first.time) / 1000;
    if (dt <= 0) return { x: 0, y: 0 };
    return { x: (lastSample.x - first.x) / dt, y: (lastSample.y - first.y) / dt };
  }
}

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** Přivlastní si ukazatel, aby tažení pokračovalo i mimo prvek. */
export function capturePointer(element, pointerId) {
  try {
    element.setPointerCapture(pointerId);
  } catch {
    // Ukazatel už neexistuje (např. zrušené gesto); tažení se obejde i bez něj.
  }
}
