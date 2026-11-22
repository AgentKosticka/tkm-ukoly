import { setUnauthenticatedHandler } from './api.js';
import { onInstallChange, startPwa } from './pwa.js';
import { onRoute, route } from './router.js';
import { refreshBoard, refreshMe, store, subscribe } from './store.js';
import { hasOverlay } from './ui/overlay.js';
import { toast } from './ui/toast.js';
import { mountAdmin, unmountAdmin } from './views/admin.js';
import { openChangePassword, syncAuthDialog } from './views/auth.js';
import { mountBoard, renderBoard, unmountBoard } from './views/board.js';
import { mountRooms, unmountRooms } from './views/rooms.js';
import { renderFooter, renderShell } from './views/shell.js';
import { reloadTaskSheet, syncTaskSheet } from './views/task.js';

const main = document.getElementById('obsah');
const REFRESH_MS = 60_000;

let ready = false;

const ADMIN_PAGES = {
  users: { mount: mountAdmin, title: 'Uživatelé · Úkolníček' },
  rooms: { mount: mountRooms, title: 'Místnosti · Úkolníček' },
};

function show(current) {
  unmountAdmin();
  unmountRooms();
  const adminPage = ADMIN_PAGES[current.name];
  if (adminPage) {
    unmountBoard();
    // Správa se vykreslí, až když je jasné, kdo je přihlášen.
    if (ready) adminPage.mount(main);
    else main.replaceChildren();
  } else {
    mountBoard(main);
  }
  syncTaskSheet(current);
  syncAuthDialog(current);
  document.title = adminPage?.title ?? (current.name === 'task' ? `Úkol č. ${current.id} · Úkolníček` : 'Úkolníček · ITV a TKM Litoměřice');
}

let knownUser = null;
subscribe((what) => {
  if (what === 'board' || what === 'filter') renderBoard();
  if (what === 'me') {
    renderShell();
    const userId = store.me.user?.id ?? null;
    if (userId !== knownUser) {
      knownUser = userId;
      // Jiný uživatel vidí jiná jména a má jiná oprávnění.
      renderBoard();
      reloadTaskSheet();
      if (ADMIN_PAGES[route().name]) show(route());
    }
  }
});

onRoute(show);

// Session mohla vypršet nebo ji správce zrušil: aplikace se přepne do
// režimu návštěvníka a řekne proč.
let handlingExpiry = false;
setUnauthenticatedHandler(async (error) => {
  if (handlingExpiry) return;
  handlingExpiry = true;
  try {
    const hadUser = Boolean(store.me.user);
    await refreshMe();
    if (store.me.user?.mustChangePassword) openChangePassword({ forced: true });
    else if (hadUser && !store.me.user) toast('Byli jste odhlášeni. Přihlaste se prosím znovu', { duration: 7000 });
    else if (error.code === 'unauthenticated' && !store.me.user) toast('Pro tuto akci se přihlaste');
    refreshBoard();
  } catch {
    // Síť je pryč; původní chybu už ukázal ten, kdo požadavek poslal.
  } finally {
    handlingExpiry = false;
  }
});

async function start() {
  renderShell();
  renderFooter();
  show(route());
  await Promise.all([refreshMe().catch(() => {}), refreshBoard()]);
  knownUser = store.me.user?.id ?? null;
  ready = true;
  // Po načtení identity se znovu vyhodnotí adresy závislé na přihlášení.
  show(route());
  if (store.me.user?.mustChangePassword) openChangePassword({ forced: true });
}

// Nástěnku sdílí víc lidí, proto se průběžně obnovuje; jen když je vidět
// a nic na ní zrovna není rozpracované.
function refreshIfIdle() {
  if (document.visibilityState !== 'visible') return;
  refreshMe().catch(() => {});
  if (!hasOverlay()) refreshBoard();
}
setInterval(refreshIfIdle, REFRESH_MS);
document.addEventListener('visibilitychange', refreshIfIdle);

onInstallChange(renderFooter);
startPwa();
start();
