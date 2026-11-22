import { h } from '../dom.js';
import { Spring, VelocityTracker, capturePointer, clamp, project, reducedMotion, rubberband } from '../spring.js';
import { pushLayer } from './overlay.js';

const wide = window.matchMedia('(min-width: 48rem)');

/**
 * Panel s detailem. Na širokém displeji přijíždí zprava, na mobilu vyjíždí
 * zdola a dá se stáhnout prstem. Poloha je jedna pružina (0 = otevřeno,
 * `size` = schováno), takže zavírání jde kdykoliv chytit a vrátit.
 */
export function openSheet({ label, onClosed }) {
  const scrim = h('div', { class: 'scrim' });
  const grabber = h('div', { class: 'sheet-grabber', 'aria-hidden': 'true' });
  const header = h('div', { class: 'sheet-header' });
  const body = h('div', { class: 'sheet-body' });
  const el = h('section', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': label, tabindex: '-1' }, grabber, header, body);

  let mode = wide.matches ? 'side' : 'bottom';
  let size = 0;
  let closed = false;
  let dragging = false;

  const measure = () => {
    size = mode === 'side' ? el.offsetWidth + 24 : el.offsetHeight;
  };

  const position = new Spring(0, {
    response: 0.38,
    onUpdate(offset) {
      const transform = mode === 'side' ? `translate3d(${offset}px, 0, 0)` : `translate3d(0, ${offset}px, 0)`;
      el.style.transform = transform;
      scrim.style.opacity = String(clamp(1 - offset / (size || 1), 0, 1));
    },
  });

  const applyMode = () => {
    el.classList.toggle('side', mode === 'side');
    el.classList.toggle('bottom', mode === 'bottom');
  };
  applyMode();

  const layer = pushLayer({ elements: [scrim, el], container: el, onEscape: () => close() });

  measure();
  if (reducedMotion()) {
    // Místo jízdy jen krátké prolnutí.
    position.set(0);
    for (const node of [el, scrim]) node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: 'ease' });
  } else {
    position.set(size);
    position.to(0, { response: 0.38, damping: 1 });
  }

  let closing = false;

  function finish() {
    if (closed) return;
    closed = true;
    wide.removeEventListener('change', onModeChange);
    window.removeEventListener('resize', measure);
    layer.release();
    layer.remove();
    onClosed?.();
  }

  /**
   * Zavře panel; `velocity` je rychlost prstu při puštění. Dokud panel
   * nedojede, jde ho znovu chytit, proto se uklízí až po doběhnutí.
   */
  async function close({ velocity = 0 } = {}) {
    if (closed || closing) return;
    closing = true;
    if (reducedMotion()) {
      await Promise.all(
        [el, scrim].map((node) => node.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' }).finished),
      );
      finish();
      return;
    }
    const done = await position.to(size, { velocity, response: 0.32, damping: 1 });
    closing = false;
    if (done) finish();
  }

  function onModeChange() {
    mode = wide.matches ? 'side' : 'bottom';
    applyMode();
    measure();
    position.set(0);
  }
  wide.addEventListener('change', onModeChange);
  window.addEventListener('resize', measure);

  scrim.addEventListener('click', () => close());

  // Tažení za úchyt a hlavičku (jen spodní list).
  const tracker = new VelocityTracker();
  let startY = 0;
  let startOffset = 0;

  function onPointerDown(event) {
    if (mode !== 'bottom' || closed) return;
    if (event.button !== undefined && event.button !== 0) return;
    if (event.target.closest('button, a, input, textarea')) return;
    dragging = true;
    measure();
    // Chytit jde i rozjetý panel: vychází se z toho, kde právě je.
    position.stop();
    closing = false;
    startY = event.clientY;
    startOffset = position.value;
    tracker.samples.length = 0;
    tracker.add(0, event.clientY);
    capturePointer(event.currentTarget, event.pointerId);
  }

  function onPointerMove(event) {
    if (!dragging) return;
    tracker.add(0, event.clientY);
    const raw = startOffset + (event.clientY - startY);
    // Nahoru už není kam: list klade rostoucí odpor.
    position.set(raw < 0 ? -rubberband(-raw, size) : raw);
  }

  function onPointerUp() {
    if (!dragging) return;
    dragging = false;
    const velocity = tracker.get().y;
    // Rozhoduje, kam by list dojel setrvačností, ne kde ho prst pustil.
    const landing = position.value + project(velocity);
    if (landing > size * 0.5) {
      close({ velocity });
    } else {
      // Zhoupnutí jen tehdy, když list někdo opravdu odhodil.
      position.to(0, { velocity, response: 0.3, damping: Math.abs(velocity) > 300 ? 0.82 : 1 });
    }
  }

  for (const handle of [grabber, header]) {
    handle.addEventListener('pointerdown', onPointerDown);
    handle.addEventListener('pointermove', onPointerMove);
    handle.addEventListener('pointerup', onPointerUp);
    handle.addEventListener('pointercancel', onPointerUp);
  }

  return { el, header, body, close, get closed() { return closed; } };
}
