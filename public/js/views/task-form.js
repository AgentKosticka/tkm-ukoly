import { api } from '../api.js';
import { h } from '../dom.js';
import { navigate } from '../router.js';
import { store, upsertTask } from '../store.js';
import { openDialog } from '../ui/dialog.js';
import { field, formError, submitWith } from './auth.js';
import { roomSelect, selectedRoom } from './room-select.js';

export const TITLE_MAX = 120;
export const DESCRIPTION_MAX = 5000;

export function openNewTask() {
  const dialog = openDialog({ label: 'Nový úkol', wide: true });
  const title = field({
    label: 'Název',
    name: 'title',
    type: 'text',
    required: true,
    maxlength: TITLE_MAX,
    placeholder: 'Co je potřeba udělat',
    autocomplete: 'off',
  });
  const description = field({
    label: 'Popis',
    name: 'description',
    type: 'textarea',
    maxlength: DESCRIPTION_MAX,
    rows: 5,
    placeholder: 'Podrobnosti, postup, kde co najít',
    hint: 'Nepovinné. Fotky přidáte hned po založení',
  });
  // Je-li na nástěnce vybraná právě jedna místnost, nový úkol do ní nejspíš patří.
  const only = store.filter.size === 1 ? [...store.filter][0] : 0;
  const room = store.rooms.length > 0 ? roomSelect({ value: only === 0 ? null : only }) : null;
  const roomField = room && h('div', { class: 'field' }, h('label', { class: 'label', for: 'new-task-room' }, 'Místnost'), room);
  if (room) room.id = 'new-task-room';
  const general = formError();
  const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Založit úkol');

  const form = h(
    'form',
    {
      novalidate: true,
      onSubmit: (event) => {
        event.preventDefault();
        if (title.value.trim() === '') {
          title.setError('Zadejte název úkolu');
          title.input.focus();
          return;
        }
        submitWith(submit, { title, description }, general, async () => {
          const { task } = await api.createTask({
            title: title.value,
            description: description.value,
            roomId: room ? selectedRoom(room) : null,
          });
          upsertTask(task);
          await dialog.close();
          // Rovnou do detailu, kde jde přidat fotky.
          navigate(`/ukol/${task.id}`);
        });
      },
    },
    title.el,
    roomField,
    description.el,
    general.el,
    h(
      'div',
      { class: 'dialog-actions' },
      h('button', { class: 'btn btn-secondary', type: 'button', onClick: () => dialog.close() }, 'Zrušit'),
      submit,
    ),
  );

  dialog.el.append(h('h2', { class: 'dialog-title' }, 'Nový úkol'), h('div', { class: 'dialog-body' }, form));
  title.input.focus();
}
