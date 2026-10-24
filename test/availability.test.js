import test from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import { generateSlots } from '../src/availability.js';

const zone = 'America/Argentina/Buenos_Aires';
const cfg = {
  timezone: zone,
  slotMinutes: 30,
  bufferMinutes: 15,
  minNoticeHours: 0,
  horizonDays: 14,
  weekly: { mon: [['10:00', '17:00']], tue: [['10:00', '17:00']], wed: [['10:00', '17:00']], thu: [['10:00', '17:00']], fri: [['10:00', '17:00']] },
};
const at = (iso) => DateTime.fromISO(iso, { zone }).toMillis();
const now = at('2026-10-19T08:00'); // lunes

test('lunes a viernes, 14 slots por día, 14 días, sin fines de semana', () => {
  const slots = generateSlots(cfg, now);
  assert.equal(slots.length, 10 * 14);
  for (const s of slots) assert.ok(DateTime.fromMillis(s, { zone }).weekday <= 5);
});

test('el buffer de 15 min bloquea los slots vecinos', () => {
  const blocked = [{ start: at('2026-10-19T10:00'), end: at('2026-10-19T10:30') }];
  const day = generateSlots(cfg, now, blocked).filter((s) => DateTime.fromMillis(s, { zone }).day === 19);
  const hhmm = day.map((s) => DateTime.fromMillis(s, { zone }).toFormat('HH:mm'));
  assert.ok(!hhmm.includes('10:00') && !hhmm.includes('10:30'));
  assert.equal(hhmm[0], '11:00');
});

test('respeta la antelación mínima', () => {
  const slots = generateSlots({ ...cfg, minNoticeHours: 4 }, at('2026-10-19T09:00'));
  assert.equal(DateTime.fromMillis(slots[0], { zone }).toFormat('HH:mm'), '13:00');
});

test('un evento ocupado de varias horas bloquea todo el rango', () => {
  const blocked = [{ start: at('2026-10-20T00:00'), end: at('2026-10-21T00:00') }];
  const slots = generateSlots(cfg, now, blocked);
  assert.ok(!slots.some((s) => DateTime.fromMillis(s, { zone }).day === 20));
});

test('stepMinutes ofrece inicios más seguidos que la duración', () => {
  const slots = generateSlots({ ...cfg, stepMinutes: 15, bufferMinutes: 0 }, now);
  assert.equal(slots[1] - slots[0], 15 * 60_000);
});
