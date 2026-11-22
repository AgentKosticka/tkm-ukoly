import { h } from '../dom.js';
import { GENERAL_ROOM } from '../format.js';
import { store } from '../store.js';

/**
 * Výběr místnosti pro úkol. První volba je „Obecné“, tedy bez místnosti.
 * Vrací prvek <select>; hodnotu čte `selectedRoom`.
 */
export function roomSelect({ value = null, onChange, label = 'Místnost' } = {}) {
  const select = h(
    'select',
    { class: 'select', 'aria-label': label, onChange: () => onChange?.(selectedRoom(select)) },
    h('option', { value: '' }, GENERAL_ROOM),
    store.rooms.map((room) => h('option', { value: String(room.id) }, room.name)),
  );
  select.value = value === null ? '' : String(value);
  // Místnost, kterou mezitím někdo smazal, se chová jako „Obecné“.
  if (select.selectedIndex === -1) select.value = '';
  return select;
}

export const selectedRoom = (select) => (select.value === '' ? null : Number(select.value));
