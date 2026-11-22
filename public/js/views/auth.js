import { api } from '../api.js';
import { clear, h, icon } from '../dom.js';
import { back, navigate, route } from '../router.js';
import { refreshBoard, setMe, store } from '../store.js';
import { openDialog } from '../ui/dialog.js';
import { toast } from '../ui/toast.js';

/** Pole formuláře s popiskem a místem pro chybu. */
export function field({ label, hint, ...attrs }) {
  const id = `f-${Math.random().toString(36).slice(2, 9)}`;
  const tag = attrs.type === 'textarea' ? 'textarea' : 'input';
  const input = h(tag, { id, class: tag === 'textarea' ? 'textarea' : 'input', ...attrs, type: tag === 'textarea' ? undefined : attrs.type });
  const error = h('p', { class: 'error-text', id: `${id}-e`, hidden: true });
  const hintEl = hint ? h('p', { class: 'hint', id: `${id}-h` }, hint) : null;
  input.setAttribute('aria-describedby', [hint ? `${id}-h` : null, `${id}-e`].filter(Boolean).join(' '));
  const el = h('div', { class: 'field' }, h('label', { class: 'label', for: id }, label), input, hintEl, error);
  return {
    el,
    input,
    get value() {
      return input.value;
    },
    setError(message) {
      error.hidden = !message;
      error.textContent = message ?? '';
      if (message) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    },
  };
}

export function formError() {
  const text = h('span');
  const el = h('div', { class: 'form-error', role: 'alert', hidden: true }, icon('alert'), text);
  return {
    el,
    show(message) {
      text.textContent = message ?? '';
      el.hidden = !message;
    },
  };
}

/** Odeslání formuláře: zamkne tlačítko, rozdělí chyby k polím. */
export async function submitWith(button, fields, general, action) {
  const label = button.textContent;
  general.show(null);
  for (const item of Object.values(fields)) item.setError(null);
  button.disabled = true;
  try {
    await action();
  } catch (error) {
    const target = error.field && fields[error.field];
    if (target) {
      target.setError(error.message);
      target.input.focus();
    } else {
      general.show(error.message);
    }
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

let authDialog = null;

/** Přihlášení a registrace sdílí jeden dialog; mění se jen jeho obsah. */
export function syncAuthDialog(current) {
  const wanted = current.name === 'login' || current.name === 'register' ? current.name : null;
  if (!wanted) {
    if (authDialog) {
      const dialog = authDialog;
      authDialog = null;
      dialog.close();
    }
    return;
  }
  if (store.me.user) {
    navigate('/', { replace: true });
    return;
  }
  if (!authDialog) {
    const dialog = openDialog({
      label: 'Přihlášení',
      onClosed: () => {
        if (authDialog === dialog) authDialog = null;
        const name = route().name;
        if (name === 'login' || name === 'register') back('/');
      },
    });
    authDialog = dialog;
  }
  renderAuth(authDialog, wanted);
}

function logos() {
  return h(
    'div',
    { class: 'dialog-logos' },
    h('span', { class: 'brand-mark', role: 'img', 'aria-label': 'Institut technického vzdělávání' }),
    h('img', { src: '/img/tkm.png', alt: 'Technický klub mládeže', width: '480', height: '264' }),
  );
}

function renderAuth(dialog, mode) {
  const isLogin = mode === 'login';
  dialog.el.setAttribute('aria-label', isLogin ? 'Přihlášení' : 'Registrace');

  const username = field({
    label: 'Uživatelské jméno',
    name: 'username',
    type: 'text',
    autocomplete: 'username',
    autocapitalize: 'none',
    spellcheck: 'false',
    required: true,
    maxlength: 32,
    hint: isLogin ? null : '3–32 znaků: písmena bez diakritiky, číslice, tečka, pomlčka nebo podtržítko',
  });
  const password = field({
    label: 'Heslo',
    name: 'password',
    type: 'password',
    autocomplete: isLogin ? 'current-password' : 'new-password',
    required: true,
    maxlength: 128,
    hint: isLogin ? null : 'Aspoň 10 znaků. Delší věta je lepší než krátké složité heslo',
  });
  const general = formError();
  const submit = h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'submit' }, isLogin ? 'Přihlásit se' : 'Poslat registraci');

  const form = h(
    'form',
    {
      novalidate: true,
      onSubmit: (event) => {
        event.preventDefault();
        submitWith(submit, { username, password }, general, async () => {
          if (isLogin) {
            const me = await api.login(username.value.trim(), password.value);
            setMe(me);
            authDialog = null;
            await dialog.close();
            navigate('/', { replace: true });
            refreshBoard();
            if (me.user.mustChangePassword) openChangePassword({ forced: true });
            else toast(`Přihlášen jako ${me.user.username}`);
          } else {
            await api.register(username.value.trim(), password.value);
            renderPending(dialog, username.value.trim());
          }
        });
      },
    },
    username.el,
    password.el,
    general.el,
    h('div', { class: 'dialog-actions stack' }, submit),
  );

  clear(dialog.el).append(
    logos(),
    h('h2', { class: 'dialog-title' }, isLogin ? 'Přihlášení' : 'Registrace'),
    h(
      'p',
      { class: 'dialog-text' },
      isLogin
        ? 'Úkoly si může prohlížet kdokoliv. Přihlášení potřebují jen členové, kteří je zapisují a plní.'
        : 'Nový účet musí nejdřív schválit správce. Potom se budete moci přihlásit.',
    ),
    h('div', { class: 'dialog-body' }, form),
    h(
      'p',
      { class: 'dialog-switch' },
      isLogin ? 'Ještě nemáte účet? ' : 'Už účet máte? ',
      h('a', { class: 'link', href: isLogin ? '/registrace' : '/prihlaseni', onClick: (event) => {
        event.preventDefault();
        navigate(isLogin ? '/registrace' : '/prihlaseni', { replace: true });
      } }, isLogin ? 'Zaregistrujte se' : 'Přihlaste se'),
    ),
  );
  username.input.focus();
}

function renderPending(dialog, username) {
  clear(dialog.el).append(
    logos(),
    h('h2', { class: 'dialog-title' }, 'Registrace čeká na schválení'),
    h(
      'p',
      { class: 'dialog-text' },
      `Účet „${username}“ je založený. Jakmile ho správce schválí, přihlásíte se jménem a heslem, které jste právě zadali.`,
    ),
    h(
      'div',
      { class: 'dialog-actions' },
      h('button', { class: 'btn btn-primary', type: 'button', onClick: () => dialog.close() }, 'Rozumím'),
    ),
  );
  dialog.el.querySelector('button').focus();
}

/**
 * Změna hesla. Ve vynuceném režimu (dočasné heslo od správce) dialog nejde
 * zavřít jinak než změnou hesla nebo odhlášením.
 */
export function openChangePassword({ forced = false } = {}) {
  const dialog = openDialog({ label: 'Změna hesla', dismissable: !forced });
  const current = field({
    label: forced ? 'Dočasné heslo' : 'Současné heslo',
    name: 'currentPassword',
    type: 'password',
    autocomplete: 'current-password',
    required: true,
    maxlength: 128,
  });
  const next = field({
    label: 'Nové heslo',
    name: 'newPassword',
    type: 'password',
    autocomplete: 'new-password',
    required: true,
    maxlength: 128,
    hint: 'Aspoň 10 znaků. Delší věta je lepší než krátké složité heslo',
  });
  const general = formError();
  const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Změnit heslo');

  const form = h(
    'form',
    {
      novalidate: true,
      onSubmit: (event) => {
        event.preventDefault();
        submitWith(submit, { currentPassword: current, newPassword: next }, general, async () => {
          const me = await api.changePassword(current.value, next.value);
          setMe(me);
          await dialog.close();
          refreshBoard();
          toast('Heslo je změněné. Ostatní zařízení jsme odhlásili');
        });
      },
    },
    current.el,
    next.el,
    general.el,
    h(
      'div',
      { class: 'dialog-actions' },
      forced
        ? h('button', { class: 'btn btn-secondary', type: 'button', onClick: async () => {
            await api.logout().catch(() => {});
            setMe({ ...store.me, user: null, pendingUsers: undefined });
            dialog.close();
          } }, 'Odhlásit se')
        : h('button', { class: 'btn btn-secondary', type: 'button', onClick: () => dialog.close() }, 'Zrušit'),
      submit,
    ),
  );

  dialog.el.append(
    h('h2', { class: 'dialog-title' }, forced ? 'Nastavte si vlastní heslo' : 'Změna hesla'),
    h(
      'p',
      { class: 'dialog-text' },
      forced
        ? 'Přihlásili jste se dočasným heslem. Než budete pokračovat, zvolte si vlastní.'
        : 'Po změně hesla se odhlásí všechna ostatní zařízení.',
    ),
    h('div', { class: 'dialog-body' }, form),
  );
  current.input.focus();
  return dialog;
}
