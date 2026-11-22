// Česká pravidla pro čísla, data a skloňování.

export const STATUS = {
  todo: { label: 'Nesplněno', short: 'Nesplněno', empty: 'Nic nečeká' },
  doing: { label: 'Pracuje se', short: 'Pracuje se', empty: 'Nikdo teď na ničem nepracuje' },
  done: { label: 'Splněno', short: 'Splněno', empty: 'Zatím nic hotového' },
};
export const STATUSES = ['todo', 'doing', 'done'];

const plural = new Intl.PluralRules('cs');

/** plural(5, 'fotka', 'fotky', 'fotek') → „5 fotek“ */
export function count(n, one, few, many) {
  const rule = plural.select(n);
  const word = rule === 'one' ? one : rule === 'few' ? few : many;
  return `${n} ${word}`;
}

const dayMonth = new Intl.DateTimeFormat('cs-CZ', { day: 'numeric', month: 'numeric' });
const dayMonthYear = new Intl.DateTimeFormat('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric' });
const time = new Intl.DateTimeFormat('cs-CZ', { hour: 'numeric', minute: '2-digit' });
const full = new Intl.DateTimeFormat('cs-CZ', { dateStyle: 'long', timeStyle: 'short' });

const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/** Krátké datum pro karty: „dnes 14:05“, „včera“, „3. 11.“, „3. 11. 2025“. */
export function shortDate(timestamp, now = new Date()) {
  const date = new Date(timestamp);
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days === 0) return `dnes ${time.format(date)}`;
  if (days === 1) return 'včera';
  return date.getFullYear() === now.getFullYear() ? dayMonth.format(date) : dayMonthYear.format(date);
}

/** Datum s časem pro historii úkolu. */
export function eventDate(timestamp, now = new Date()) {
  const date = new Date(timestamp);
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days === 0) return `dnes ${time.format(date)}`;
  if (days === 1) return `včera ${time.format(date)}`;
  const day = date.getFullYear() === now.getFullYear() ? dayMonth.format(date) : dayMonthYear.format(date);
  return `${day} ${time.format(date)}`;
}

export const fullDate = (timestamp) => full.format(new Date(timestamp));
export const isoDate = (timestamp) => new Date(timestamp).toISOString();

export function megabytes(bytes) {
  return `${(bytes / (1024 * 1024)).toLocaleString('cs-CZ', { maximumFractionDigits: 1 })} MB`;
}

/** Úkoly bez místnosti. V adrese filtru má číslo 0. */
export const GENERAL_ROOM = 'Obecné';
