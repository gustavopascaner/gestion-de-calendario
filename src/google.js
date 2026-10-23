import crypto from 'node:crypto';
import db, { getKv, setKv } from './db.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const API = 'https://www.googleapis.com/calendar/v3';

// Cuenta principal: crea eventos con Meet y consulta disponibilidad.
const SCOPES_PRIMARY = ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.freebusy'];
// Cuentas extra: solo disponibilidad (freeBusy) + el email para mostrarla en el panel.
const SCOPES_BUSY = ['https://www.googleapis.com/auth/calendar.freebusy', 'https://www.googleapis.com/auth/userinfo.email'];

const env = () => ({
  clientId: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  redirectUri: process.env.GOOGLE_REDIRECT_URI,
  calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
});

export const isConfigured = () => {
  const e = env();
  return Boolean(e.clientId && e.clientSecret && e.redirectUri);
};

const primaryRefresh = () => getKv('google_refresh_token');
export const isConnected = () => isConfigured() && Boolean(primaryRefresh());

export const listBusyAccounts = () => db.prepare('SELECT id, email FROM google_busy_accounts ORDER BY id').all().map((a) => ({ id: a.id, email: a.email }));
export const removeBusyAccount = (id) => db.prepare('DELETE FROM google_busy_accounts WHERE id = ?').run(Number(id));

/** ¿Hay alguna cuenta de la que consultar disponibilidad? */
export const canCheckBusy = () => isConfigured() && (Boolean(primaryRefresh()) || listBusyAccounts().length > 0);

export function authUrl(state, mode = 'primary') {
  const e = env();
  const q = new URLSearchParams({
    client_id: e.clientId,
    redirect_uri: e.redirectUri,
    response_type: 'code',
    scope: (mode === 'busy' ? SCOPES_BUSY : SCOPES_PRIMARY).join(' '),
    access_type: 'offline',
    prompt: 'consent select_account', // fuerza refresh_token y deja elegir la cuenta
    state,
  });
  return `${AUTH_URL}?${q}`;
}

async function tokenRequest(params) {
  const e = env();
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: e.clientId, client_secret: e.clientSecret, ...params }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google OAuth: ${data.error_description || data.error || res.status}`);
  return data;
}

const cache = new Map(); // refresh_token -> { token, exp }

async function accessToken(refresh) {
  if (!refresh) throw new Error('Google Calendar no está conectado (conectalo desde el panel)');
  const hit = cache.get(refresh);
  if (hit && hit.exp > Date.now()) return hit.token;
  const data = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh });
  cache.set(refresh, { token: data.access_token, exp: Date.now() + (data.expires_in - 60) * 1000 });
  return data.access_token;
}

/** Canjea el código de OAuth. mode 'primary' reemplaza la cuenta principal; 'busy' suma una cuenta de solo disponibilidad. */
export async function exchangeCode(code, mode = 'primary') {
  const data = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: env().redirectUri });
  if (!data.refresh_token) {
    throw new Error('Google no devolvió refresh_token. Revocá el acceso en myaccount.google.com/permissions y reconectá.');
  }
  cache.set(data.refresh_token, { token: data.access_token, exp: Date.now() + (data.expires_in - 60) * 1000 });
  if (mode !== 'busy') return setKv('google_refresh_token', data.refresh_token);

  const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: `Bearer ${data.access_token}` } });
  const email = (await res.json().catch(() => ({}))).email;
  if (!email) throw new Error('No pude leer el email de la cuenta de Google.');
  db.prepare(
    'INSERT INTO google_busy_accounts (email, refresh_token, created_at) VALUES (?, ?, ?) ON CONFLICT(email) DO UPDATE SET refresh_token = excluded.refresh_token',
  ).run(email, data.refresh_token, Date.now());
}

async function call(path, { method = 'GET', query, body, okStatuses = [], refresh = primaryRefresh() } = {}) {
  const url = `${API}${path}${query ? `?${new URLSearchParams(query)}` : ''}`;
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${await accessToken(refresh)}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && !okStatuses.includes(res.status)) {
    throw new Error(`Google Calendar ${method} ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.status === 204 ? null : res.json().catch(() => null);
}

const calPath = () => `/calendars/${encodeURIComponent(env().calendarId)}`;

async function busyFrom({ refresh, calendarId, label }, fromMs, toMs) {
  const data = await call('/freeBusy', {
    method: 'POST',
    refresh,
    body: { timeMin: new Date(fromMs).toISOString(), timeMax: new Date(toMs).toISOString(), items: [{ id: calendarId }] },
  });
  const cal = data?.calendars?.[calendarId];
  if (!cal || cal.errors?.length) throw new Error(`Google freeBusy (${label}): ${JSON.stringify(cal?.errors ?? 'sin datos')}`);
  return cal.busy.map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) }));
}

/** Intervalos ocupados [{start, end}] en ms, sumando la cuenta principal y las extra. Lanza si alguna falla. */
export async function getBusy(fromMs, toMs) {
  const sources = [];
  if (primaryRefresh()) sources.push({ refresh: primaryRefresh(), calendarId: env().calendarId, label: 'principal' });
  for (const a of db.prepare('SELECT email, refresh_token FROM google_busy_accounts').all()) {
    sources.push({ refresh: a.refresh_token, calendarId: 'primary', label: a.email });
  }
  return (await Promise.all(sources.map((s) => busyFrom(s, fromMs, toMs)))).flat();
}

const when = (ms, tz) => ({ dateTime: new Date(ms).toISOString(), timeZone: tz });

/** Crea el evento con Meet e invita al visitante (solo en la cuenta principal). Devuelve { id, meetUrl }. */
export async function createEvent({ booking, title, ownerTz }) {
  const ev = await call(`${calPath()}/events`, {
    method: 'POST',
    query: { conferenceDataVersion: '1', sendUpdates: 'all' },
    body: {
      summary: `${title} — ${booking.name}`,
      description: booking.note ? `Respuestas del formulario:\n${booking.note}` : undefined,
      start: when(booking.start_utc, ownerTz),
      end: when(booking.end_utc, ownerTz),
      attendees: [{ email: booking.email, displayName: booking.name }],
      conferenceData: {
        createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } },
      },
    },
  });
  return { id: ev.id, meetUrl: ev.hangoutLink ?? null };
}

export async function moveEvent(eventId, startMs, endMs, ownerTz) {
  await call(`${calPath()}/events/${encodeURIComponent(eventId)}`, {
    method: 'PATCH',
    query: { sendUpdates: 'all' },
    body: { start: when(startMs, ownerTz), end: when(endMs, ownerTz) },
  });
}

export async function deleteEvent(eventId) {
  await call(`${calPath()}/events/${encodeURIComponent(eventId)}`, {
    method: 'DELETE',
    query: { sendUpdates: 'all' },
    okStatuses: [404, 410], // ya borrado
  });
}
