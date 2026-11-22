import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

// Pružiny běží v prohlížeči; pro test stačí náhražka času a pár globálů.
let Spring;
let project;
let rubberband;
let VelocityTracker;
let now = 0;
let queue = [];

function frames(count, step = 1000 / 60) {
  for (let i = 0; i < count; i += 1) {
    now += step;
    const callbacks = queue;
    queue = [];
    for (const callback of callbacks) callback(now);
  }
}

before(async () => {
  globalThis.window = { matchMedia: () => ({ matches: false }) };
  globalThis.document = { visibilityState: 'visible' };
  globalThis.requestAnimationFrame = (callback) => queue.push(callback);
  Object.defineProperty(globalThis, 'performance', { value: { now: () => now }, configurable: true });
  ({ Spring, project, rubberband, VelocityTracker } = await import('../public/js/spring.js'));
});

describe('pružiny', () => {
  test('bez tlumení navíc dojede k cíli a nepřekmitne', async () => {
    const seen = [];
    const spring = new Spring(0, { response: 0.35, damping: 1, onUpdate: (v) => seen.push(v) });
    const done = spring.to(100);
    frames(120);
    assert.equal(await done, true);
    assert.equal(spring.value, 100);
    assert.ok(Math.max(...seen) <= 100.0001, 'kriticky tlumená pružina cíl nepřekročí');
    assert.ok(seen.every((v, i) => i === 0 || v >= seen[i - 1] - 1e-9), 'hodnota jen roste');
  });

  test('s nižším tlumením se lehce zhoupne a pak ustálí', async () => {
    const seen = [];
    const spring = new Spring(0, { response: 0.35, damping: 0.8, onUpdate: (v) => seen.push(v) });
    const done = spring.to(100);
    frames(180);
    assert.equal(await done, true);
    const peak = Math.max(...seen);
    assert.ok(peak > 100.5 && peak < 108, `překmit ${peak}`);
    assert.equal(spring.value, 100);
  });

  test('přesměrování uprostřed pohybu naváže bez skoku', async () => {
    const seen = [];
    const spring = new Spring(0, { response: 0.4, onUpdate: (v) => seen.push(v) });
    const first = spring.to(100);
    frames(8);
    const at = spring.value;
    const speed = spring.velocity;
    assert.ok(at > 5 && at < 95 && speed > 0);
    const second = spring.to(0);
    assert.equal(await first, false, 'přerušená animace to ohlásí');
    frames(1);
    // Hned po obratu se hodnota ještě chvíli nese původním směrem: rychlost se neztratila.
    assert.ok(spring.value > at, 'žádné zaseknutí o „zeď“');
    assert.ok(Math.abs(spring.value - at) < 12, 'žádný skok');
    frames(200);
    assert.equal(await second, true);
    assert.equal(spring.value, 0);
  });

  test('rychlost prstu se předá do animace', async () => {
    const slow = new Spring(0, { response: 0.4 });
    const fast = new Spring(0, { response: 0.4 });
    slow.to(100);
    fast.to(100, { velocity: 2000 });
    frames(3);
    assert.ok(fast.value > slow.value + 30);
  });

  test('set zastaví pohyb a nastaví hodnotu hned', async () => {
    const spring = new Spring(0);
    const moving = spring.to(100);
    frames(3);
    spring.set(42);
    assert.equal(await moving, false);
    frames(30);
    assert.equal(spring.value, 42);
    assert.equal(spring.moving, false);
  });

  test('na pozadí nebo při omezeném pohybu skočí rovnou do cíle', async () => {
    document.visibilityState = 'hidden';
    const spring = new Spring(0);
    assert.equal(await spring.to(100), true);
    assert.equal(spring.value, 100);
    document.visibilityState = 'visible';
  });

  test('dlouhá prodleva mezi snímky pružinu nerozhodí', async () => {
    const spring = new Spring(0, { response: 0.3 });
    spring.to(100);
    frames(2);
    frames(1, 5000);
    frames(200);
    assert.equal(spring.value, 100);
    assert.ok(Number.isFinite(spring.velocity));
  });
});

describe('setrvačnost a odpor', () => {
  test('dojezd odpovídá exponenciálnímu zpomalování', () => {
    assert.equal(project(0), 0);
    assert.ok(Math.abs(project(1000) - 499) < 0.01);
    assert.ok(Math.abs(project(-1000) + 499) < 0.01);
    assert.ok(Math.abs(project(1000, 0.99) - 99) < 0.01);
  });

  test('odpor za hranou roste a nikdy nepřekročí rozměr', () => {
    let previous = 0;
    for (const distance of [10, 50, 200, 1000, 100000]) {
      const moved = rubberband(distance, 800);
      assert.ok(moved > previous && moved < distance && moved < 800);
      previous = moved;
    }
    assert.equal(rubberband(-100, 800), -rubberband(100, 800));
  });

  test('rychlost se počítá z posledních pohybů a po zastavení je nulová', () => {
    const tracker = new VelocityTracker();
    for (let i = 0; i <= 5; i += 1) tracker.add(i * 10, i * -5, 1000 + i * 10);
    now = 1055;
    const moving = tracker.get();
    assert.ok(Math.abs(moving.x - 1000) < 1 && Math.abs(moving.y + 500) < 1);
    now = 1300;
    assert.deepEqual(tracker.get(), { x: 0, y: 0 });
  });
});
