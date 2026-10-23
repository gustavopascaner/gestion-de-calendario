import db, { getKv } from './db.js';
import { DEFAULT_EVENT, DEFAULT_GLOBAL, SettingsError, saveGlobal, slugify, validateEvent } from './settings.js';

const toEvent = (row) => ({ id: row.id, slug: row.slug, position: row.position, active: Boolean(row.active), ...JSON.parse(row.data) });
const pack = ({ slug, active, ...data }) => JSON.stringify(data);

export const listEvents = () => db.prepare('SELECT * FROM event_types ORDER BY position, id').all().map(toEvent);

export function getEvent(id) {
  const row = db.prepare('SELECT * FROM event_types WHERE id = ?').get(id);
  return row ? toEvent(row) : null;
}

export function getEventBySlug(slug) {
  const row = db.prepare('SELECT * FROM event_types WHERE slug = ?').get(slug);
  return row ? toEvent(row) : null;
}

const slugTaken = (slug, exceptId = 0) => Boolean(db.prepare('SELECT 1 FROM event_types WHERE slug = ? AND id != ?').get(slug, exceptId));

function freeSlug(base, exceptId = 0) {
  let slug = base;
  for (let n = 2; slugTaken(slug, exceptId); n++) slug = `${base.slice(0, 36)}-${n}`;
  return slug;
}

export function createEvent(input) {
  const clean = validateEvent(input);
  if (clean.slug && slugTaken(clean.slug)) throw new SettingsError('Ese link ya lo usa otro evento. Elegí otro.');
  const slug = clean.slug || freeSlug(slugify(clean.title));
  const position = (db.prepare('SELECT MAX(position) AS p FROM event_types').get().p ?? -1) + 1;
  const { lastInsertRowid } = db
    .prepare('INSERT INTO event_types (slug, position, active, data) VALUES (?, ?, ?, ?)')
    .run(slug, position, clean.active ? 1 : 0, pack(clean));
  return getEvent(Number(lastInsertRowid));
}

export function updateEvent(id, input) {
  const current = getEvent(id);
  if (!current) throw new SettingsError('El evento no existe.');
  const clean = validateEvent(input);
  const slug = clean.slug || current.slug;
  if (slugTaken(slug, id)) throw new SettingsError('Ese link ya lo usa otro evento. Elegí otro.');
  db.prepare('UPDATE event_types SET slug = ?, active = ?, data = ? WHERE id = ?').run(slug, clean.active ? 1 : 0, pack(clean), id);
  return getEvent(id);
}

export function duplicateEvent(id) {
  const source = getEvent(id);
  if (!source) throw new SettingsError('El evento no existe.');
  return createEvent({ ...source, title: `${source.title} (copia)`.slice(0, 100), slug: '' });
}

export function deleteEvent(id) {
  if (!getEvent(id)) throw new SettingsError('El evento no existe.');
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM bookings WHERE event_type_id = ?').get(id);
  if (n > 0) throw new SettingsError(`Este evento tiene ${n} reserva(s) registradas, así que no se puede borrar. Desactivalo para ocultarlo.`);
  db.prepare('DELETE FROM event_types WHERE id = ?').run(id);
}

export function reorderEvents(ids) {
  if (!Array.isArray(ids)) throw new SettingsError('Orden inválido.');
  const update = db.prepare('UPDATE event_types SET position = ? WHERE id = ?');
  ids.forEach((id, i) => update.run(i, Number(id)));
}

// Primer arranque: crea el evento inicial (a partir de config.js o de los ajustes de la versión anterior)
// y asigna las reservas que ya existieran.
export function seedEvents() {
  if (db.prepare('SELECT COUNT(*) AS n FROM event_types').get().n === 0) {
    const legacy = JSON.parse(getKv('settings') || 'null'); // versión de un solo evento
    if (legacy) saveGlobal({ ownerName: legacy.ownerName ?? DEFAULT_GLOBAL.ownerName, timezone: legacy.timezone ?? DEFAULT_GLOBAL.timezone });
    createEvent({ ...DEFAULT_EVENT, ...(legacy ?? {}), slug: DEFAULT_EVENT.slug });
  }
  const first = listEvents()[0];
  if (first) db.prepare("UPDATE bookings SET event_type_id = ?, event_title = ? WHERE event_type_id IS NULL").run(first.id, first.title);
}
