import { api } from '../api.js';
import { h } from '../dom.js';
import { navigate } from '../router.js';
import { upsertTask } from '../store.js';
import { openDialog } from '../ui/dialog.js';
import { field, formError, submitWith } from './auth.js';

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
          const { task } = await api.createTask({ title: title.value, description: description.value });
          upsertTask(task);
          await dialog.close();
          // Rovnou do detailu, kde jde přidat fotky.
          navigate(`/ukol/${task.id}`);
        });
      },
    },
    title.el,
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
