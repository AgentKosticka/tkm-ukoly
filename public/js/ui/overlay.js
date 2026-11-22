// Společný základ pro panely a dialogy: zásobník vrstev, klávesa Esc,
// držení fokusu uvnitř horní vrstvy a zneaktivnění všeho pod ní.

const stack = [];
const root = () => document.getElementById('overlays');
const BACKGROUND = ['topbar', 'obsah', 'footer'];

function sync() {
  const top = stack[stack.length - 1];
  document.documentElement.classList.toggle('locked', stack.length > 0);
  for (const id of BACKGROUND) document.getElementById(id).inert = stack.length > 0;
  for (const layer of stack) {
    for (const el of layer.elements) el.inert = layer !== top;
  }
}

function focusable(container) {
  return [...container.querySelectorAll('a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]')].filter(
    (el) => el.offsetParent !== null,
  );
}

document.addEventListener('keydown', (event) => {
  const top = stack[stack.length - 1];
  if (!top) return;
  if (event.key === 'Escape') {
    // Nabídky a prohlížeč fotek si Esc obslouží samy dřív.
    if (event.defaultPrevented) return;
    event.preventDefault();
    top.onEscape?.();
    return;
  }
  if (event.key !== 'Tab') return;
  const items = focusable(top.container);
  if (items.length === 0) {
    event.preventDefault();
    top.container.focus();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const current = document.activeElement;
  if (event.shiftKey && (current === first || !top.container.contains(current))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (current === last || !top.container.contains(current))) {
    event.preventDefault();
    first.focus();
  }
});

/**
 * Zařadí vrstvu nahoru. `elements` jsou uzly vkládané do #overlays,
 * `container` je ten, ve kterém se drží fokus.
 */
export function pushLayer({ elements, container, onEscape, initialFocus }) {
  const layer = { elements, container, onEscape, restore: document.activeElement };
  root().append(...elements);
  stack.push(layer);
  sync();
  const target = initialFocus?.() ?? container;
  target.focus({ preventScroll: true });
  return {
    /** Odebere vrstvu ze zásobníku; samotné uzly maže volající po doběhnutí animace. */
    release() {
      const index = stack.indexOf(layer);
      if (index === -1) return;
      stack.splice(index, 1);
      sync();
      if (layer.restore instanceof HTMLElement && layer.restore.isConnected) {
        layer.restore.focus({ preventScroll: true });
      }
    },
    remove() {
      for (const el of elements) el.remove();
    },
  };
}

export const hasOverlay = () => stack.length > 0;
