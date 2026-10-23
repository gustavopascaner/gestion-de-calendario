import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(os.tmpdir(), `settings-test-${process.pid}-${Date.now()}.db`);
const { validateEvent, validateGlobal, DEFAULT_EVENT, SettingsError, slugify } = await import('../src/settings.js');
const events = await import('../src/events.js');
const { default: db } = await import('../src/db.js');

const base = () => structuredClone(DEFAULT_EVENT);

test('los valores por defecto son válidos', () => {
  const clean = validateEvent(base());
  assert.equal(clean.slotMinutes, 30);
  assert.equal(clean.weekly.sat.length, 0);
});

test('rechaza horarios invertidos o superpuestos', () => {
  const a = base(); a.weekly.mon = [['17:00', '10:00']];
  assert.throws(() => validateEvent(a), SettingsError);
  const b = base(); b.weekly.mon = [['10:00', '12:00'], ['11:00', '13:00']];
  assert.throws(() => validateEvent(b), SettingsError);
});

test('valida preguntas: tipo, lista sin opciones, ids reservados y generados', () => {
  const a = base(); a.fields = [{ label: 'X', type: 'raro' }];
  assert.throws(() => validateEvent(a), SettingsError);
  const b = base(); b.fields = [{ label: 'Elegí', type: 'select', options: [] }];
  assert.throws(() => validateEvent(b), SettingsError);
  const c = base(); c.fields = [{ id: 'email', label: 'Tel', type: 'tel', required: true }, { label: 'Otra', type: 'text' }];
  const ids = validateEvent(c).fields.map((f) => f.id);
  assert.ok(!ids.includes('email'));
  assert.equal(new Set(ids).size, 2);
});

test('valida color, URL de redirección, slug y ajustes generales', () => {
  const a = base(); a.accentColor = 'rojo';
  assert.throws(() => validateEvent(a), SettingsError);
  const b = base(); b.redirectUrl = 'javascript:alert(1)';
  assert.throws(() => validateEvent(b), SettingsError);
  const c = base(); c.redirectUrl = 'https://ejemplo.com/gracias';
  assert.equal(validateEvent(c).redirectUrl, 'https://ejemplo.com/gracias');
  const d = base(); d.slug = 'Con Espacios';
  assert.throws(() => validateEvent(d), SettingsError);
  assert.throws(() => validateGlobal({ ownerName: 'Gus', timezone: 'Marte/Olympus' }), SettingsError);
  assert.equal(slugify('Llamada de descubrimiento ¡30 min!'), 'llamada-de-descubrimiento-30-min');
});

test('ABM de eventos: crea con slug único, duplica, ordena y protege los que tienen reservas', () => {
  events.seedEvents();
  const [first] = events.listEvents();
  assert.equal(first.slug, 'reunion');

  const b = events.createEvent({ ...base(), slug: '', title: 'Llamada rápida', slotMinutes: 15 });
  assert.equal(b.slug, 'llamada-rapida');
  const c = events.createEvent({ ...base(), slug: '', title: 'Llamada rápida' });
  assert.equal(c.slug, 'llamada-rapida-2');
  assert.throws(() => events.createEvent({ ...base(), slug: 'llamada-rapida' }), SettingsError);

  const copy = events.duplicateEvent(b.id);
  assert.equal(copy.title, 'Llamada rápida (copia)');
  assert.equal(copy.slotMinutes, 15);

  events.updateEvent(b.id, { ...b, active: false, title: 'Rápida' });
  assert.equal(events.getEvent(b.id).active, false);
  assert.equal(events.getEvent(b.id).slug, 'llamada-rapida'); // el slug no cambia si no se toca

  events.reorderEvents([copy.id, b.id, c.id, first.id]);
  assert.deepEqual(events.listEvents().map((e) => e.id), [copy.id, b.id, c.id, first.id]);

  db.prepare("INSERT INTO bookings (id, start_utc, end_utc, name, email, tz, event_type_id, event_title, created_at) VALUES ('x', 1, 2, 'A', 'a@b.co', 'UTC', ?, 't', 0)").run(c.id);
  assert.throws(() => events.deleteEvent(c.id), SettingsError);
  events.deleteEvent(copy.id);
  assert.equal(events.getEvent(copy.id), null);
});
