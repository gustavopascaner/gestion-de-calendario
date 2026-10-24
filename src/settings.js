import crypto from 'node:crypto';
import { DateTime } from 'luxon';
import config from '../config.js';
import { getKv, setKv } from './db.js';

export class SettingsError extends Error {}

const DAY_NAMES = { mon: 'Lunes', tue: 'Martes', wed: 'Miércoles', thu: 'Jueves', fri: 'Viernes', sat: 'Sábado', sun: 'Domingo' };
const FIELD_TYPES = ['text', 'textarea', 'tel', 'select', 'checkbox'];
const RESERVED_IDS = ['name', 'email', 'tz', 'start', 't'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// Valores iniciales: salen de config.js. Lo que se guarda desde /admin tiene prioridad.
export const DEFAULT_GLOBAL = { ownerName: config.ownerName, timezone: config.timezone, webhookUrl: '', webhookSecret: '', pixelId: '' };

export const DEFAULT_EVENT = {
  slug: 'reunion',
  active: true,
  title: config.title,
  description: '',
  location: 'Google Meet',
  slotMinutes: config.slotMinutes,
  stepMinutes: 0, // cada cuánto se ofrecen horarios de inicio (0 = igual a la duración)
  bufferMinutes: config.bufferMinutes,
  minNoticeHours: config.minNoticeHours,
  horizonDays: config.horizonDays,
  weekly: config.weekly,
  accentColor: '#2563eb',
  confirmationMessage: '',
  redirectUrl: '',
  pixelEnabled: false, // enviar el evento de conversión al pixel al confirmarse una reserva
  pixelEvent: 'Schedule',
  fields: [{ id: 'note', label: 'Nota (opcional)', type: 'textarea', required: false, options: [], placeholder: '¿De qué querés hablar?' }],
};

export const slugify = (s) =>
  String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'evento';

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

const checkTz = (tz) => {
  if (!DateTime.now().setZone(String(tz)).isValid) throw new SettingsError('Zona horaria inválida.');
  return String(tz);
};

// ---------- ajustes generales (compartidos por todos los eventos) ----------

function validatePixelId(value) {
  const id = String(value ?? '').trim();
  if (id && !/^\d{8,20}$/.test(id)) throw new SettingsError('El ID del pixel son solo números (entre 8 y 20 dígitos).');
  return id;
}

export function validateGlobal(input) {
  if (!input || typeof input !== 'object') throw new SettingsError('Datos inválidos.');
  let webhookUrl = text(input.webhookUrl, 500, 'URL del webhook');
  if (webhookUrl) {
    let url;
    try {
      url = new URL(webhookUrl);
    } catch {
      throw new SettingsError('La URL del webhook no es válida.');
    }
    if (!['http:', 'https:'].includes(url.protocol)) throw new SettingsError('La URL del webhook tiene que empezar con http:// o https://');
    webhookUrl = url.href;
  }
  return {
    ownerName: text(input.ownerName, 100, 'Tu nombre', 1),
    timezone: checkTz(input.timezone),
    webhookUrl,
    webhookSecret: text(input.webhookSecret, 200, 'Secreto del webhook'),
    pixelId: validatePixelId(input.pixelId),
  };
}

let globalCache = null;

export function getGlobal() {
  globalCache ??= { ...DEFAULT_GLOBAL, ...JSON.parse(getKv('global') || '{}') };
  return globalCache;
}

export function saveGlobal(input) {
  const clean = validateGlobal(input);
  // El panel nunca recibe el secreto guardado: si llega vacío se conserva, salvo que se pida quitarlo.
  if (!clean.webhookSecret && !input.clearWebhookSecret) clean.webhookSecret = getGlobal().webhookSecret ?? '';
  setKv('global', JSON.stringify(clean));
  globalCache = clean;
  return clean;
}

// ---------- tipos de evento ----------

function validatePixelEvent(value) {
  const name = String(value ?? '').trim() || DEFAULT_EVENT.pixelEvent;
  if (!/^[A-Za-z][A-Za-z0-9_]{0,49}$/.test(name)) throw new SettingsError('El nombre del evento del pixel solo admite letras, números y guion bajo (p. ej. Schedule, Lead).');
  return name;
}

export function validateEvent(input) {
  if (!input || typeof input !== 'object') throw new SettingsError('Datos inválidos.');
  if (!/^#[0-9a-fA-F]{6}$/.test(input.accentColor ?? '')) throw new SettingsError('El color tiene que ser un hexadecimal como #2563eb.');

  const slug = String(input.slug ?? '').trim().toLowerCase();
  if (slug && (slug.length > 40 || !SLUG.test(slug))) {
    throw new SettingsError('El link solo admite letras minúsculas, números y guiones (p. ej. llamada-30).');
  }

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
    slug,
    active: input.active !== false,
    title: text(input.title, 100, 'Título', 1),
    description: text(input.description, 1000, 'Descripción'),
    location: text(input.location, 100, 'Ubicación'),
    slotMinutes: int(input.slotMinutes, 5, 480, 'Duración'),
    stepMinutes: int(input.stepMinutes ?? 0, 0, 480, 'Intervalo de horarios'),
    bufferMinutes: int(input.bufferMinutes, 0, 240, 'Descanso entre reuniones'),
    minNoticeHours: int(input.minNoticeHours, 0, 720, 'Antelación mínima'),
    horizonDays: int(input.horizonDays, 1, 90, 'Días hacia adelante'),
    weekly: validateWeekly(input.weekly),
    accentColor: input.accentColor.toLowerCase(),
    confirmationMessage: text(input.confirmationMessage, 500, 'Mensaje de confirmación'),
    redirectUrl,
    pixelEnabled: input.pixelEnabled === true,
    pixelEvent: validatePixelEvent(input.pixelEvent),
    fields: validateFields(input.fields ?? []),
  };
}
