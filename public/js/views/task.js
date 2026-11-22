import { api, media } from '../api.js';
import { append, clear, gear, h, icon } from '../dom.js';
import { STATUS, STATUSES, count, eventDate, fullDate, isoDate, megabytes } from '../format.js';
import { back, route } from '../router.js';
import { findTask, isMember, removeTask, store, upsertTask } from '../store.js';
import { confirmDialog } from '../ui/dialog.js';
import { openLightbox } from '../ui/lightbox.js';
import { openMenu } from '../ui/menu.js';
import { segmented } from '../ui/segmented.js';
import { openSheet } from '../ui/sheet.js';
import { toast, toastError } from '../ui/toast.js';
import { showStatus } from './board.js';
import { DESCRIPTION_MAX, TITLE_MAX } from './task-form.js';

const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp'];
const ACCEPTED_NAME = /\.(jpe?g|png|webp)$/i;

let current = null;

/** Otevře nebo zavře detail podle adresy. */
export function syncTaskSheet(target) {
  if (target.name !== 'task') {
    if (current) {
      const view = current;
      current = null;
      view.sheet.close();
    }
    return;
  }
  if (current?.id === target.id) return;
  if (current) {
    const view = current;
    current = null;
    view.sheet.close();
  }
  open(target.id);
}

/** Po změně přihlášení se detail načte znovu, protože se mění oprávnění. */
export function reloadTaskSheet() {
  if (current) load(current);
}

function open(id) {
  const view = {
    id,
    task: null,
    known: findTask(id),
    editing: false,
    uploads: [],
    failures: [],
    uploading: false,
    sheet: null,
    grid: null,
    statusControl: null,
  };
  view.sheet = openSheet({
    label: 'Detail úkolu',
    onClosed: () => {
      for (const upload of view.uploads) {
        upload.request?.abort();
        URL.revokeObjectURL(upload.preview);
      }
      if (current === view) current = null;
      const now = route();
      // Zavření gestem nebo křížkem: adresa se vrátí na nástěnku.
      if (now.name === 'task' && now.id === id) back('/');
    },
  });
  current = view;
  bindDrop(view);
  render(view);
  load(view);
}

async function load(view) {
  try {
    const { task } = await api.task(view.id);
    if (view.sheet.closed) return;
    view.task = task;
    view.missing = false;
    upsertTask(task);
  } catch (error) {
    if (view.sheet.closed) return;
    if (error.status === 404) {
      view.missing = true;
      removeTask(view.id);
    } else {
      view.error = error;
    }
  }
  render(view);
}

function render(view) {
  const { sheet } = view;
  const task = view.task;
  const basic = task ?? view.known;
  const scroll = sheet.body.scrollTop;

  // Hlavička: číslo úkolu, nabídka akcí a zavření.
  const menuItems = [];
  if (task?.canEdit && !view.editing) menuItems.push({ label: 'Upravit text', icon: 'pencil', onSelect: () => startEditing(view) });
  if (task?.canDelete) menuItems.push({ label: 'Smazat úkol', icon: 'trash', danger: true, onSelect: () => deleteTask(view) });
  const menuButton = h(
    'button',
    {
      class: 'btn btn-quiet btn-icon',
      type: 'button',
      'aria-label': 'Další akce',
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      onClick: () => openMenu(menuButton, menuItems),
    },
    icon('ellipsis'),
  );
  append(clear(sheet.header), [
    h('span', { class: 'mono task-number' }, `Úkol č. ${view.id}`),
    h('span', { class: 'spacer' }),
    menuItems.length > 0 && menuButton,
    h('button', { class: 'btn btn-quiet btn-icon', type: 'button', 'aria-label': 'Zavřít', onClick: () => sheet.close() }, icon('x')),
  ]);

  clear(sheet.body);
  view.grid = null;
  view.statusControl = null;

  if (view.missing || (view.error && !basic)) {
    sheet.body.append(
      h(
        'div',
        { class: 'task-missing' },
        h('h2', { class: 'task-title' }, view.missing ? 'Tenhle úkol už neexistuje' : 'Úkol se nepodařilo načíst'),
        h('p', { class: 'task-muted' }, view.missing ? 'Nejspíš ho někdo smazal.' : view.error.message),
        h(
          'div',
          { class: 'task-actions' },
          !view.missing && h('button', { class: 'btn btn-secondary', type: 'button', onClick: () => { view.error = null; load(view); } }, 'Zkusit znovu'),
          h('button', { class: 'btn btn-secondary', type: 'button', onClick: () => sheet.close() }, 'Zpět na nástěnku'),
        ),
      ),
    );
    return;
  }
  if (!basic) return;

  if (view.editing) {
    sheet.body.append(editor(view));
    return;
  }

  sheet.body.append(h('h2', { class: 'task-title' }, basic.title), statusBlock(view, basic));
  if (!task) return;

  if (task.description) sheet.body.append(h('p', { class: 'task-description' }, linkify(task.description)));
  else if (task.canEdit) {
    sheet.body.append(
      h('button', { class: 'task-add-description', type: 'button', onClick: () => startEditing(view, 'description') }, icon('pencil'), 'Přidat popis'),
    );
  }

  sheet.body.append(photosSection(view), historySection(task));
  sheet.body.scrollTop = scroll;
}

// ───── Stav ─────

function statusBlock(view, basic) {
  if (view.task?.canEdit) {
    view.statusControl = segmented({
      label: 'Stav úkolu',
      touch: true,
      value: basic.status,
      options: STATUSES.map((status) => ({
        value: status,
        label: STATUS[status].label,
        content: [gear(status), h('span', null, STATUS[status].label)],
      })),
      onChange: (status) => changeStatus(view, status),
    });
    return h('div', { class: 'task-status' }, view.statusControl.el);
  }
  return h(
    'div',
    { class: 'task-status task-status-static' },
    gear(basic.status),
    h('span', { class: `status-${basic.status}` }, STATUS[basic.status].label),
    h('span', { class: 'mono task-muted' }, `od ${eventDate(basic.statusChangedAt)}`),
  );
}

async function changeStatus(view, status) {
  const previous = view.task.status;
  // Změna je vidět hned; při chybě se přepínač vrátí.
  view.task.status = status;
  showStatus(status);
  try {
    const { task } = await api.updateTask(view.id, { status });
    if (view.sheet.closed) return upsertTask(task);
    view.task = task;
    upsertTask(task);
    refreshHistory(view);
  } catch (error) {
    view.task.status = previous;
    view.statusControl?.set(previous);
    showStatus(previous);
    toastError(error);
    if (error.status === 404) load(view);
  }
  return undefined;
}

// ───── Popis ─────

/** Text zůstává textem; adresy http(s) se jen obalí odkazem. */
function linkify(text) {
  const parts = [];
  const pattern = /https?:\/\/[^\s<>"']+/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    let url = match[0].replace(/[.,;:!?)\]]+$/, '');
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('protokol');
    } catch {
      url = null;
    }
    if (!url) continue;
    parts.push(text.slice(last, match.index));
    parts.push(h('a', { class: 'link', href: url, target: '_blank', rel: 'noopener noreferrer nofollow' }, url));
    last = match.index + url.length;
  }
  parts.push(text.slice(last));
  return parts;
}

function startEditing(view, focus = 'title') {
  view.editing = true;
  view.editFocus = focus;
  render(view);
}

function editor(view) {
  const task = view.task;
  const title = h('input', { class: 'input task-title-input', type: 'text', value: task.title, maxlength: TITLE_MAX, 'aria-label': 'Název úkolu', autocomplete: 'off' });
  const description = h('textarea', { class: 'textarea task-description-input', maxlength: DESCRIPTION_MAX, rows: 10, 'aria-label': 'Popis úkolu', placeholder: 'Podrobnosti, postup, kde co najít' });
  description.value = task.description;
  const error = h('p', { class: 'error-text', role: 'alert', hidden: true });
  const save = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Uložit');

  const cancel = () => {
    view.editing = false;
    render(view);
  };

  const form = h(
    'form',
    {
      class: 'task-editor',
      novalidate: true,
      onSubmit: async (event) => {
        event.preventDefault();
        if (title.value.trim() === '') {
          error.hidden = false;
          error.textContent = 'Zadejte název úkolu';
          title.focus();
          return;
        }
        save.disabled = true;
        try {
          const result = await api.updateTask(view.id, { title: title.value, description: description.value });
          view.task = result.task;
          view.editing = false;
          upsertTask(result.task);
          render(view);
        } catch (failure) {
          save.disabled = false;
          error.hidden = false;
          error.textContent = failure.message;
        }
      },
      onKeydown: (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          cancel();
        } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          form.requestSubmit();
        }
      },
    },
    title,
    description,
    error,
    h('div', { class: 'task-actions' }, h('button', { class: 'btn btn-secondary', type: 'button', onClick: cancel }, 'Zrušit'), save),
  );
  queueMicrotask(() => {
    const target = view.editFocus === 'description' ? description : title;
    target.focus();
    target.setSelectionRange(target.value.length, target.value.length);
  });
  return form;
}

async function deleteTask(view) {
  const photos = view.task.photos.length;
  const confirmed = await confirmDialog({
    title: 'Smazat úkol?',
    text: `„${view.task.title}“ zmizí i s historií${photos > 0 ? ` a ${count(photos, 'fotkou', 'fotkami', 'fotkami')}` : ''}. Vrátit to nepůjde.`,
    confirmLabel: 'Smazat úkol',
    danger: true,
  });
  if (!confirmed) return;
  try {
    await api.deleteTask(view.id);
    removeTask(view.id);
    view.sheet.close();
    toast('Úkol je smazaný');
  } catch (error) {
    toastError(error);
  }
}

// ───── Fotky ─────

function photosSection(view) {
  const task = view.task;
  const grid = h('div', { class: 'photo-grid' });
  view.grid = grid;
  const heading = h('span', { class: 'count' });
  view.photoCount = heading;
  view.failureList = h('ul', { class: 'upload-failures', role: 'alert', hidden: true });
  const section = h(
    'section',
    { class: 'task-section' },
    h('header', { class: 'task-section-head' }, h('h3', { class: 'task-section-title' }, 'Fotky'), heading),
    grid,
    view.failureList,
  );
  if (task.canEdit) {
    section.append(
      h(
        'p',
        { class: 'hint photo-hint' },
        `JPEG, PNG nebo WebP do ${megabytes(store.me.limits.maxUploadBytes)}`,
        // Přetahování a schránka dávají smysl jen s myší a klávesnicí.
        window.matchMedia('(hover: hover)').matches && '. Jdou sem i přetáhnout nebo vložit ze schránky',
      ),
    );
  }
  renderPhotos(view);
  return section;
}

function renderPhotos(view) {
  const { task, grid } = view;
  if (!grid) return;
  clear(grid);
  view.photoCount.textContent = task.photos.length > 0 ? String(task.photos.length) : '';

  for (const photo of task.photos) {
    grid.append(
      h(
        'button',
        {
          class: 'photo',
          type: 'button',
          dataset: { photo: photo.id },
          'aria-label': `Fotka z ${fullDate(photo.createdAt)}, zvětšit`,
          style: { backgroundColor: photo.color },
          onClick: () => showPhotos(view, photo),
        },
        h('img', { src: media.thumb(photo.id), alt: '', loading: 'lazy', decoding: 'async', draggable: false }),
      ),
    );
  }
  for (const upload of view.uploads) grid.append(upload.el);

  if (task.canEdit) {
    const input = h('input', {
      class: 'visually-hidden',
      type: 'file',
      accept: ACCEPTED.join(','),
      multiple: true,
      tabindex: '-1',
      'aria-hidden': 'true',
      onChange: () => {
        addFiles(view, [...input.files]);
        input.value = '';
      },
    });
    grid.append(
      h(
        'button',
        { class: 'photo photo-add', type: 'button', onClick: () => input.click() },
        icon('imagePlus'),
        h('span', null, task.photos.length + view.uploads.length > 0 ? 'Přidat další' : 'Přidat fotky'),
      ),
      input,
    );
  } else if (task.photos.length === 0) {
    grid.replaceWith(h('p', { class: 'task-muted' }, 'K úkolu zatím nejsou žádné fotky'));
  }

  clear(view.failureList);
  view.failureList.hidden = view.failures.length === 0;
  for (const failure of view.failures) {
    view.failureList.append(
      h(
        'li',
        { class: 'upload-failure' },
        icon('alert'),
        h('span', { class: 'upload-failure-text' }, h('strong', null, failure.name), ` · ${failure.message}`),
        h(
          'button',
          {
            class: 'btn btn-quiet btn-icon',
            type: 'button',
            'aria-label': 'Skrýt upozornění',
            onClick: () => {
              view.failures.splice(view.failures.indexOf(failure), 1);
              renderPhotos(view);
            },
          },
          icon('x'),
        ),
      ),
    );
  }
}

function showPhotos(view, photo) {
  const photos = view.task.photos;
  openLightbox({
    photos,
    index: photos.indexOf(photo),
    canDownload: isMember(),
    thumbFor: (item) => view.grid?.querySelector(`[data-photo="${item.id}"]`) ?? null,
    onDelete: async (item) => {
      const confirmed = await confirmDialog({
        title: 'Smazat fotku?',
        text: 'Fotka zmizí i z archivu na serveru. Vrátit to nepůjde.',
        confirmLabel: 'Smazat fotku',
        danger: true,
      });
      if (!confirmed) return false;
      try {
        await api.deletePhoto(item.id);
      } catch (error) {
        toastError(error);
        return false;
      }
      // Seznam fotek je společný pro detail i prohlížeč.
      const index = photos.indexOf(item);
      if (index !== -1) photos.splice(index, 1);
      renderPhotos(view);
      upsertTask(view.task);
      refreshHistory(view);
      return true;
    },
  });
}

function addFiles(view, files) {
  const { limits } = store.me;
  const room = limits.maxPhotosPerTask - view.task.photos.length - view.uploads.length;
  let accepted = 0;
  for (const file of files) {
    const typeOk = ACCEPTED.includes(file.type) || (file.type === '' && ACCEPTED_NAME.test(file.name));
    if (!typeOk) {
      view.failures.push({ name: file.name, message: 'Soubor není JPEG, PNG ani WebP' });
    } else if (file.size > limits.maxUploadBytes) {
      view.failures.push({ name: file.name, message: `Soubor má ${megabytes(file.size)}, limit je ${megabytes(limits.maxUploadBytes)}` });
    } else if (accepted >= room) {
      toast(`K úkolu lze přidat nejvýš ${count(limits.maxPhotosPerTask, 'fotku', 'fotky', 'fotek')}`, { duration: 7000 });
      break;
    } else {
      accepted += 1;
      view.uploads.push(createUpload(view, file));
    }
  }
  renderPhotos(view);
  if (accepted > 0) pump(view);
}

function createUpload(view, file) {
  const preview = URL.createObjectURL(file);
  const bar = h('span', { class: 'photo-progress-bar' });
  const status = h('span', { class: 'photo-upload-status' }, 'Čeká');
  const cancel = h('button', { class: 'photo-upload-cancel', type: 'button', 'aria-label': 'Zrušit nahrávání' }, icon('x'));
  const el = h(
    'div',
    { class: 'photo photo-upload' },
    h('img', { src: preview, alt: '', draggable: false }),
    h('div', { class: 'photo-upload-overlay' }, status, h('span', { class: 'photo-progress' }, bar), cancel),
  );
  const upload = { file, preview, el, bar, status, state: 'queued', request: null };
  cancel.addEventListener('click', () => {
    upload.request?.abort();
    discard(view, upload);
  });
  return upload;
}

function discard(view, upload) {
  const index = view.uploads.indexOf(upload);
  if (index !== -1) view.uploads.splice(index, 1);
  URL.revokeObjectURL(upload.preview);
  renderPhotos(view);
}

/** Fotky se nahrávají po jedné; server je stejně zpracovává postupně. */
async function pump(view) {
  if (view.uploading) return;
  view.uploading = true;
  let added = 0;
  for (;;) {
    const upload = view.uploads.find((item) => item.state === 'queued');
    if (!upload || view.sheet.closed) break;
    upload.state = 'sending';
    upload.status.textContent = 'Nahrává se';
    upload.el.classList.add('sending');
    upload.request = api.uploadPhoto(view.id, upload.file, (fraction) => {
      upload.bar.style.transform = `scaleX(${fraction})`;
      if (fraction >= 1) upload.status.textContent = 'Zpracovává se';
    });
    try {
      const { photo } = await upload.request.promise;
      view.task.photos.push(photo);
      added += 1;
      discard(view, upload);
    } catch (error) {
      if (error.code === 'aborted') continue;
      // Neúspěšná fotka zmizí z mřížky a pod ní zůstane čitelné vysvětlení.
      view.failures.push({ name: upload.file.name, message: error.message });
      discard(view, upload);
    }
  }
  view.uploading = false;
  if (added > 0 && !view.sheet.closed) {
    upsertTask(view.task);
    refreshHistory(view);
  }
}

function bindDrop(view) {
  const el = view.sheet.el;
  const canDrop = (event) => view.task?.canEdit && !view.editing && [...(event.dataTransfer?.types ?? [])].includes('Files');
  let depth = 0;
  el.addEventListener('dragenter', (event) => {
    if (!canDrop(event)) return;
    event.preventDefault();
    depth += 1;
    el.classList.add('dropping');
  });
  el.addEventListener('dragover', (event) => {
    if (!canDrop(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  el.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) el.classList.remove('dropping');
  });
  el.addEventListener('drop', (event) => {
    depth = 0;
    el.classList.remove('dropping');
    if (!canDrop(event)) return;
    event.preventDefault();
    addFiles(view, [...event.dataTransfer.files]);
  });
  el.addEventListener('paste', (event) => {
    if (!view.task?.canEdit || view.editing) return;
    const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith('image/'));
    if (files.length === 0) return;
    event.preventDefault();
    addFiles(view, files);
  });
}

// ───── Historie ─────

const EVENT_LABEL = {
  created: 'Úkol založen',
  edited: 'Upraven text',
  photo_added: 'Přidány fotky',
  photo_removed: 'Odebrána fotka',
};

function historySection(task) {
  const list = h('ol', { class: 'timeline' });
  for (const event of task.events) {
    const label =
      event.type === 'status'
        ? [h('span', { class: 'task-muted' }, STATUS[event.from]?.label ?? ''), ' → ', h('span', { class: `status-${event.to}` }, STATUS[event.to]?.label ?? '')]
        : EVENT_LABEL[event.type];
    list.append(
      h(
        'li',
        { class: `timeline-item${event.type === 'status' ? ` status-${event.to}` : ''}` },
        h('span', { class: 'timeline-node', 'aria-hidden': 'true' }),
        h('span', { class: 'timeline-label' }, label),
        h(
          'span',
          { class: 'mono timeline-meta' },
          event.user && h('span', null, event.user),
          h('time', { datetime: isoDate(event.at), title: fullDate(event.at) }, eventDate(event.at)),
        ),
      ),
    );
  }
  return h(
    'section',
    { class: 'task-section', dataset: { section: 'history' } },
    h('header', { class: 'task-section-head' }, h('h3', { class: 'task-section-title' }, 'Historie')),
    list,
  );
}

/** Po změně stavu nebo fotek se z serveru dotáhne čerstvá historie. */
async function refreshHistory(view) {
  try {
    const { task } = await api.task(view.id);
    if (view.sheet.closed || view.editing) return;
    view.task.events = task.events;
    view.sheet.body.querySelector('[data-section="history"]')?.replaceWith(historySection(view.task));
  } catch {
    // Historie je jen doplněk; když se nenačte, zůstane ta stará.
  }
}
