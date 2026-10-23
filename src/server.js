import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DateTime } from 'luxon';
import db from './db.js';
import { DEFAULT_EVENT, SettingsError, getGlobal, saveGlobal } from './settings.js';
import { createEvent, deleteEvent, duplicateEvent, getEvent, getEventBySlug, listEvents, reorderEvents, seedEvents, updateEvent } from './events.js';
import { generateSlots } from './availability.js';
import { sign, verify } from './tokens.js';
import * as google from './google.js';
import { notify } from './mail.js';

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const EMBED = (process.env.EMBED_ORIGINS ?? '*').trim();
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const TOKEN_TTL = 90 * 24 * 3_600_000;
const ADMIN_TTL = 12 * 3_600_000;

sign({ act: 'check', exp: 0 }); // falla al arrancar si falta SIGNING_SECRET
seedEvents();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Convierte errores de validación en respuestas 400.
function guard(fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof SettingsError) throw new HttpError(400, err.message);
    throw err;
  }
}

// ---------- disponibilidad ----------

let busyCache = null; // evita llamar a Google en cada visita; las reservas siempre consultan en fresco

async function googleBusy(now, { fresh }) {
  if (!google.isConnected()) return [];
  if (!fresh && busyCache && Date.now() - busyCache.at < 60_000) return busyCache.data;
  const days = Math.max(1, ...listEvents().map((e) => e.horizonDays));
  const data = await google.getBusy(now - 86_400_000, now + (days + 1) * 86_400_000);
  busyCache = { at: Date.now(), data };
  return data;
}

// Todas las reservas bloquean a todos los tipos de evento: sos una sola persona.
function dbBlocked(now, excludeId = '') {
  return db
    .prepare("SELECT start_utc AS start, end_utc AS end FROM bookings WHERE status = 'confirmed' AND end_utc > ? AND id != ?")
    .all(now - 86_400_000, excludeId)
    .map((r) => ({ start: r.start, end: r.end }));
}

// Nota: en una reprogramación el evento viejo sigue ocupado en Google, así que su propio horario
// no se ofrece como destino (no tiene sentido moverlo a donde ya está).
async function availableSlots(event, { fresh = false, excludeId = '' } = {}) {
  const now = Date.now();
  let busy = [];
  try {
    busy = await googleBusy(now, { fresh });
  } catch (err) {
    if (fresh) throw new HttpError(503, 'No pude consultar el calendario. Probá de nuevo en un momento.');
    console.error('[google] freeBusy falló, mostrando solo reservas locales:', err.message);
  }
  return generateSlots({ ...event, timezone: getGlobal().timezone }, now, [...dbBlocked(now, excludeId), ...busy]);
}

// ---------- helpers HTTP ----------

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function setSecurityHeaders(res) {
  const ancestors = EMBED === '*' ? '*' : ["'self'", ...EMBED.split(/[\s,]+/).filter(Boolean)].join(' ');
  res.setHeader(
    'Content-Security-Policy',
    `default-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors ${ancestors}`,
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

function serveFile(res, file, headers = {}) {
  const full = path.resolve(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    throw new HttpError(404, 'No encontrado');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache', ...headers });
  fs.createReadStream(full).pipe(res);
}

async function readJson(req) {
  if (!req.headers['content-type']?.includes('application/json')) throw new HttpError(415, 'Content-Type debe ser application/json');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 100_000) throw new HttpError(413, 'Solicitud demasiado grande');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || '{}');
  } catch {
    throw new HttpError(400, 'JSON inválido');
  }
}

const hits = new Map();
function rateLimit(req, name, max, windowMs) {
  const ip = (process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress;
  const key = `${name}:${ip}`;
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) throw new HttpError(429, 'Demasiados intentos. Probá más tarde.');
  recent.push(now);
  hits.set(key, recent);
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---------- reservas ----------

const manageToken = (id) => sign({ act: 'manage', id, exp: Date.now() + TOKEN_TTL });
const manageUrl = (token) => `${BASE_URL}/manage?t=${token}`;
const getBooking = (id) => db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);

function bookingFromToken(token) {
  const payload = verify(token, 'manage');
  const booking = payload && getBooking(payload.id);
  if (!booking) throw new HttpError(404, 'El link no es válido o venció.');
  return booking;
}

function activeEvent(slug) {
  const event = getEventBySlug(String(slug ?? ''));
  if (!event || !event.active) throw new HttpError(404, 'Este evento no existe o no está disponible.');
  return event;
}

const summary = (e) => ({ slug: e.slug, title: e.title, description: e.description, location: e.location, slotMinutes: e.slotMinutes, accentColor: e.accentColor });
const publicEvent = (e) => ({ ...summary(e), ownerName: getGlobal().ownerName, fields: e.fields });

const view = (b) => {
  const event = getEvent(b.event_type_id);
  return {
    id: b.id,
    name: b.name,
    email: b.email,
    tz: b.tz,
    start: b.start_utc,
    end: b.end_utc,
    status: b.status,
    meetUrl: b.meet_url,
    answers: JSON.parse(b.answers || '[]'),
    title: b.event_title,
    slug: event?.slug ?? '',
    ownerName: getGlobal().ownerName,
    location: event?.location ?? '',
    accentColor: event?.accentColor ?? DEFAULT_EVENT.accentColor,
    confirmationMessage: event?.confirmationMessage ?? '',
  };
};

const isTz = (tz) => typeof tz === 'string' && DateTime.now().setZone(tz).isValid;

function parseStart(value) {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) throw new HttpError(400, 'Horario inválido');
  return ms;
}

// Valida las respuestas contra las preguntas configuradas; devuelve [{ id, label, value }].
function parseAnswers(fields, raw) {
  const answers = [];
  for (const f of fields) {
    const given = raw?.[f.id];
    if (f.type === 'checkbox') {
      const checked = given === true || given === 'on';
      if (f.required && !checked) throw new HttpError(400, `Tenés que aceptar «${f.label}».`);
      answers.push({ id: f.id, label: f.label, value: checked ? 'Sí' : 'No' });
      continue;
    }
    const value = String(given ?? '').trim();
    if (!value) {
      if (f.required) throw new HttpError(400, `Completá «${f.label}».`);
      continue;
    }
    if (value.length > (f.type === 'textarea' ? 2000 : 300)) throw new HttpError(400, `«${f.label}» es demasiado largo.`);
    if (f.type === 'select' && !f.options.includes(value)) throw new HttpError(400, `Elegí una opción válida en «${f.label}».`);
    answers.push({ id: f.id, label: f.label, value });
  }
  return answers;
}

async function createBooking(body) {
  const event = activeEvent(body.slug);
  const tzOwner = getGlobal().timezone;
  const name = String(body.name ?? '').trim();
  const email = String(body.email ?? '').trim();
  if (!name || name.length > 100) throw new HttpError(400, 'Ingresá tu nombre (máx. 100 caracteres).');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) throw new HttpError(400, 'Ingresá un email válido.');
  const answers = parseAnswers(event.fields, body.answers);
  const note = answers.map((a) => `${a.label}: ${a.value}`).join('\n');
  const tz = isTz(body.tz) ? body.tz : tzOwner;
  const start = parseStart(body.start);

  const slots = await availableSlots(event, { fresh: true });
  if (!slots.includes(start)) throw new HttpError(409, 'Ese horario ya no está disponible. Elegí otro.');

  // Sin awaits entre la verificación y el INSERT: en un solo proceso esto es atómico.
  const id = crypto.randomBytes(9).toString('base64url');
  const end = start + event.slotMinutes * 60_000;
  try {
    db.prepare(
      'INSERT INTO bookings (id, start_utc, end_utc, name, email, note, answers, tz, event_type_id, event_title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, start, end, name, email, note, JSON.stringify(answers), tz, event.id, event.title, Date.now());
  } catch (err) {
    if (/UNIQUE/i.test(err.message)) throw new HttpError(409, 'Ese horario ya no está disponible. Elegí otro.');
    throw err;
  }

  let booking = getBooking(id);
  if (google.isConnected()) {
    try {
      const ev = await google.createEvent({ booking, title: event.title, ownerTz: tzOwner });
      db.prepare('UPDATE bookings SET google_event_id = ?, meet_url = ? WHERE id = ?').run(ev.id, ev.meetUrl, id);
      booking = getBooking(id);
    } catch (err) {
      db.prepare('DELETE FROM bookings WHERE id = ?').run(id);
      console.error('[google] no se pudo crear el evento:', err.message);
      throw new HttpError(502, 'No pude crear el evento en el calendario. Probá de nuevo.');
    }
  }
  busyCache = null;

  const token = manageToken(id);
  await notify('confirmed', booking, { manageUrl: manageUrl(token) });
  return { token, redirectUrl: event.redirectUrl || null };
}

async function cancelBooking(booking) {
  if (booking.status !== 'confirmed') throw new HttpError(409, 'Esta reserva ya fue cancelada.');
  if (booking.start_utc <= Date.now()) throw new HttpError(409, 'La reunión ya comenzó.');
  db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(booking.id);
  busyCache = null;
  if (booking.google_event_id) {
    try {
      await google.deleteEvent(booking.google_event_id);
    } catch (err) {
      console.error('[google] no se pudo borrar el evento:', err.message);
    }
  }
  await notify('cancelled', getBooking(booking.id), { manageUrl: '' });
}

async function rescheduleBooking(token, startValue) {
  const booking = bookingFromToken(token);
  if (booking.status !== 'confirmed') throw new HttpError(409, 'Esta reserva está cancelada.');
  if (booking.start_utc <= Date.now()) throw new HttpError(409, 'La reunión ya comenzó.');
  const event = getEvent(booking.event_type_id);
  if (!event) throw new HttpError(409, 'El tipo de evento ya no existe.');
  const start = parseStart(startValue);

  const slots = await availableSlots(event, { fresh: true, excludeId: booking.id });
  if (!slots.includes(start)) throw new HttpError(409, 'Ese horario ya no está disponible. Elegí otro.');

  const end = start + event.slotMinutes * 60_000;
  const update = db.prepare('UPDATE bookings SET start_utc = ?, end_utc = ? WHERE id = ?');
  try {
    update.run(start, end, booking.id);
  } catch (err) {
    if (/UNIQUE/i.test(err.message)) throw new HttpError(409, 'Ese horario ya no está disponible. Elegí otro.');
    throw err;
  }
  if (booking.google_event_id) {
    try {
      await google.moveEvent(booking.google_event_id, start, end, getGlobal().timezone);
    } catch (err) {
      update.run(booking.start_utc, booking.end_utc, booking.id);
      console.error('[google] no se pudo mover el evento:', err.message);
      throw new HttpError(502, 'No pude actualizar el calendario. Probá de nuevo.');
    }
  }
  busyCache = null;
  await notify('rescheduled', getBooking(booking.id), { manageUrl: manageUrl(token) });
}

// ---------- panel de administración ----------

function adminCookie(req) {
  return /(?:^|;\s*)admin=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ?? null;
}

function requireAdmin(req) {
  if (!process.env.ADMIN_SECRET) throw new HttpError(404, 'El panel está desactivado: definí ADMIN_SECRET en .env.');
  if (!verify(adminCookie(req), 'admin')) throw new HttpError(401, 'No autorizado');
}

const cookie = (value, maxAge) =>
  `admin=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${BASE_URL.startsWith('https') ? '; Secure' : ''}`;

async function handleAdminApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  if (route === 'POST /api/admin/login') {
    if (!process.env.ADMIN_SECRET) throw new HttpError(404, 'El panel está desactivado: definí ADMIN_SECRET en .env.');
    rateLimit(req, 'login', 10, 15 * 60_000);
    const { password } = await readJson(req);
    if (!safeEqual(password ?? '', process.env.ADMIN_SECRET)) throw new HttpError(401, 'Contraseña incorrecta');
    res.setHeader('Set-Cookie', cookie(sign({ act: 'admin', exp: Date.now() + ADMIN_TTL }), ADMIN_TTL / 1000));
    return sendJson(res, 200, { ok: true });
  }
  if (route === 'POST /api/admin/logout') {
    res.setHeader('Set-Cookie', cookie('', 0));
    return sendJson(res, 200, { ok: true });
  }

  requireAdmin(req);
  const body = req.method === 'POST' || req.method === 'PUT' ? await readJson(req) : {};
  const eventRoute = /^\/api\/admin\/events\/(\d+)$/.exec(url.pathname);
  if (eventRoute) {
    const id = Number(eventRoute[1]);
    if (req.method === 'PUT') return sendJson(res, 200, { event: guard(() => updateEvent(id, body)) });
    if (req.method === 'DELETE') {
      guard(() => deleteEvent(id));
      return sendJson(res, 200, { ok: true });
    }
  }

  switch (route) {
    case 'GET /api/admin/settings':
      return sendJson(res, 200, {
        global: getGlobal(),
        events: listEvents(),
        defaultEvent: { ...DEFAULT_EVENT, slug: '', title: 'Nuevo evento' },
        google: { configured: google.isConfigured(), connected: google.isConnected() },
        smtp: Boolean(process.env.SMTP_HOST),
      });
    case 'PUT /api/admin/global':
      return sendJson(res, 200, { global: guard(() => saveGlobal(body)) });
    case 'POST /api/admin/events': {
      const event = guard(() => (body.duplicateOf ? duplicateEvent(Number(body.duplicateOf)) : createEvent(body)));
      return sendJson(res, 201, { event });
    }
    case 'POST /api/admin/events/order':
      guard(() => reorderEvents(body.ids));
      return sendJson(res, 200, { ok: true });
    case 'GET /api/admin/bookings': {
      const now = Date.now();
      const rows = db
        .prepare("SELECT * FROM bookings WHERE (status = 'confirmed' AND end_utc > ?) OR (status = 'cancelled' AND created_at > ?) ORDER BY start_utc")
        .all(now, now - 30 * 86_400_000);
      return sendJson(res, 200, { bookings: rows.map(view) });
    }
    case 'POST /api/admin/cancel': {
      const booking = getBooking(body.id);
      if (!booking) throw new HttpError(404, 'Reserva no encontrada');
      await cancelBooking(booking);
      return sendJson(res, 200, { ok: true });
    }
    default:
      throw new HttpError(404, 'No encontrado');
  }
}

async function handleGoogleOAuth(req, res, url) {
  if (!google.isConfigured()) throw new HttpError(404, 'Google no está configurado en .env');
  if (url.pathname === '/admin/google/connect') {
    requireAdmin(req);
    const state = sign({ act: 'oauth', exp: Date.now() + 10 * 60_000 });
    res.writeHead(302, { Location: google.authUrl(state) });
    return res.end();
  }
  if (url.pathname === '/admin/google/callback') {
    if (!verify(url.searchParams.get('state'), 'oauth')) throw new HttpError(400, 'Estado OAuth inválido o vencido. Empezá de nuevo desde el panel.');
    if (url.searchParams.get('error')) throw new HttpError(400, `Google rechazó el acceso: ${url.searchParams.get('error')}`);
    await google.exchangeCode(url.searchParams.get('code') ?? '');
    busyCache = null;
    return sendHtml(res, 200, '<!doctype html><meta charset="utf-8"><title>Conectado</title><h1>Google Calendar conectado ✅</h1><p><a href="/admin">Volver al panel</a></p>');
  }
  throw new HttpError(404, 'No encontrado');
}

// ---------- rutas públicas ----------

async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  switch (route) {
    case 'GET /api/events':
      return sendJson(res, 200, { ownerName: getGlobal().ownerName, events: listEvents().filter((e) => e.active).map(summary) });
    case 'GET /api/event':
      return sendJson(res, 200, publicEvent(activeEvent(url.searchParams.get('slug'))));
    case 'GET /api/slots':
      return sendJson(res, 200, { slots: await availableSlots(activeEvent(url.searchParams.get('slug'))), timezone: getGlobal().timezone });
    case 'POST /api/book':
      rateLimit(req, 'book', 10, 3_600_000);
      return sendJson(res, 201, await createBooking(await readJson(req)));
    case 'GET /api/booking':
      return sendJson(res, 200, view(bookingFromToken(url.searchParams.get('t'))));
    case 'POST /api/cancel':
      rateLimit(req, 'book', 10, 3_600_000);
      await cancelBooking(bookingFromToken((await readJson(req)).t));
      return sendJson(res, 200, { ok: true });
    case 'POST /api/reschedule': {
      rateLimit(req, 'book', 10, 3_600_000);
      const body = await readJson(req);
      await rescheduleBooking(body.t, body.start);
      return sendJson(res, 200, { ok: true });
    }
    default:
      throw new HttpError(404, 'No encontrado');
  }
}

const PAGES = { '/book': 'book.html', '/confirm': 'manage.html', '/manage': 'manage.html', '/admin': 'admin.html', '/embed-example': 'embed-example.html' };

const server = http.createServer(async (req, res) => {
  setSecurityHeaders(res);
  try {
    const url = new URL(req.url, BASE_URL);
    if (url.pathname === '/') {
      res.writeHead(302, { Location: '/book' });
      return res.end();
    }
    if (url.pathname.startsWith('/api/admin/')) return await handleAdminApi(req, res, url);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (url.pathname.startsWith('/admin/google/')) return await handleGoogleOAuth(req, res, url);
    if (req.method === 'GET' && url.pathname.startsWith('/book/')) return serveFile(res, 'book.html'); // /book/<slug>
    if (req.method === 'GET' && PAGES[url.pathname]) {
      // El panel nunca debe poder embeberse en otro sitio.
      return serveFile(res, PAGES[url.pathname], url.pathname === '/admin' ? { 'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'" } : {});
    }
    if (req.method === 'GET' && url.pathname.startsWith('/assets/')) return serveFile(res, decodeURIComponent(url.pathname.slice(1)));
    throw new HttpError(404, 'No encontrado');
  } catch (err) {
    const status = err.status ?? 500;
    if (!(err instanceof HttpError)) console.error(err);
    const message = err instanceof HttpError ? err.message : 'Error interno';
    if (res.headersSent) return res.end();
    if (new URL(req.url, BASE_URL).pathname.startsWith('/api/')) sendJson(res, status, { error: message });
    else sendHtml(res, status, `<!doctype html><meta charset="utf-8"><title>${status}</title><p>${message.replace(/[<>&]/g, '')}</p>`);
  }
});

server.listen(PORT, () => {
  console.log(`Reservas en ${BASE_URL}/book`);
  console.log(`Eventos: ${listEvents().map((e) => `/book/${e.slug}${e.active ? '' : ' (inactivo)'}`).join(', ') || 'ninguno'}`);
  console.log(`Panel: ${process.env.ADMIN_SECRET ? `${BASE_URL}/admin` : 'desactivado (definí ADMIN_SECRET)'}`);
  console.log(`Google Calendar: ${google.isConnected() ? 'conectado' : google.isConfigured() ? 'configurado, falta conectar desde el panel' : 'sin configurar (solo SQLite)'}`);
  console.log(`SMTP: ${process.env.SMTP_HOST ? process.env.SMTP_HOST : 'sin configurar (los mails solo se registran en consola)'}`);
});
