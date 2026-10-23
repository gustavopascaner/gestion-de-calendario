import crypto from 'node:crypto';
import { DateTime } from 'luxon';
import config from '../config.js';
import { getKv, setKv } from './db.js';

export class SettingsError extends Error {}

const DAY_NAMES = { mon: 'Lunes', tue: 'Martes', wed: 'Miércoles', thu: 'Jueves', fri: 'Viernes', sat: 'Sábado', sun: 'Domingo' };
const FIELD_TYPES = ['text', 'textarea', 'tel', 'select', 'checkbox'];
const RESERVED_IDS = ['name', 'email', 'tz', 'start', 't'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// Valores iniciales: salen de config.js. Lo que se guarda desde /admin tiene prioridad.
export const DEFAULTS = {
  ownerName: config.ownerName,
  title: config.title,
  description: '',
  location: 'Google Meet',
  timezone: config.timezone,
  slotMinutes: config.slotMinutes,
  bufferMinutes: config.bufferMinutes,
  minNoticeHours: config.minNoticeHours,
  horizonDays: config.horizonDays,
  weekly: config.weekly,
  accentColor: '#2563eb',
  confirmationMessage: '',
  redirectUrl: '',
  fields: [{ id: 'note', label: 'Nota (opcional)', type: 'textarea', required: false, options: [], placeholder: '¿De qué querés hablar?' }],
};

const text = (value, max, label, min = 0) => {
  const s = String(value ?? '').trim();
  if (s.length < min || s.length > max) {
    throw new SettingsError(min ? `${label}: tiene que tener entre ${min} y ${max} caracteres.` : `${label}: máximo ${max} caracteres.`);
  }
  return s;
};

const int = (value, min, max, label) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new SettingsError(`${label}: tiene que ser un número entero entre ${min} y ${max}.`);
  return n;
};

function validateWeekly(input) {
  const weekly = {};
  for (const [key, name] of Object.entries(DAY_NAMES)) {
    const ranges = input?.[key] ?? [];
    if (!Array.isArray(ranges) || ranges.length > 6) throw new SettingsError(`${name}: horarios inválidos.`);
    const clean = ranges
      .map((r) => {
        if (!Array.isArray(r) || !HHMM.test(r[0]) || !HHMM.test(r[1]) || r[0] >= r[1]) {
          throw new SettingsError(`${name}: la hora de inicio tiene que ser anterior a la de fin.`);
        }
        return [r[0], r[1]];
      })
      .sort((a, b) => a[0].localeCompare(b[0]));
    for (let i = 1; i < clean.length; i++) {
      if (clean[i][0] < clean[i - 1][1]) throw new SettingsError(`${name}: hay horarios que se superponen.`);
    }
    weekly[key] = clean;
  }
  return weekly;
}

function validateFields(input) {
  if (!Array.isArray(input) || input.length > 12) throw new SettingsError('El formulario admite hasta 12 preguntas.');
  const seen = new Set();
  return input.map((f) => {
    let id = typeof f?.id === 'string' && /^[a-z0-9_]{1,32}$/.test(f.id) && !RESERVED_IDS.includes(f.id) ? f.id : `f_${crypto.randomBytes(4).toString('hex')}`;
    if (seen.has(id)) id = `f_${crypto.randomBytes(4).toString('hex')}`;
    seen.add(id);
    const label = text(f?.label, 80, 'Texto de la pregunta', 1);
    if (!FIELD_TYPES.includes(f?.type)) throw new SettingsError(`«${label}»: tipo de pregunta inválido.`);
    let options = [];
    if (f.type === 'select') {
      options = [...new Set((Array.isArray(f.options) ? f.options : []).map((o) => String(o).trim()).filter(Boolean))];
      if (!options.length || options.length > 20 || options.some((o) => o.length > 80)) {
        throw new SettingsError(`«${label}»: la lista necesita entre 1 y 20 opciones (hasta 80 caracteres cada una).`);
      }
    }
    return { id, label, type: f.type, required: Boolean(f.required), options, placeholder: text(f.placeholder, 120, 'Texto de ayuda') };
  });
}

export function validateSettings(input) {
  if (!input || typeof input !== 'object') throw new SettingsError('Datos inválidos.');
  if (!DateTime.now().setZone(String(input.timezone)).isValid) throw new SettingsError('Zona horaria inválida.');
  if (!/^#[0-9a-fA-F]{6}$/.test(input.accentColor ?? '')) throw new SettingsError('El color tiene que ser un hexadecimal como #2563eb.');

  let redirectUrl = text(input.redirectUrl, 500, 'URL de redirección');
  if (redirectUrl) {
    let url;
    try {
      url = new URL(redirectUrl);
    } catch {
      throw new SettingsError('La URL de redirección no es válida.');
    }
    if (!['http:', 'https:'].includes(url.protocol)) throw new SettingsError('La URL de redirección tiene que empezar con http:// o https://');
    redirectUrl = url.href;
  }

  return {
    ownerName: text(input.ownerName, 100, 'Tu nombre', 1),
    title: text(input.title, 100, 'Título', 1),
    description: text(input.description, 1000, 'Descripción'),
    location: text(input.location, 100, 'Ubicación'),
    timezone: String(input.timezone),
    slotMinutes: int(input.slotMinutes, 5, 480, 'Duración'),
    bufferMinutes: int(input.bufferMinutes, 0, 240, 'Descanso entre reuniones'),
    minNoticeHours: int(input.minNoticeHours, 0, 720, 'Antelación mínima'),
    horizonDays: int(input.horizonDays, 1, 90, 'Días hacia adelante'),
    weekly: validateWeekly(input.weekly),
    accentColor: input.accentColor.toLowerCase(),
    confirmationMessage: text(input.confirmationMessage, 500, 'Mensaje de confirmación'),
    redirectUrl,
    fields: validateFields(input.fields ?? []),
  };
}

let cache = null;

export function getSettings() {
  if (!cache) {
    const raw = getKv('settings');
    cache = raw ? { ...DEFAULTS, ...JSON.parse(raw) } : structuredClone(DEFAULTS);
  }
  return cache;
}

export function saveSettings(input) {
  const clean = validateSettings(input);
  setKv('settings', JSON.stringify(clean));
  cache = clean;
  return clean;
}
