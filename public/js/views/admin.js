import { api } from '../api.js';
import { clear, h, icon } from '../dom.js';
import { count, fullDate, isoDate, shortDate } from '../format.js';
import { navigate } from '../router.js';
import { isAdmin, refreshMe, store } from '../store.js';
import { confirmDialog, openDialog } from '../ui/dialog.js';
import { openMenu } from '../ui/menu.js';
import { toast, toastError } from '../ui/toast.js';

let root = null;
let users = null;
let loadError = null;

export function mountAdmin(main) {
  if (!isAdmin()) {
    navigate(store.me.user ? '/' : '/prihlaseni', { replace: true });
    return;
  }
  root = h('div', { class: 'admin' });
  clear(main).append(root);
  render();
  load();
}

export function unmountAdmin() {
  root = null;
}

async function load() {
  try {
    users = (await api.users()).users;
    loadError = null;
  } catch (error) {
    loadError = error;
  }
  render();
}

async function act(action, success) {
  try {
    await action();
    if (success) toast(success);
  } catch (error) {
    toastError(error);
  }
  await Promise.all([load(), refreshMe().catch(() => {})]);
}

function pendingRow(user) {
  return h(
    'li',
    { class: 'user-row' },
    h('div', { class: 'user-main' }, h('span', { class: 'user-name' }, user.username), h('span', { class: 'mono user-meta' }, `registrace ${shortDate(user.createdAt)}`)),
    h(
      'div',
      { class: 'user-actions' },
      h(
        'button',
        {
          class: 'btn btn-quiet',
          type: 'button',
          onClick: async () => {
            const confirmed = await confirmDialog({
              title: 'Zamítnout registraci?',
              text: `Účet „${user.username}“ se smaže. Dotyčný se může zaregistrovat znovu.`,
              confirmLabel: 'Zamítnout',
              danger: true,
            });
            if (confirmed) act(() => api.rejectUser(user.id), 'Registrace zamítnuta');
          },
        },
        'Zamítnout',
      ),
      h(
        'button',
        { class: 'btn btn-secondary', type: 'button', onClick: () => act(() => api.approveUser(user.id), `„${user.username}“ se teď může přihlásit`) },
        icon('check'),
        'Schválit',
      ),
    ),
  );
}

function memberRow(user) {
  const isSelf = user.id === store.me.user.id;
  const disabled = user.status === 'disabled';
  const tags = [];
  if (user.role === 'admin') tags.push(h('span', { class: 'tag tag-navy' }, 'správce'));
  if (disabled) tags.push(h('span', { class: 'tag tag-muted' }, 'zablokován'));
  if (user.mustChangePassword) tags.push(h('span', { class: 'tag tag-muted' }, 'dočasné heslo'));

  const menu = h(
    'button',
    {
      class: 'btn btn-quiet btn-icon',
      type: 'button',
      'aria-label': `Akce pro ${user.username}`,
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      onClick: () =>
        openMenu(menu, [
          user.role === 'admin'
            ? { label: 'Odebrat práva správce', icon: 'user', onSelect: () => act(() => api.updateUser(user.id, { role: 'user' }), `„${user.username}“ už není správce`) }
            : { label: 'Udělat správcem', icon: 'users', onSelect: () => makeAdmin(user) },
          { label: 'Vytvořit dočasné heslo', icon: 'key', onSelect: () => resetPassword(user) },
          disabled
            ? { label: 'Odblokovat', icon: 'check', onSelect: () => act(() => api.updateUser(user.id, { status: 'approved' }), `„${user.username}“ se zase může přihlásit`) }
            : { label: 'Zablokovat', icon: 'x', onSelect: () => blockUser(user) },
          { separator: true },
          { label: 'Smazat účet', icon: 'trash', danger: true, onSelect: () => deleteUser(user) },
        ]),
    },
    icon('ellipsis'),
  );

  return h(
    'li',
    { class: `user-row${disabled ? ' is-disabled' : ''}` },
    h(
      'div',
      { class: 'user-main' },
      h('span', { class: 'user-name' }, user.username, isSelf && h('span', { class: 'user-self' }, ' (vy)')),
      tags.length > 0 && h('span', { class: 'user-tags' }, tags),
    ),
    h(
      'span',
      { class: 'mono user-meta' },
      user.lastLoginAt
        ? ['naposledy ', h('time', { datetime: isoDate(user.lastLoginAt), title: fullDate(user.lastLoginAt) }, shortDate(user.lastLoginAt))]
        : 'zatím bez přihlášení',
    ),
    h('div', { class: 'user-actions' }, isSelf ? h('span', { class: 'user-actions-spacer' }) : menu),
  );
}

async function makeAdmin(user) {
  const confirmed = await confirmDialog({
    title: 'Udělat správcem?',
    text: `„${user.username}“ bude moci schvalovat registrace, blokovat a mazat účty a mazat cizí úkoly i fotky.`,
    confirmLabel: 'Udělat správcem',
  });
  if (confirmed) act(() => api.updateUser(user.id, { role: 'admin' }), `„${user.username}“ je teď správce`);
}

async function blockUser(user) {
  const confirmed = await confirmDialog({
    title: 'Zablokovat účet?',
    text: `„${user.username}“ bude okamžitě odhlášen a nepřihlásí se, dokud účet neodblokujete. Jeho úkoly a fotky zůstanou.`,
    confirmLabel: 'Zablokovat',
    danger: true,
  });
  if (confirmed) act(() => api.updateUser(user.id, { status: 'disabled' }), `„${user.username}“ je zablokován`);
}

async function deleteUser(user) {
  const confirmed = await confirmDialog({
    title: 'Smazat účet?',
    text: `Účet „${user.username}“ zmizí natrvalo. Úkoly a fotky, které přidal, zůstanou bez uvedení autora.`,
    confirmLabel: 'Smazat účet',
    danger: true,
  });
  if (confirmed) act(() => api.deleteUser(user.id), 'Účet je smazaný');
}

async function resetPassword(user) {
  const confirmed = await confirmDialog({
    title: 'Vytvořit dočasné heslo?',
    text: `Současné heslo účtu „${user.username}“ přestane platit a účet se všude odhlásí. Nové heslo uvidíte jen jednou.`,
    confirmLabel: 'Vytvořit heslo',
  });
  if (!confirmed) return;
  let password;
  try {
    password = (await api.resetPassword(user.id)).password;
  } catch (error) {
    toastError(error);
    return;
  }
  const dialog = openDialog({ label: 'Dočasné heslo' });
  const copy = h(
    'button',
    {
      class: 'btn btn-secondary',
      type: 'button',
      onClick: async () => {
        try {
          await navigator.clipboard.writeText(password);
          copy.textContent = 'Zkopírováno';
        } catch {
          copy.textContent = 'Označte a zkopírujte ručně';
        }
      },
    },
    'Zkopírovat',
  );
  dialog.el.append(
    h('h2', { class: 'dialog-title' }, 'Dočasné heslo'),
    h('p', { class: 'dialog-text' }, `Předejte ho uživateli „${user.username}“. Po přihlášení si bude muset zvolit vlastní. Po zavření už heslo nepůjde zobrazit.`),
    h('code', { class: 'secret' }, password),
    h('div', { class: 'dialog-actions' }, copy, h('button', { class: 'btn btn-primary', type: 'button', onClick: () => dialog.close() }, 'Hotovo')),
  );
  load();
}

function render() {
  if (!root?.isConnected) return;
  clear(root);
  root.append(
    h(
      'div',
      { class: 'admin-head' },
      h('a', { class: 'btn btn-quiet admin-back', href: '/', 'data-link': true }, icon('arrowLeft'), 'Nástěnka'),
      h('h1', { class: 'page-title' }, 'Uživatelé'),
    ),
  );

  if (!users) {
    if (loadError) {
      root.append(
        h('p', { class: 'admin-note' }, loadError.message),
        h('button', { class: 'btn btn-secondary', type: 'button', onClick: load }, 'Zkusit znovu'),
      );
    }
    return;
  }

  const pending = users.filter((user) => user.status === 'pending');
  const members = users.filter((user) => user.status !== 'pending');

  root.append(
    h(
      'section',
      { class: 'admin-section' },
      h(
        'header',
        { class: 'admin-section-head' },
        h('h2', { class: 'admin-section-title' }, 'Čekají na schválení'),
        h('span', { class: `count${pending.length > 0 ? ' count-alert' : ''}` }, String(pending.length)),
      ),
      pending.length > 0
        ? h('ul', { class: 'user-list' }, pending.map(pendingRow))
        : h('p', { class: 'admin-note' }, 'Žádná nová registrace. Až se někdo zaregistruje, objeví se tady.'),
    ),
    h(
      'section',
      { class: 'admin-section' },
      h(
        'header',
        { class: 'admin-section-head' },
        h('h2', { class: 'admin-section-title' }, 'Členové'),
        h('span', { class: 'count' }, count(members.length, 'účet', 'účty', 'účtů')),
      ),
      h('ul', { class: 'user-list' }, members.map(memberRow)),
    ),
  );
}
