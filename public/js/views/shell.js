import { api } from '../api.js';
import { clear, h, icon } from '../dom.js';
import { navigate } from '../router.js';
import { isAdmin, isMember, refreshBoard, setMe, store } from '../store.js';
import { openMenu } from '../ui/menu.js';
import { toast, toastError } from '../ui/toast.js';
import { openChangePassword } from './auth.js';
import { openNewTask } from './task-form.js';

const topbar = () => document.getElementById('topbar');

export function renderShell() {
  const { user, pendingUsers } = store.me;
  const actions = h('div', { class: 'topbar-actions' });

  if (isMember()) {
    actions.append(
      h(
        'button',
        { class: 'btn btn-primary hide-narrow', type: 'button', onClick: openNewTask },
        icon('plus'),
        'Nový úkol',
      ),
      h(
        'button',
        { class: 'btn btn-primary btn-icon only-narrow', type: 'button', 'aria-label': 'Nový úkol', onClick: openNewTask },
        icon('plus'),
      ),
    );
    if (isAdmin()) {
      actions.append(
        h(
          'a',
          { class: 'btn btn-quiet', href: '/uzivatele', 'data-link': true, 'aria-label': pendingUsers ? `Uživatelé, ${pendingUsers} čeká na schválení` : 'Uživatelé' },
          icon('users'),
          h('span', { class: 'hide-narrow' }, 'Uživatelé'),
          pendingUsers ? h('span', { class: 'count count-alert' }, String(pendingUsers)) : null,
        ),
      );
    }
  }

  if (user) {
    const account = h(
      'button',
      {
        class: 'btn btn-quiet',
        type: 'button',
        'aria-haspopup': 'menu',
        'aria-expanded': 'false',
        'aria-label': `Účet ${user.username}`,
        onClick: () =>
          openMenu(account, [
            { heading: `Přihlášen jako ${user.username}` },
            isAdmin() && { label: 'Místnosti', icon: 'door', onSelect: () => navigate('/mistnosti') },
            { label: 'Změnit heslo', icon: 'key', onSelect: () => openChangePassword() },
            { separator: true },
            { label: 'Odhlásit se', icon: 'logOut', onSelect: logout },
          ]),
      },
      icon('user'),
      h('span', { class: 'hide-narrow' }, user.username),
      icon('chevronDown'),
    );
    actions.append(account);
  } else {
    actions.append(h('a', { class: 'btn btn-quiet', href: '/prihlaseni', 'data-link': true }, 'Přihlásit se'));
  }

  clear(topbar()).append(
    h(
      'a',
      { class: 'brand', href: '/', 'data-link': true, 'aria-label': 'Úkolníček, na nástěnku' },
      h('span', { class: 'brand-mark', 'aria-hidden': 'true' }),
      h('span', { class: 'brand-text' }, h('span', { class: 'brand-name' }, 'Úkolníček'), h('span', { class: 'brand-org' }, 'ITV a TKM Litoměřice')),
    ),
    actions,
  );
}

async function logout() {
  try {
    await api.logout();
  } catch (error) {
    toastError(error);
    return;
  }
  setMe({ ...store.me, user: null, pendingUsers: undefined });
  navigate('/', { replace: true });
  refreshBoard();
  toast('Jste odhlášeni');
}

export function renderFooter() {
  clear(document.getElementById('footer')).append(
    h('img', { src: '/img/tkm.png', alt: 'Technický klub mládeže', width: '480', height: '264', loading: 'lazy' }),
    h(
      'p',
      { class: 'footer-text' },
      'Institut technického vzdělávání, z. ú. · Sovova 480/2, Litoměřice · ',
      h('a', { class: 'link', href: 'https://www.technickyklub.cz/', rel: 'noopener noreferrer', target: '_blank' }, 'technickyklub.cz'),
    ),
  );
}

// Linka pod lištou se ukáže až ve chvíli, kdy pod ní něco projíždí.
const sentinel = h('div', { 'aria-hidden': 'true', style: { position: 'absolute', top: '0', height: '1px', width: '1px' } });
document.body.prepend(sentinel);
new IntersectionObserver(([entry]) => topbar().classList.toggle('scrolled', !entry.isIntersecting)).observe(sentinel);
