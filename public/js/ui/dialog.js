import { append, h } from '../dom.js';
import { Spring, reducedMotion } from '../spring.js';
import { pushLayer } from './overlay.js';

/**
 * Dialog uprostřed obrazovky. Při otevření se zároveň zvětšuje a zprůhledňuje,
 * aby působil jako věc, která přišla, ne jako pouhé prolnutí.
 */
export function openDialog({ label, wide = false, dismissable = true, onClosed, initialFocus }) {
  const scrim = h('div', { class: 'scrim over' });
  const el = h('div', {
    class: `dialog${wide ? ' wide' : ''}`,
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': label,
    tabindex: '-1',
  });
  const wrap = h('div', { class: 'dialog-wrap' }, el);
  let closed = false;

  const presence = new Spring(0, {
    response: 0.28,
    precision: 0.002,
    onUpdate(value) {
      scrim.style.opacity = String(Math.min(1, Math.max(0, value)));
      el.style.opacity = String(Math.min(1, Math.max(0, value)));
      el.style.transform = reducedMotion() ? '' : `scale(${0.96 + 0.04 * value})`;
    },
  });

  const layer = pushLayer({
    elements: [scrim, wrap],
    container: el,
    onEscape: () => dismissable && close(),
    initialFocus,
  });

  presence.set(0);
  if (reducedMotion()) {
    el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160 });
    presence.set(1);
  } else {
    presence.to(1);
  }

  wrap.addEventListener('pointerdown', (event) => {
    if (event.target === wrap && dismissable) close();
  });

  async function close(result) {
    if (closed) return;
    closed = true;
    layer.release();
    await presence.to(0, { response: 0.2 });
    layer.remove();
    onClosed?.(result);
  }

  return { el, close };
}

/** Potvrzení nevratné akce. Vrací Promise<boolean>. */
export function confirmDialog({ title, text, confirmLabel, danger = false }) {
  return new Promise((resolve) => {
    const dialog = openDialog({ label: title, onClosed: (result) => resolve(result === true) });
    const confirm = h('button', { class: 'btn btn-primary', type: 'button', onClick: () => dialog.close(true) }, confirmLabel);
    append(dialog.el, [
      h('h2', { class: 'dialog-title' }, title),
      text && h('p', { class: 'dialog-text' }, text),
      h(
        'div',
        { class: 'dialog-actions' },
        h('button', { class: 'btn btn-secondary', type: 'button', onClick: () => dialog.close(false) }, 'Zrušit'),
        confirm,
      ),
    ]);
    // U nevratných akcí je výchozí bezpečná volba: fokus na „Zrušit“.
    dialog.el.querySelector(danger ? '.btn-secondary' : '.btn-primary').focus();
  });
}
