import crypto from 'node:crypto';
import db, { getKv, setKv } from './db.js';
import { getGlobal, SettingsError } from './settings.js';
import { getEvent, listEvents } from './events.js';

const iso = (ms) => new Date(ms).toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const RETRY_DELAYS = [0, 2_000, 10_000, 60_000]; // 4 intentos en total

/**
 * Arma el payload con la misma forma que el de Calendly (event + payload), para poder reutilizar
 * flujos de n8n que ya leen esos campos.
 *   kind: 'invitee.created' | 'invitee.canceled' | 'invitee.rescheduled'
 */
export function buildPayload(kind, booking, { baseUrl, manageUrl = '', previousStart = null, event = getEvent(booking.event_type_id) } = {}) {
  const [first, ...rest] = booking.name.trim().split(/\s+/);
  const canceled = kind === 'invitee.canceled';
  const status = canceled ? 'canceled' : 'active';
  const tracking = JSON.parse(booking.tracking || '{}');
  const answers = JSON.parse(booking.answers || '[]');

  return {
    created_at: new Date().toISOString(),
    event: kind,
    payload: {
      booking_id: booking.id,
      cancel_url: canceled ? null : manageUrl || null,
      reschedule_url: canceled ? null : manageUrl || null,
      created_at: iso(booking.created_at),
      updated_at: new Date().toISOString(),
      email: booking.email,
      name: booking.name,
      first_name: first || null,
      last_name: rest.join(' ') || null,
      timezone: booking.tz,
      status,
      rescheduled: kind === 'invitee.rescheduled',
      old_start_time: previousStart ? iso(previousStart) : null,
      questions_and_answers: answers.map((a, position) => ({ question: a.label, answer: a.value, position })),
      scheduled_event: {
        name: booking.event_title,
        start_time: iso(booking.start_utc),
        end_time: iso(booking.end_utc),
        status,
        event_type: event ? `${baseUrl}/book/${event.slug}` : null,
        event_type_slug: event?.slug ?? null,
        location: booking.meet_url
          ? { type: 'google_conference', join_url: booking.meet_url, status: 'pushed' }
          : { type: 'custom', location: event?.location ?? '' },
        event_memberships: [{ user_name: getGlobal().ownerName, user_email: process.env.OWNER_EMAIL || null }],
        uri: `${baseUrl}/bookings/${booking.id}`,
      },
      tracking: {
        utm_campaign: tracking.utm_campaign ?? null,
        utm_source: tracking.utm_source ?? null,
        utm_medium: tracking.utm_medium ?? null,
        utm_content: tracking.utm_content ?? null,
        utm_term: tracking.utm_term ?? null,
      },
    },
  };
}

async function post(url, secret, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'booking-page', ...(secret ? { 'X-Webhook-Secret': secret } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

async function deliver({ url, secret, name }, kind, bookingId, body) {
  const { lastInsertRowid } = db
    .prepare("INSERT INTO webhook_deliveries (booking_id, event, destination, status, created_at) VALUES (?, ?, ?, 'pending', ?)")
    .run(bookingId, kind, name, Date.now());
  const finish = db.prepare('UPDATE webhook_deliveries SET status = ?, attempts = ?, last_error = ? WHERE id = ?');

  let error = '';
  for (let i = 0; i < RETRY_DELAYS.length; i++) {
    if (RETRY_DELAYS[i]) await sleep(RETRY_DELAYS[i]);
    try {
      await post(url, secret, body);
      finish.run('ok', i + 1, '', lastInsertRowid);
      return;
    } catch (err) {
      error = err.message;
      finish.run('pending', i + 1, error, lastInsertRowid);
    }
  }
  finish.run('failed', RETRY_DELAYS.length, error, lastInsertRowid);
  console.error(`[webhook] no se pudo entregar ${kind} (${bookingId}): ${error}`);
  db.prepare('DELETE FROM webhook_deliveries WHERE id <= (SELECT id FROM webhook_deliveries ORDER BY id DESC LIMIT 1 OFFSET 50)').run();
}

// ---------- destinos ----------
// Varios webhooks con nombre; cada tipo de evento elige a cuál va (webhookId) o 'none'.
// «Principal» (id 'main') siempre existe y es el destino de los eventos que no eligieron otro.

export const MAIN_ID = 'main';
const MAX_WEBHOOKS = 10;

export function getWebhooks() {
  const saved = getKv('webhooks');
  if (saved) return JSON.parse(saved);
  // Antes había una sola URL en los ajustes generales: pasa a ser «Principal».
  const { webhookUrl = '', webhookSecret = '' } = getGlobal();
  return [{ id: MAIN_ID, name: 'Principal', url: webhookUrl, secret: webhookSecret }];
}

// El panel nunca recibe los secretos, solo si hay uno guardado.
export const safeWebhooks = () => getWebhooks().map(({ secret, ...w }) => ({ ...w, secretSet: Boolean(secret) }));

function checkUrl(value, name) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (raw.length > 500) throw new SettingsError(`«${name}»: la URL tiene un máximo de 500 caracteres.`);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new SettingsError(`«${name}»: la URL del webhook no es válida.`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new SettingsError(`«${name}»: la URL tiene que empezar con http:// o https://`);
  return url.href;
}

/** input: [{ id?, name, url, secret, clearSecret }]. Un secreto vacío conserva el guardado, salvo clearSecret. */
export function saveWebhooks(input) {
  if (!Array.isArray(input) || !input.length || input.length > MAX_WEBHOOKS) throw new SettingsError(`Puede haber entre 1 y ${MAX_WEBHOOKS} webhooks.`);
  const current = new Map(getWebhooks().map((w) => [w.id, w]));
  const names = new Set();
  const clean = input.map((w) => {
    const id = current.has(w?.id) ? w.id : `w_${crypto.randomBytes(4).toString('hex')}`;
    const name = String(w?.name ?? '').trim();
    if (!name || name.length > 40) throw new SettingsError('Cada webhook necesita un nombre de hasta 40 caracteres.');
    if (names.has(name.toLowerCase())) throw new SettingsError(`Hay dos webhooks llamados «${name}».`);
    names.add(name.toLowerCase());
    const secret = String(w?.secret ?? '').trim();
    if (secret.length > 200) throw new SettingsError(`«${name}»: el secreto tiene un máximo de 200 caracteres.`);
    return { id, name, url: checkUrl(w?.url, name), secret: secret || (w?.clearSecret ? '' : current.get(id)?.secret ?? '') };
  });
  if (!clean.some((w) => w.id === MAIN_ID)) throw new SettingsError('El webhook «Principal» no se puede quitar (podés dejarle la URL vacía).');

  const kept = new Set(clean.map((w) => w.id));
  for (const [id, w] of current) {
    if (kept.has(id)) continue;
    const users = listEvents().filter((e) => e.webhookId === id).map((e) => `«${e.title}»`);
    if (users.length) throw new SettingsError(`No se puede quitar «${w.name}»: lo usa ${users.join(', ')}. Primero cambiá el webhook de ese evento.`);
  }
  setKv('webhooks', JSON.stringify(clean));
  return safeWebhooks();
}

/** Destino de un tipo de evento: null si eligió no enviar o si ese destino no tiene URL. */
export function webhookFor(event) {
  const id = event?.webhookId || MAIN_ID;
  if (id === 'none') return null;
  const hooks = getWebhooks();
  const hook = hooks.find((w) => w.id === id) ?? hooks.find((w) => w.id === MAIN_ID);
  return hook?.url ? hook : null;
}

/** Dispara el webhook del tipo de evento sin bloquear la reserva. Si no corresponde enviar, no hace nada. */
export function emit(kind, booking, options = {}) {
  const event = options.event ?? getEvent(booking.event_type_id);
  const hook = webhookFor(event);
  if (!hook) return;
  deliver(hook, kind, booking.id, buildPayload(kind, booking, { ...options, event })).catch((err) => console.error('[webhook]', err.message));
}

/** Envía un payload de ejemplo (event: "test") a un destino para configurar el trigger de n8n. Devuelve { ok, error }. */
export async function sendTest(baseUrl, id = MAIN_ID) {
  const hook = getWebhooks().find((w) => w.id === id);
  if (!hook?.url) return { ok: false, error: 'Primero guardá la URL de este webhook.' };
  const { ownerName } = getGlobal();
  const start = Date.now() + 86_400_000;
  const sample = {
    id: 'ejemplo', name: 'Ana Ejemplo', email: 'ana@example.com', tz: 'America/Argentina/Buenos_Aires', created_at: Date.now(),
    start_utc: start, end_utc: start + 1_800_000, event_title: 'Evento de prueba', meet_url: 'https://meet.google.com/abc-defg-hij',
    answers: JSON.stringify([{ label: 'WhatsApp', value: '+54 11 5555-5555' }]), tracking: JSON.stringify({ utm_source: 'prueba' }), event_type_id: null,
  };
  const body = buildPayload('invitee.created', sample, { baseUrl, manageUrl: `${baseUrl}/manage?t=ejemplo`, event: { slug: 'ejemplo', location: ownerName } });
  body.event = 'test';
  try {
    await post(hook.url, hook.secret, body);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export const listDeliveries = (limit = 10) =>
  db.prepare('SELECT id, booking_id, event, destination, status, attempts, last_error, created_at FROM webhook_deliveries ORDER BY id DESC LIMIT ?').all(limit).map((d) => ({ ...d }));
