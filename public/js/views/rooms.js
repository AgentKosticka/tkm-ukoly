import { api } from '../api.js';
import { append, clear, h, icon } from '../dom.js';
import { GENERAL_ROOM, count } from '../format.js';
import { navigate } from '../router.js';
import { isAdmin, refreshBoard, store } from '../store.js';
import { confirmDialog } from '../ui/dialog.js';
import { toast, toastError } from '../ui/toast.js';

const NAME_MAX = 40;

let root = null;
let data = null;
let loadError = null;
let editing = null;

export function mountRooms(main) {
  if (!isAdmin()) {
    navigate(store.me.user ? '/' : '/prihlaseni', { replace: true });
    return;
  }
  root = h('div', { class: 'admin' });
  clear(main).append(root);
  render();
  load();
}

export function unmountRooms() {
  root = null;
  editing = null;
}

async function load() {
  try {
    data = await api.adminRooms();
    loadError = null;
  } catch (error) {
    loadError = error;
  }
  render();
}

/** Po každé změně se načte seznam znovu a nástěnka se dozví o nových názvech. */
async function changed(message) {
  if (message) toast(message);
  await Promise.all([load(), refreshBoard()]);
}

const tasks = (total, open) =>
  total === 0 ? 'žádné úkoly' : `${count(total, 'úkol', 'úkoly', 'úkolů')}${open > 0 ? `, ${open} nehotových` : ''}`;

function addForm() {
  const input = h('input', {
    class: 'input',
    type: 'text',
    maxlength: NAME_MAX,
    placeholder: 'Název místnosti, např. Robotika',
    'aria-label': 'Název nové místnosti',
    autocomplete: 'off',
    enterkeyhint: 'done',
  });
  const error = h('p', { class: 'error-text', role: 'alert', hidden: true });
  const submit = h('button', { class: 'btn btn-secondary', type: 'submit' }, icon('plus'), 'Přidat místnost');
  return h(
    'form',
    {
      class: 'room-add',
      novalidate: true,
      onSubmit: async (event) => {
        event.preventDefault();
        error.hidden = true;
        if (input.value.trim() === '') {
          input.focus();
          return;
        }
        submit.disabled = true;
        try {
          const { room } = await api.createRoom(input.value);
          await changed(`Místnost „${room.name}“ je založená`);
          // Formulář se překreslil; fokus se vrátí do pole, ať jde psát další.
          root?.querySelector('.room-add input')?.focus();
        } catch (failure) {
          submit.disabled = false;
          error.hidden = false;
          error.textContent = failure.message;
          input.focus();
        }
      },
    },
    h('div', { class: 'room-add-row' }, input, submit),
    error,
  );
}

function roomRow(room) {
  if (editing === room.id) return editRow(room);
  return h(
    'li',
    { class: 'user-row' },
    h('div', { class: 'user-main' }, h('span', { class: 'user-name' }, room.name)),
    h('span', { class: 'mono user-meta' }, tasks(room.taskCount, room.openCount)),
    h(
      'div',
      { class: 'user-actions' },
      h(
        'button',
        {
          class: 'btn btn-quiet btn-icon',
          type: 'button',
          'aria-label': `Přejmenovat místnost ${room.name}`,
          onClick: () => {
            editing = room.id;
            render();
          },
        },
        icon('pencil'),
      ),
      h(
        'button',
        { class: 'btn btn-quiet btn-icon', type: 'button', 'aria-label': `Smazat místnost ${room.name}`, onClick: () => removeRoom(room) },
        icon('trash'),
      ),
    ),
  );
}

function editRow(room) {
  const input = h('input', { class: 'input', type: 'text', maxlength: NAME_MAX, value: room.name, 'aria-label': 'Nový název místnosti', autocomplete: 'off' });
  const error = h('p', { class: 'error-text', role: 'alert', hidden: true });
  const cancel = () => {
    editing = null;
    render();
  };
  const form = h(
    'form',
    {
      class: 'room-edit',
      novalidate: true,
      onSubmit: async (event) => {
        event.preventDefault();
        if (input.value.trim() === room.name) return cancel();
        try {
          const result = await api.renameRoom(room.id, input.value);
          editing = null;
          await changed(`Přejmenováno na „${result.room.name}“`);
        } catch (failure) {
          error.hidden = false;
          error.textContent = failure.message;
          input.focus();
        }
        return undefined;
      },
      onKeydown: (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          cancel();
        }
      },
    },
    h(
      'div',
      { class: 'room-add-row' },
      input,
      h('button', { class: 'btn btn-secondary', type: 'button', onClick: cancel }, 'Zrušit'),
      h('button', { class: 'btn btn-primary', type: 'submit' }, 'Uložit'),
    ),
    error,
  );
  queueMicrotask(() => {
    input.focus();
    input.select();
  });
  return h('li', { class: 'user-row room-row-editing' }, form);
}

async function removeRoom(room) {
  const confirmed = await confirmDialog({
    title: 'Smazat místnost?',
    text:
      room.taskCount > 0
        ? `Místnost „${room.name}“ zmizí. Její ${count(room.taskCount, 'úkol', 'úkoly', 'úkolů')} zůstane a přesune se do „${GENERAL_ROOM}“.`
        : `Místnost „${room.name}“ zmizí. Žádné úkoly v ní nejsou.`,
    confirmLabel: 'Smazat místnost',
    danger: true,
  });
  if (!confirmed) return;
  try {
    await api.deleteRoom(room.id);
    await changed('Místnost je smazaná');
  } catch (error) {
    toastError(error);
    load();
  }
}

function render() {
  if (!root?.isConnected) return;
  clear(root);
  root.append(
    h(
      'div',
      { class: 'admin-head' },
      h('a', { class: 'btn btn-quiet admin-back', href: '/', 'data-link': true }, icon('arrowLeft'), 'Nástěnka'),
      h('h1', { class: 'page-title' }, 'Místnosti'),
      h(
        'p',
        { class: 'admin-lead' },
        `Místnosti dělí úkoly podle toho, kam patří. Na nástěnce si pak každý vybere všechny, nebo jen některé. Úkol bez místnosti je v „${GENERAL_ROOM}“.`,
      ),
    ),
  );

  if (!data) {
    if (loadError) {
      root.append(h('p', { class: 'admin-note' }, loadError.message), h('button', { class: 'btn btn-secondary', type: 'button', onClick: load }, 'Zkusit znovu'));
    }
    return;
  }

  append(root, [
    h('section', { class: 'admin-section' }, addForm()),
    h(
      'section',
      { class: 'admin-section' },
      h(
        'header',
        { class: 'admin-section-head' },
        h('h2', { class: 'admin-section-title' }, 'Založené místnosti'),
        h('span', { class: 'count' }, String(data.rooms.length)),
      ),
      data.rooms.length > 0
        ? h('ul', { class: 'user-list' }, data.rooms.map(roomRow))
        : h('p', { class: 'admin-note' }, 'Zatím žádná. První přidáte polem nahoře.'),
      h(
        'p',
        { class: 'admin-note room-general' },
        h('span', { class: 'user-name' }, GENERAL_ROOM),
        ' · ',
        h('span', { class: 'mono' }, tasks(data.unassigned.taskCount, data.unassigned.openCount)),
        ' · vždy k dispozici, nejde přejmenovat ani smazat',
      ),
    ),
  ]);
}
