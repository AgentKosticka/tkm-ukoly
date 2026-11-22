import { h } from '../dom.js';
import { reducedMotion } from '../spring.js';

const container = () => document.getElementById('toasts');
const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';

/** Krátké oznámení dole. Volitelně s jednou akcí, např. „Zkusit znovu“. */
export function toast(message, { action, duration = 4500 } = {}) {
  const el = h('div', { class: 'toast' }, h('span', null, message));
  let timer = 0;

  function dismiss() {
    clearTimeout(timer);
    const out = el.animate(
      reducedMotion() ? [{ opacity: 1 }, { opacity: 0 }] : [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(8px)' }],
      { duration: 160, easing: 'ease-in', fill: 'forwards' },
    );
    out.finished.then(() => el.remove());
  }

  if (action) {
    el.append(
      h(
        'button',
        {
          class: 'toast-action',
          type: 'button',
          onClick: () => {
            dismiss();
            action.onSelect();
          },
        },
        action.label,
      ),
    );
  }

  container().append(el);
  el.animate(
    reducedMotion() ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: 'translateY(12px)' }, { opacity: 1, transform: 'none' }],
    { duration: 320, easing: EASE },
  );
  timer = setTimeout(dismiss, action ? Math.max(duration, 7000) : duration);
  // Starší oznámení se nehromadí.
  const all = [...container().children];
  for (const old of all.slice(0, Math.max(0, all.length - 3))) old.remove();
  return dismiss;
}

export function toastError(error) {
  if (error?.code === 'aborted') return;
  toast(error?.message ?? 'Něco se nepovedlo. Zkuste to prosím znovu');
}
