// Tenká vrstva nad API serveru. Každý požadavek, který něco mění, nese
// hlavičku X-Requested-With; server bez ní odmítne cokoliv zapsat.

const CSRF = { 'X-Requested-With': 'ukolnicek' };

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message ?? 'Server neodpovídá. Zkuste to prosím znovu');
    this.status = status;
    this.code = body?.code ?? 'network';
    this.field = body?.field;
  }
}

let onUnauthenticated = () => {};
export function setUnauthenticatedHandler(handler) {
  onUnauthenticated = handler;
}

async function parse(response) {
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) {
    const error = new ApiError(response.status, data?.error);
    if (error.code === 'unauthenticated' || error.code === 'password_change_required') onUnauthenticated(error);
    throw error;
  }
  return data;
}

async function request(method, url, body) {
  let response;
  try {
    response = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? CSRF : { ...CSRF, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, { code: 'network', message: 'Nepodařilo se spojit se serverem. Zkontrolujte připojení' });
  }
  return parse(response);
}

export const api = {
  me: () => request('GET', '/api/me'),
  login: (username, password) => request('POST', '/api/auth/login', { username, password }),
  register: (username, password) => request('POST', '/api/auth/register', { username, password }),
  logout: () => request('POST', '/api/auth/logout', {}),
  changePassword: (currentPassword, newPassword) =>
    request('POST', '/api/auth/password', { currentPassword, newPassword }),

  board: () => request('GET', '/api/tasks'),
  moreDone: (cursor) => request('GET', `/api/tasks?status=done&cursor=${encodeURIComponent(cursor)}`),
  task: (id) => request('GET', `/api/tasks/${id}`),
  createTask: (data) => request('POST', '/api/tasks', data),
  updateTask: (id, data) => request('PATCH', `/api/tasks/${id}`, data),
  deleteTask: (id) => request('DELETE', `/api/tasks/${id}`),
  deletePhoto: (id) => request('DELETE', `/api/photos/${id}`),

  users: () => request('GET', '/api/admin/users'),
  approveUser: (id) => request('POST', `/api/admin/users/${id}/approve`, {}),
  rejectUser: (id) => request('POST', `/api/admin/users/${id}/reject`, {}),
  updateUser: (id, data) => request('PATCH', `/api/admin/users/${id}`, data),
  resetPassword: (id) => request('POST', `/api/admin/users/${id}/reset-password`, {}),
  deleteUser: (id) => request('DELETE', `/api/admin/users/${id}`),

  /**
   * Nahraje jednu fotku. Používá XMLHttpRequest, protože fetch neumí hlásit
   * průběh odesílání. Vrací { promise, abort }.
   */
  uploadPhoto(taskId, file, onProgress) {
    const xhr = new XMLHttpRequest();
    const promise = new Promise((resolve, reject) => {
      xhr.open('POST', `/api/tasks/${taskId}/photos`);
      xhr.setRequestHeader('X-Requested-With', CSRF['X-Requested-With']);
      xhr.responseType = 'json';
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress?.(event.loaded / event.total);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) return resolve(xhr.response);
        const error = new ApiError(xhr.status, xhr.response?.error);
        if (error.code === 'unauthenticated') onUnauthenticated(error);
        return reject(error);
      };
      xhr.onerror = () =>
        reject(new ApiError(0, { code: 'network', message: 'Nahrávání se přerušilo. Zkontrolujte připojení' }));
      xhr.onabort = () => reject(new ApiError(0, { code: 'aborted', message: 'Nahrávání zrušeno' }));
      const form = new FormData();
      form.append('photo', file);
      xhr.send(form);
    });
    return { promise, abort: () => xhr.abort() };
  },
};

export const media = {
  thumb: (id) => `/media/${id}/thumb`,
  view: (id) => `/media/${id}/view`,
  original: (id) => `/api/photos/${id}/original`,
};
