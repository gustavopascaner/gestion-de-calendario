import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(os.tmpdir(), `settings-test-${process.pid}.db`);
const { validateSettings, DEFAULTS, SettingsError } = await import('../src/settings.js');

const base = () => structuredClone(DEFAULTS);

test('los valores por defecto son válidos', () => {
  const clean = validateSettings(base());
  assert.equal(clean.slotMinutes, 30);
  assert.equal(clean.weekly.sat.length, 0);
});

test('rechaza horarios invertidos o superpuestos', () => {
  const a = base(); a.weekly.mon = [['17:00', '10:00']];
  assert.throws(() => validateSettings(a), SettingsError);
  const b = base(); b.weekly.mon = [['10:00', '12:00'], ['11:00', '13:00']];
  assert.throws(() => validateSettings(b), SettingsError);
});

test('valida preguntas: tipo, lista sin opciones, ids reservados y generados', () => {
  const a = base(); a.fields = [{ label: 'X', type: 'raro' }];
  assert.throws(() => validateSettings(a), SettingsError);
  const b = base(); b.fields = [{ label: 'Elegí', type: 'select', options: [] }];
  assert.throws(() => validateSettings(b), SettingsError);
  const c = base(); c.fields = [{ id: 'email', label: 'Tel', type: 'tel', required: true }, { label: 'Otra', type: 'text' }];
  const ids = validateSettings(c).fields.map((f) => f.id);
  assert.ok(!ids.includes('email'));
  assert.equal(new Set(ids).size, 2);
});

test('valida color y URL de redirección', () => {
  const a = base(); a.accentColor = 'rojo';
  assert.throws(() => validateSettings(a), SettingsError);
  const b = base(); b.redirectUrl = 'javascript:alert(1)';
  assert.throws(() => validateSettings(b), SettingsError);
  const c = base(); c.redirectUrl = 'https://ejemplo.com/gracias';
  assert.equal(validateSettings(c).redirectUrl, 'https://ejemplo.com/gracias');
});
