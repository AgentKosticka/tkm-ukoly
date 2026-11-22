import { api } from '../api.js';
import { h } from '../dom.js';
import { STATUS } from '../format.js';
import { Spring, VelocityTracker, reducedMotion } from '../spring.js';
import { findTask, refreshBoard, upsertTask } from '../store.js';
import { toast, toastError } from '../ui/toast.js';

const THRESHOLD = 6;

/**
 * Přetahování karet mezi sloupci myší nebo perem. Karta se drží přesně tam,
 * kde ji uživatel chytil, a po puštění dojede na místo pružinou, která
 * převezme rychlost ruky. Na dotykových displejích se stav mění v detailu,
 * aby se přetahování nepletlo s posouváním stránky.
 */
export function enableCardDrag(board, { onEnd } = {}) {
  board.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'touch' || event.button !== 0 || dragging) return;
    const card = event.target.closest('.card');
    if (!card || !board.contains(card)) return;
    start(board, card, event, onEnd);
  });
}

let dragging = false;
/** Dokud je karta v ruce, nástěnka se nesmí překreslit pod ní. */
export const cardDragActive = () => dragging;

function start(board, card, down, onEnd) {
  const id = Number(card.dataset.id);
  const from = card.dataset.status;
  const tracker = new VelocityTracker();
  let active = false;
  let placeholder = null;
  let target = null;
  let grab = null;
  let x = null;
  let y = null;

  const columnAt = (clientX, clientY) =>
    [...board.querySelectorAll('.column')].find((column) => {
      const rect = column.getBoundingClientRect();
      return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top - 40 && clientY <= rect.bottom + 200;
    }) ?? null;

  function lift(event) {
    active = true;
    dragging = true;
    const rect = card.getBoundingClientRect();
    // Kde přesně byla karta chycena; ten bod zůstane pod ukazatelem.
    grab = { x: down.clientX - rect.left, y: down.clientY - rect.top };
    placeholder = h('div', { class: 'card-placeholder', style: { height: `${rect.height}px` } });
    card.before(placeholder);
    card.style.width = `${rect.width}px`;
    card.style.left = '0';
    card.style.top = '0';
    card.classList.add('dragging');
    document.body.append(card);
    document.documentElement.classList.add('dragging-card');
    const apply = () => {
      card.style.transform = `translate3d(${x.value}px, ${y.value}px, 0) scale(1.02)`;
    };
    // Vodorovný a svislý pohyb mají každý vlastní pružinu.
    x = new Spring(rect.left, { response: 0.32, onUpdate: apply });
    y = new Spring(rect.top, { response: 0.32, onUpdate: apply });
    move(event);
  }

  function move(event) {
    tracker.add(event.clientX, event.clientY);
    if (!active) {
      if (Math.hypot(event.clientX - down.clientX, event.clientY - down.clientY) < THRESHOLD) return;
      lift(event);
      return;
    }
    x.set(event.clientX - grab.x);
    y.set(event.clientY - grab.y);
    const over = columnAt(event.clientX, event.clientY);
    if (over !== target) {
      target?.classList.remove('drop-target');
      target = over;
      if (target && target.dataset.status !== from) target.classList.add('drop-target');
    }
  }

  async function settle(destination, velocity) {
    target?.classList.remove('drop-target');
    const list = destination.querySelector('.cards');
    // Zástupný prvek se přesune na místo, kam karta patří, a karta k němu doletí.
    if (destination.dataset.status !== from) {
      list.querySelector('.column-empty')?.remove();
      list.prepend(placeholder);
    }
    const rect = placeholder.getBoundingClientRect();
    const bounce = Math.hypot(velocity.x, velocity.y) > 400 ? 0.82 : 1;
    if (!reducedMotion()) {
      await Promise.all([
        x.to(rect.left, { velocity: velocity.x, damping: bounce }),
        y.to(rect.top, { velocity: velocity.y, damping: bounce }),
      ]);
    }
    card.classList.remove('dragging');
    card.style.cssText = '';
    placeholder.replaceWith(card);
    document.documentElement.classList.remove('dragging-card');
  }

  async function end(event) {
    cleanup();
    if (!active) return;
    // Po přetažení nesmí následné kliknutí otevřít detail.
    const swallow = (click) => {
      click.preventDefault();
      click.stopPropagation();
    };
    window.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', swallow, true), 60);

    const velocity = tracker.get();
    const destination = event.type === 'pointerup' ? columnAt(event.clientX, event.clientY) : null;
    const to = destination?.dataset.status;
    const origin = board.querySelector(`.column[data-status="${from}"]`);

    if (!to || to === from) {
      await settle(origin, velocity);
      dragging = false;
      onEnd?.();
      return;
    }

    await settle(destination, velocity);
    dragging = false;
    card.dataset.status = to;
    // Změna se ukáže hned; kdyby ji server odmítl, nástěnka se vrátí.
    const before = findTask(id);
    if (before) upsertTask({ ...before, status: to, statusChangedAt: Date.now() });
    try {
      const { task } = await api.updateTask(id, { status: to });
      upsertTask(task);
      toast(`Přesunuto do „${STATUS[to].label}“`, {
        action: {
          label: 'Vrátit',
          onSelect: async () => {
            try {
              upsertTask((await api.updateTask(id, { status: from })).task);
            } catch (error) {
              toastError(error);
            }
          },
        },
      });
    } catch (error) {
      toastError(error);
      refreshBoard();
    }
  }

  function onKey(event) {
    if (event.key === 'Escape' && active) {
      event.preventDefault();
      end({ type: 'cancel' });
    }
  }

  function cleanup() {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    window.removeEventListener('keydown', onKey, true);
  }

  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
  window.addEventListener('keydown', onKey, true);
}
