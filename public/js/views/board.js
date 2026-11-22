import { media } from '../api.js';
import { clear, gear, h, icon, photoThumb } from '../dom.js';
import { GENERAL_ROOM, STATUS, STATUSES, count, eventDate, isoDate, shortDate } from '../format.js';
import { isMember, loadMoreDone, refreshBoard, roomName, store, toggleRoom } from '../store.js';
import { segmented } from '../ui/segmented.js';
import { toastError } from '../ui/toast.js';
import { cardDragActive, enableCardDrag } from './drag.js';
import { openNewTask } from './task-form.js';

let root = null;
let activeTab = 'todo';
let tabs = null;
let firstPaint = true;

export function mountBoard(main) {
  if (root?.isConnected) return;
  root = h('div', { class: 'board-view' });
  clear(main).append(root);
  renderBoard();
}

export function unmountBoard() {
  root = null;
  tabs = null;
}

function card(task, index) {
  const meta = h('div', { class: 'card-meta mono' });
  // Místnost se u karty uvádí, jen když to z výběru není zřejmé.
  const room = store.filter.size === 1 ? null : roomName(task.roomId);
  if (room) meta.append(h('span', { class: 'card-room' }, room));
  meta.append(h('time', { datetime: isoDate(task.statusChangedAt) }, shortDate(task.statusChangedAt)));
  if (task.author) meta.append(h('span', { class: 'card-author' }, task.author));
  if (task.photoCount > 0) {
    meta.append(
      h(
        'span',
        { class: 'card-photos', 'aria-label': count(task.photoCount, 'fotka', 'fotky', 'fotek') },
        icon('image'),
        String(task.photoCount),
      ),
    );
  }

  const el = h(
    'a',
    {
      class: `card${firstPaint && index < 6 ? ' rise' : ''}`,
      href: `/ukol/${task.id}`,
      'data-link': true,
      dataset: { id: String(task.id), status: task.status },
      draggable: 'false',
    },
    h(
      'div',
      { class: 'card-body' },
      h('h3', { class: 'card-title' }, task.title),
      task.excerpt && h('p', { class: 'card-excerpt' }, task.excerpt),
      meta,
    ),
    // Malý náhled první fotky; velké fotky patří do detailu.
    task.cover &&
      h(
        'div',
        { class: 'card-thumb', style: { backgroundColor: task.cover.color } },
        photoThumb(media.thumb(task.cover.id)),
      ),
  );
  if (firstPaint) el.style.setProperty('--i', String(index));
  return el;
}

function column(status) {
  const data = store.board.columns[status];
  const total = store.board.counts[status];
  const list = h('div', { class: 'cards', dataset: { status } });
  if (data.tasks.length === 0) list.append(h('p', { class: 'column-empty' }, STATUS[status].empty));
  else data.tasks.forEach((task, index) => list.append(card(task, index)));

  const el = h(
    'section',
    { class: 'column', dataset: { status }, 'aria-labelledby': `col-${status}` },
    h(
      'header',
      { class: 'column-head' },
      gear(status),
      h('h2', { class: 'column-title', id: `col-${status}` }, STATUS[status].label),
      h('span', { class: 'count' }, String(total)),
    ),
    list,
  );

  if (status === 'done' && data.nextCursor) {
    const more = h(
      'button',
      {
        class: 'btn btn-secondary btn-block column-more',
        type: 'button',
        onClick: async () => {
          more.disabled = true;
          try {
            await loadMoreDone();
          } catch (error) {
            more.disabled = false;
            toastError(error);
          }
        },
      },
      'Zobrazit starší',
    );
    el.append(more);
  }
  return el;
}

function summary() {
  const { todo, doing, done } = store.board.counts;
  const total = todo + doing + done;
  const parts = [count(total, 'úkol', 'úkoly', 'úkolů')];
  if (total > 0) parts.push(`${done} hotovo`);
  if (doing > 0) parts.push(`na ${doing} se pracuje`);

  // Jeden vodorovný pruh: podíl hotových, rozpracovaných a čekajících.
  const bar = h('div', {
    class: 'progress',
    role: 'img',
    'aria-label': total > 0 ? `Hotovo ${done} z ${total}, rozpracováno ${doing}` : 'Zatím žádné úkoly',
  });
  if (total > 0) {
    for (const [status, value] of [['done', done], ['doing', doing], ['todo', todo]]) {
      if (value > 0) bar.append(h('span', { class: `progress-part progress-${status}`, style: { flexGrow: String(value) } }));
    }
  }
  return h(
    'div',
    { class: 'board-head' },
    h('div', { class: 'board-heading' }, h('h1', { class: 'page-title' }, 'Úkoly'), h('p', { class: 'board-sub' }, parts.join(' · '))),
    total > 0 && h('div', { class: 'board-progress' }, bar, h('span', { class: 'mono board-percent' }, `${Math.round((done / total) * 100)} %`)),
  );
}

/**
 * Výběr místností: „Vše“, nebo libovolná kombinace místností a „Obecné“
 * (úkoly bez místnosti). Dokud správce žádnou místnost nezaložil, není co vybírat.
 */
function roomFilter() {
  if (store.rooms.length === 0) return null;
  const chip = (label, id, pressed) =>
    h(
      'button',
      {
        class: 'chip',
        type: 'button',
        'aria-pressed': String(pressed),
        onClick: () => toggleRoom(id).catch(toastError),
      },
      label,
    );
  return h(
    'div',
    { class: 'room-filter', role: 'group', 'aria-label': 'Místnosti' },
    chip('Vše', null, store.filter.size === 0),
    store.rooms.map((room) => chip(room.name, room.id, store.filter.has(room.id))),
    chip(GENERAL_ROOM, 0, store.filter.has(0)),
  );
}

/** Upozornění, že nástěnku nejde obnovit a je vidět starší stav. */
function staleNotice() {
  if (!store.staleSince) return null;
  const retry = h(
    'button',
    {
      class: 'btn btn-quiet',
      type: 'button',
      onClick: async () => {
        retry.disabled = true;
        await refreshBoard();
        retry.disabled = false;
      },
    },
    'Zkusit znovu',
  );
  return h(
    'div',
    { class: 'stale', role: 'status' },
    icon('alert'),
    h('span', { class: 'stale-text' }, 'Bez připojení. Vidíte stav z ', h('time', { datetime: isoDate(store.staleSince) }, eventDate(store.staleSince)), '.'),
    retry,
  );
}

function emptySelection() {
  return h(
    'div',
    { class: 'board-empty board-empty-filtered' },
    h('p', { class: 'board-empty-text' }, 'Ve vybraných místnostech teď žádné úkoly nejsou.'),
    h('button', { class: 'btn btn-secondary', type: 'button', onClick: () => toggleRoom(null).catch(toastError) }, 'Zobrazit všechny místnosti'),
  );
}

function emptyBoard() {
  const member = isMember();
  return h(
    'div',
    { class: 'board-empty' },
    h('div', { class: 'board-empty-mark', 'aria-hidden': 'true' }),
    h('h1', { class: 'page-title' }, 'Zatím tu nejsou žádné úkoly'),
    h(
      'p',
      { class: 'board-empty-text' },
      member
        ? 'Zapište první věc, kterou je v klubu potřeba udělat. Fotky k ní přidáte hned potom.'
        : 'Úkoly zapisují členové klubu po přihlášení. Jakmile nějaký přibude, uvidíte ho tady.',
    ),
    member
      ? h('button', { class: 'btn btn-primary btn-lg', type: 'button', onClick: openNewTask }, icon('plus'), 'Založit první úkol')
      : h('a', { class: 'btn btn-secondary btn-lg', href: '/prihlaseni', 'data-link': true }, 'Přihlásit se'),
  );
}

function tabLabel(status) {
  return [gear(status), h('span', null, STATUS[status].short), h('span', { class: 'count' }, String(store.board.counts[status]))];
}

let renderPending = false;

export function renderBoard() {
  if (!root?.isConnected) return;
  if (cardDragActive()) {
    renderPending = true;
    return;
  }
  renderPending = false;

  if (!store.board) {
    clear(root);
    if (store.boardError) {
      root.append(
        h(
          'div',
          { class: 'board-empty' },
          h('h1', { class: 'page-title' }, 'Úkoly se nepodařilo načíst'),
          h('p', { class: 'board-empty-text' }, store.boardError.message),
          h('button', { class: 'btn btn-secondary btn-lg', type: 'button', onClick: () => refreshBoard() }, 'Zkusit znovu'),
        ),
      );
    }
    return;
  }

  const { todo, doing, done } = store.board.counts;
  if (todo + doing + done === 0) {
    tabs = null;
    firstPaint = false;
    if (store.filter.size > 0) {
      // Prázdný je jen výběr, ne celá nástěnka.
      clear(root).append(staleNotice() ?? '', summary(), roomFilter() ?? '', emptySelection());
    } else {
      clear(root).append(emptyBoard());
    }
    return;
  }

  // Posun stránky i sloupců se při překreslení zachová.
  const scroll = window.scrollY;
  tabs = segmented({
    label: 'Stav úkolů',
    touch: true,
    value: activeTab,
    options: STATUSES.map((status) => ({ value: status, label: STATUS[status].label, content: tabLabel(status) })),
    onChange: (value) => {
      activeTab = value;
      board.dataset.active = value;
    },
  });
  const board = h('div', { class: 'board', dataset: { active: activeTab } }, STATUSES.map(column));
  // Posun řady s místnostmi (na mobilu se posouvá do stran) se zachová.
  const filterScroll = root.querySelector('.room-filter')?.scrollLeft ?? 0;
  const filter = roomFilter();
  clear(root);
  for (const node of [staleNotice(), summary(), filter, h('div', { class: 'board-tabs' }, tabs.el), board]) {
    if (node) root.append(node);
  }
  if (filter) filter.scrollLeft = filterScroll;
  window.scrollTo(0, scroll);

  if (isMember()) {
    enableCardDrag(board, {
      onEnd: () => {
        if (renderPending) renderBoard();
      },
    });
  }
  firstPaint = false;
}

/** Na mobilu přepne na sloupec, ve kterém úkol právě je. */
export function showStatus(status) {
  activeTab = status;
  tabs?.set(status);
  const board = root?.querySelector('.board');
  if (board) board.dataset.active = status;
}
