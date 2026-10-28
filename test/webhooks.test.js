import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(os.tmpdir(), `webhooks-test-${process.pid}-${Date.now()}.db`);
const { buildPayload, getWebhooks, saveWebhooks, webhookFor } = await import('../src/webhooks.js');
const { SettingsError } = await import('../src/settings.js');
const { setKv } = await import('../src/db.js');
// Formato viejo: una sola URL en los ajustes generales (antes de que se lean y queden en caché).
setKv('global', JSON.stringify({ ownerName: 'Gus', timezone: 'UTC', webhookUrl: 'https://viejo.example.com/hook', webhookSecret: 's' }));

const booking = {
  id: 'abc', name: 'Sebastián Man Pérez', email: 'seba@example.com', tz: 'America/Argentina/Buenos_Aires', created_at: Date.UTC(2026, 9, 23),
  start_utc: Date.UTC(2026, 9, 29, 13), end_utc: Date.UTC(2026, 9, 29, 13, 45), event_title: 'Videollamada', meet_url: 'https://meet.google.com/x',
  answers: JSON.stringify([{ id: 'a', label: 'WhatsApp', value: '+54 11 4414-7383' }]), tracking: JSON.stringify({ utm_source: 'instagram' }),
};
const event = { slug: 'videollamada', location: 'Google Meet' };

test('payload con forma de Calendly: event + payload', () => {
  const p = buildPayload('invitee.created', booking, { baseUrl: 'https://r.example.com', manageUrl: 'https://r.example.com/manage?t=1', event });
  assert.equal(p.event, 'invitee.created');
  assert.equal(p.payload.email, 'seba@example.com');
  assert.equal(p.payload.first_name, 'Sebastián');
  assert.equal(p.payload.last_name, 'Man Pérez');
  assert.deepEqual(p.payload.questions_and_answers, [{ question: 'WhatsApp', answer: '+54 11 4414-7383', position: 0 }]);
  assert.equal(p.payload.scheduled_event.start_time, '2026-10-29T13:00:00.000Z');
  assert.equal(p.payload.scheduled_event.end_time, '2026-10-29T13:45:00.000Z');
  assert.equal(p.payload.scheduled_event.location.join_url, 'https://meet.google.com/x');
  assert.equal(p.payload.scheduled_event.event_type, 'https://r.example.com/book/videollamada');
  assert.equal(p.payload.tracking.utm_source, 'instagram');
  assert.equal(p.payload.tracking.utm_medium, null);
  assert.equal(p.payload.cancel_url, 'https://r.example.com/manage?t=1');
});

test('cancelación y reprogramación', () => {
  const c = buildPayload('invitee.canceled', booking, { baseUrl: 'https://r.example.com', event });
  assert.equal(c.payload.status, 'canceled');
  assert.equal(c.payload.cancel_url, null);
  const r = buildPayload('invitee.rescheduled', booking, { baseUrl: 'https://r.example.com', previousStart: Date.UTC(2026, 9, 28, 13), event });
  assert.equal(r.payload.rescheduled, true);
  assert.equal(r.payload.old_start_time, '2026-10-28T13:00:00.000Z');
});

test('valida los webhooks y migra la URL vieja a «Principal»', () => {
  assert.deepEqual(getWebhooks(), [{ id: 'main', name: 'Principal', url: 'https://viejo.example.com/hook', secret: 's' }]);

  const main = { id: 'main', name: 'Principal', url: '' };
  assert.equal(saveWebhooks([{ ...main, url: 'https://n8n.example.com/webhook/abc' }])[0].url, 'https://n8n.example.com/webhook/abc');
  assert.equal(getWebhooks()[0].secret, 's'); // un secreto vacío conserva el guardado
  assert.throws(() => saveWebhooks([{ ...main, url: 'ftp://x' }]), SettingsError);
  assert.throws(() => saveWebhooks([{ ...main, url: 'no es url' }]), SettingsError);
  assert.throws(() => saveWebhooks([{ ...main }, { name: 'principal', url: '' }]), SettingsError); // nombre repetido
  assert.throws(() => saveWebhooks([{ name: 'Otro', url: '' }]), SettingsError); // sin Principal
});

test('cada evento elige su destino', () => {
  const [main, other] = saveWebhooks([
    { id: 'main', name: 'Principal', url: 'https://a.example.com/' },
    { name: 'Otro', url: 'https://b.example.com/' },
  ]);
  assert.equal(webhookFor({}).url, 'https://a.example.com/'); // eventos viejos sin webhookId
  assert.equal(webhookFor({ webhookId: other.id }).url, 'https://b.example.com/');
  assert.equal(webhookFor({ webhookId: 'none' }), null);
  assert.equal(webhookFor({ webhookId: 'w_borrado' }).id, main.id);
  saveWebhooks([{ ...main, url: '' }, other]);
  assert.equal(webhookFor({}), null); // Principal sin URL: no se envía
});
