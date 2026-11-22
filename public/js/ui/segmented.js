import { h } from '../dom.js';
import { Spring } from '../spring.js';

/**
 * Přepínač mezi několika volbami. Vybranou volbu označuje palec, který se
 * k ní přesune pružinou; při rychlém přepínání plynule změní směr.
 *
 * options: [{ value, label, content?: Node[] }]
 */
export function segmented({ label, options, value, onChange, disabled = false, touch = false }) {
  const thumb = h('span', { class: 'segmented-thumb', 'aria-hidden': 'true' });
  const el = h('div', { class: `segmented${touch ? ' touch' : ''}`, role: 'radiogroup', 'aria-label': label }, thumb);
  let current = value;
  let placed = false;

  const x = new Spring(0, { response: 0.3, onUpdate: (v) => (thumb.style.transform = `translate3d(${v}px, 0, 0)`) });
  const width = new Spring(0, { response: 0.3, onUpdate: (v) => (thumb.style.width = `${v}px`) });

  const buttons = options.map((option) => {
    const button = h(
      'button',
      {
        class: 'segmented-option',
        type: 'button',
        role: 'radio',
        'aria-checked': String(option.value === current),
        tabindex: option.value === current ? '0' : '-1',
        disabled,
        dataset: { value: option.value },
        // Stisk se jen zvýrazní (viz :active); volba platí až po uvolnění,
        // takže ji jde zrušit odtažením prstu.
        onClick: () => !disabled && select(option.value, true),
        onKeydown: (event) => {
          const index = options.indexOf(option);
          const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
          if (!step) return;
          event.preventDefault();
          const next = options[(index + step + options.length) % options.length];
          select(next.value, true);
          buttons[options.indexOf(next)].focus();
        },
      },
      option.content ?? option.label,
    );
    return button;
  });
  el.append(...buttons);

  function place(animate) {
    const button = buttons[options.findIndex((o) => o.value === current)];
    if (!button || !el.isConnected || button.offsetWidth === 0) return;
    if (animate && placed) {
      x.to(button.offsetLeft);
      width.to(button.offsetWidth);
    } else {
      x.set(button.offsetLeft);
      width.set(button.offsetWidth);
      placed = true;
    }
  }

  function select(next, notify) {
    if (next === current) return;
    current = next;
    for (const button of buttons) {
      const checked = button.dataset.value === current;
      button.setAttribute('aria-checked', String(checked));
      button.tabIndex = checked ? 0 : -1;
    }
    place(true);
    if (notify) onChange?.(current);
  }

  // Poloha palce závisí na rozměrech, které jsou známé až po vložení do stránky.
  const observer = new ResizeObserver(() => place(false));
  observer.observe(el);

  return {
    el,
    get value() {
      return current;
    },
    /** Nastaví hodnotu zvenku, např. při vrácení neúspěšné změny. */
    set: (next) => select(next, false),
    update(contents) {
      buttons.forEach((button, index) => {
        if (contents[index]) button.replaceChildren(...contents[index]);
      });
      place(false);
    },
  };
}
