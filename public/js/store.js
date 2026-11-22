import { api } from './api.js';
import { STATUSES } from './format.js';

// Stav aplikace na jednom místě. Pohledy se přihlásí k odběru a při změně
// se překreslí.
export const store = {
  me: { user: null, pendingUsers: undefined, limits: { maxUploadBytes: 20 * 1024 * 1024, maxPhotosPerTask: 40 } },
  board: null,
  boardError: null,
};

const listeners = new Set();
export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function notify(what) {
  for (const listener of [...listeners]) listener(what);
}

export const isMember = () => Boolean(store.me.user) && !store.me.user.mustChangePassword;
export const isAdmin = () => isMember() && store.me.user.role === 'admin';

export function setMe(me) {
  store.me = me;
  notify('me');
}

export async function refreshMe() {
  setMe(await api.me());
}

let boardRequest = 0;
export async function refreshBoard() {
  const request = (boardRequest += 1);
  try {
    const board = await api.board();
    // Pomalejší starší odpověď nesmí přepsat novější.
    if (request !== boardRequest) return;
    // Načtené další stránky hotových úkolů se při obnově neztratí.
    const previous = store.board?.columns.done;
    if (previous && previous.tasks.length > board.columns.done.tasks.length) {
      const fresh = new Set(board.columns.done.tasks.map((task) => task.id));
      const oldest = board.columns.done.tasks.at(-1);
      const kept = previous.tasks.filter(
        (task) => !fresh.has(task.id) && (!oldest || task.statusChangedAt <= oldest.statusChangedAt),
      );
      board.columns.done.tasks.push(...kept);
      if (kept.length > 0) board.columns.done.nextCursor = previous.nextCursor;
    }
    store.board = board;
    store.boardError = null;
  } catch (error) {
    if (request !== boardRequest) return;
    store.boardError = error;
  }
  notify('board');
}

export async function loadMoreDone() {
  const column = store.board?.columns.done;
  if (!column?.nextCursor) return;
  const page = await api.moreDone(column.nextCursor);
  const known = new Set(column.tasks.map((task) => task.id));
  column.tasks.push(...page.tasks.filter((task) => !known.has(task.id)));
  column.nextCursor = page.nextCursor;
  notify('board');
}

export function findTask(id) {
  if (!store.board) return null;
  for (const status of STATUSES) {
    const task = store.board.columns[status].tasks.find((item) => item.id === id);
    if (task) return task;
  }
  return null;
}

function detach(id) {
  for (const status of STATUSES) {
    const tasks = store.board.columns[status].tasks;
    const index = tasks.findIndex((item) => item.id === id);
    if (index !== -1) {
      tasks.splice(index, 1);
      store.board.counts[status] = Math.max(0, store.board.counts[status] - 1);
      return true;
    }
  }
  return false;
}

/** Zařadí nový nebo změněný úkol do správného sloupce. */
export function upsertTask(task) {
  if (!store.board) return;
  const summary = {
    id: task.id,
    title: task.title,
    excerpt: task.excerpt,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    statusChangedAt: task.statusChangedAt,
    photoCount: task.photos ? task.photos.length : task.photoCount,
    cover: task.photos ? (task.photos[0] ? pick(task.photos[0]) : null) : task.cover,
    author: task.author,
  };
  detach(task.id);
  const tasks = store.board.columns[task.status].tasks;
  const index = tasks.findIndex((item) => item.statusChangedAt < summary.statusChangedAt);
  tasks.splice(index === -1 ? tasks.length : index, 0, summary);
  store.board.counts[task.status] += 1;
  notify('board');
}

const pick = (photo) => ({ id: photo.id, width: photo.width, height: photo.height, color: photo.color });

export function removeTask(id) {
  if (!store.board) return;
  if (detach(id)) notify('board');
}
