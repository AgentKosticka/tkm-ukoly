import { h, icon } from '../dom.js';
import { reducedMotion } from '../spring.js';

let current = null;

/**
 * Nabídka ukotvená ke svému tlačítku: vyrůstá z rohu, u kterého tlačítko je,
 * a stejnou cestou mizí.
 *
 * items: [{ label, icon, danger, onSelect } | { separator: true } | { heading }]
 */
export function openMenu(trigger, items) {
  if (current) {
    const wasSame = current.trigger === trigger;
    current.close();
    if (wasSame) return;
  }

  const el = h('div', { class: 'menu', role: 'menu' });
  for (const item of items) {
    if (!item) continue;
    if (item.separator) el.append(h('div', { class: 'menu-separator', role: 'separator' }));
    else if (item.heading) el.append(h('div', { class: 'menu-label' }, item.heading));
    else {
      el.append(
        h(
          'button',
          {
            class: `menu-item${item.danger ? ' danger' : ''}`,
            type: 'button',
            role: 'menuitem',
            onClick: () => {
              close();
              item.onSelect();
            },
          },
          item.icon && icon(item.icon),
          item.label,
        ),
      );
    }
  }

  document.body.append(el);
  const rect = trigger.getBoundingClientRect();
  const width = el.offsetWidth;
  const height = el.offsetHeight;
  const alignRight = rect.right - width >= 8;
  const below = rect.bottom + 6 + height <= window.innerHeight - 8;
  const left = alignRight ? rect.right - width : Math.min(rect.left, window.innerWidth - width - 8);
  const top = below ? rect.bottom + 6 : Math.max(8, rect.top - 6 - height);
  el.style.left = `${Math.max(8, left)}px`;
  el.style.top = `${top}px`;
  el.style.setProperty('--origin', `${below ? 'top' : 'bottom'} ${alignRight ? 'right' : 'left'}`);

  const frames = reducedMotion()
    ? [{ opacity: 0 }, { opacity: 1 }]
    : [
        { opacity: 0, transform: 'scale(0.94)' },
        { opacity: 1, transform: 'scale(1)' },
      ];
  const timing = { duration: 180, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' };
  el.animate(frames, timing);
  trigger.setAttribute('aria-expanded', 'true');

  const entries = () => [...el.querySelectorAll('.menu-item')];
  entries()[0]?.focus({ preventScroll: true });

  function onKey(event) {
    const list = entries();
    const index = list.indexOf(document.activeElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      trigger.focus();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      list[(index + 1) % list.length].focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      list[(index - 1 + list.length) % list.length].focus();
    } else if (event.key === 'Tab') {
      close();
    }
  }
  function onOutside(event) {
    if (!el.contains(event.target) && !trigger.contains(event.target)) close();
  }

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    current = null;
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onOutside, true);
    window.removeEventListener('resize', close);
    window.removeEventListener('scroll', close, true);
    const out = el.animate([...frames].reverse(), { duration: 120, easing: 'ease-in', fill: 'forwards' });
    out.finished.then(() => el.remove());
  }

  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onOutside, true);
  window.addEventListener('resize', close);
  window.addEventListener('scroll', close, true);

  current = { trigger, close };
}
