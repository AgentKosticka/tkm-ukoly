import { api } from './api.js';
import { STATUSES } from './format.js';

// Stav aplikace na jednom místě. Pohledy se přihlásí k odběru a při změně
// se překreslí.
const FILTER_KEY = 'ukolnicek.mistnosti';

/** Výběr místností si prohlížeč pamatuje; 0 znamená „Obecné“. */
function loadFilter() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(FILTER_KEY) ?? '[]');
    return new Set(Array.isArray(saved) ? saved.filter((id) => Number.isInteger(id) && id >= 0).slice(0, 64) : []);
  } catch {
    return new Set();
  }
}

export const store = {
  me: { user: null, pendingUsers: undefined, limits: { maxUploadBytes: 20 * 1024 * 1024, maxPhotosPerTask: 40 } },
  board: null,
  boardError: null,
  rooms: [],
  // Prázdný výběr znamená všechny místnosti.
  filter: loadFilter(),
};

const filterParam = () => [...store.filter].sort((a, b) => a - b).join(',');

/** Patří úkol do právě vybraných místností? */
export function matchesFilter(task) {
  return store.filter.size === 0 || store.filter.has(task.roomId ?? 0);
}

export function roomName(roomId) {
  return store.rooms.find((room) => room.id === roomId)?.name ?? null;
}

// České abecední řazení: Š patří za S, ne až za Z.
const collator = new Intl.Collator('cs', { sensitivity: 'base', numeric: true });

export function setRooms(rooms) {
  store.rooms = [...rooms].sort((a, b) => collator.compare(a.name, b.name));
  // Místnost mohl mezitím někdo smazat; z výběru pak vypadne.
  const known = new Set([0, ...rooms.map((room) => room.id)]);
  let changed = false;
  for (const id of [...store.filter]) {
    if (!known.has(id)) {
      store.filter.delete(id);
      changed = true;
    }
  }
  if (changed) saveFilter();
  return changed;
}

function saveFilter() {
  try {
    window.localStorage.setItem(FILTER_KEY, JSON.stringify([...store.filter]));
  } catch {
    // Soukromý režim: výběr vydrží jen do zavření stránky.
  }
}

/** Zapne nebo vypne místnost ve výběru; null vybere vše. */
export function toggleRoom(id) {
  if (id === null) store.filter.clear();
  else if (store.filter.has(id)) store.filter.delete(id);
  else store.filter.add(id);
  // Vybrat úplně všechno je totéž jako nevybrat nic.
  if (store.filter.size === store.rooms.length + 1) store.filter.clear();
  saveFilter();
  notify('filter');
  return refreshBoard();
}

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
    const used = filterParam();
    const board = await api.board(used);
    // Pomalejší starší odpověď nesmí přepsat novější.
    if (request !== boardRequest) return;
    if (setRooms(board.rooms)) {
      // Výběr se změnil (smazaná místnost); nástěnka se načte znovu pro nový.
      refreshBoard();
      return;
    }
    // Načtené další stránky hotových úkolů se při obnově neztratí,
    // pokud jde o stejný výběr místností.
    const previous = store.board?.filterUsed === used ? store.board.columns.done : null;
    board.filterUsed = used;
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
  const page = await api.moreDone(column.nextCursor, store.board.filterUsed);
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
    roomId: task.roomId ?? null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    statusChangedAt: task.statusChangedAt,
    photoCount: task.photos ? task.photos.length : task.photoCount,
    cover: task.photos ? (task.photos[0] ? pick(task.photos[0]) : null) : task.cover,
    author: task.author,
  };
  detach(task.id);
  // Úkol přesunutý mimo vybrané místnosti z nástěnky zmizí.
  if (!matchesFilter(summary)) {
    notify('board');
    return;
  }
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
