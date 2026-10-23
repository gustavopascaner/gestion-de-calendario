import crypto from 'node:crypto';
import { getKv, setKv } from './db.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const API = 'https://www.googleapis.com/calendar/v3';
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.freebusy',
];

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
export const isConnected = () => isConfigured() && Boolean(getKv('google_refresh_token'));

export function authUrl(state) {
  const e = env();
  const q = new URLSearchParams({
    client_id: e.clientId,
    redirect_uri: e.redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent', // fuerza a Google a devolver refresh_token
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

export async function exchangeCode(code) {
  const data = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: env().redirectUri });
  if (!data.refresh_token) {
    throw new Error('Google no devolvió refresh_token. Revocá el acceso en myaccount.google.com/permissions y reconectá.');
  }
  setKv('google_refresh_token', data.refresh_token);
  cached = { token: data.access_token, exp: Date.now() + (data.expires_in - 60) * 1000 };
}

let cached = null;
async function accessToken() {
  if (cached && cached.exp > Date.now()) return cached.token;
  const refresh = getKv('google_refresh_token');
  if (!refresh) throw new Error('Google Calendar no está conectado (visitá /admin/google/connect)');
  const data = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh });
  cached = { token: data.access_token, exp: Date.now() + (data.expires_in - 60) * 1000 };
  return cached.token;
}

async function call(path, { method = 'GET', query, body, okStatuses = [] } = {}) {
  const url = `${API}${path}${query ? `?${new URLSearchParams(query)}` : ''}`;
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && !okStatuses.includes(res.status)) {
    throw new Error(`Google Calendar ${method} ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.status === 204 ? null : res.json().catch(() => null);
}

const calPath = () => `/calendars/${encodeURIComponent(env().calendarId)}`;

/** Intervalos ocupados [{start, end}] en ms. Lanza si Google falla. */
export async function getBusy(fromMs, toMs) {
  const { calendarId } = env();
  const data = await call('/freeBusy', {
    method: 'POST',
    body: { timeMin: new Date(fromMs).toISOString(), timeMax: new Date(toMs).toISOString(), items: [{ id: calendarId }] },
  });
  const cal = data?.calendars?.[calendarId];
  if (!cal || cal.errors?.length) throw new Error(`Google freeBusy: ${JSON.stringify(cal?.errors ?? 'sin datos')}`);
  return cal.busy.map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) }));
}

const when = (ms, tz) => ({ dateTime: new Date(ms).toISOString(), timeZone: tz });

/** Crea el evento con Meet e invita al visitante. Devuelve { id, meetUrl }. */
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
