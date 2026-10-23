// Test de punta a punta: levanta el servidor real (con una base temporal) y recorre el flujo completo
// como lo haría un visitante y como lo haría el panel: reservar, reprogramar, cancelar, ABM, webhook.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const PORT = 3400 + Math.floor(Math.random() * 400);
const HOOK_PORT = PORT + 500;
const BASE = `http://localhost:${PORT}`;
const ADMIN_PASSWORD = 'e2e-admin-pass';
const JSON_HEADERS = { 'content-type': 'application/json' };

let server;
let hook;
let cookie = '';
const received = [];

const api = async (route, { method = 'GET', body, admin = false, headers = {} } = {}) => {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: { ...(body ? JSON_HEADERS : {}), ...(admin ? { cookie } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* respuesta no JSON */ }
  return { status: res.status, data, text, headers: res.headers };
};

const waitFor = async (predicate, ms = 4000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

before(async () => {
  hook = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => { received.push({ body: JSON.parse(raw), secret: req.headers['x-webhook-secret'] }); res.end('ok'); });
  });
  await new Promise((r) => hook.listen(HOOK_PORT, r));

  server = spawn(process.execPath, ['src/server.js'], {
    env: {
      PATH: process.env.PATH,
      PORT: String(PORT),
      BASE_URL: BASE,
      SIGNING_SECRET: 'e2e-signing-secret-1234567890',
      ADMIN_SECRET: ADMIN_PASSWORD,
      DB_PATH: path.join(os.tmpdir(), `e2e-${process.pid}-${Date.now()}.db`),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stderr.on('data', (d) => { log += d; });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => { log += d; if (log.includes('SMTP:')) resolve(); });
    server.on('exit', (code) => reject(new Error(`el servidor terminó (${code}): ${log}`)));
    setTimeout(() => reject(new Error(`el servidor no arrancó: ${log}`)), 8000);
  });
});

after(() => {
  server?.kill();
  hook?.close();
});

test('páginas públicas y rutas inexistentes', async () => {
  for (const route of ['/book', '/book/reunion', '/manage', '/confirm', '/admin', '/embed-example', '/assets/book.js', '/assets/style.css']) {
    assert.equal((await api(route)).status, 200, route);
  }
  assert.equal((await api('/nada')).status, 404);
  assert.equal((await api('/assets/../src/server.js')).status, 404);
  assert.equal((await api('/api/event?slug=no-existe')).status, 404);
});

test('el panel exige login y rechaza contraseñas incorrectas', async () => {
  assert.equal((await api('/api/admin/settings')).status, 401);
  assert.equal((await api('/api/admin/login', { method: 'POST', body: { password: 'mal' } })).status, 401);
  const ok = await api('/api/admin/login', { method: 'POST', body: { password: ADMIN_PASSWORD } });
  assert.equal(ok.status, 200);
  cookie = ok.headers.get('set-cookie').split(';')[0];
  assert.equal((await api('/api/admin/settings', { admin: true })).status, 200);
});

test('ABM de eventos desde el panel', async () => {
  const created = await api('/api/admin/events', {
    method: 'POST',
    admin: true,
    body: {
      title: 'Llamada corta', slotMinutes: 15, bufferMinutes: 0, minNoticeHours: 0, horizonDays: 14, accentColor: '#059669',
      weekly: { mon: [['09:00', '18:00']], tue: [['09:00', '18:00']], wed: [['09:00', '18:00']], thu: [['09:00', '18:00']], fri: [['09:00', '18:00']], sat: [['09:00', '18:00']], sun: [['09:00', '18:00']] },
      fields: [{ label: 'WhatsApp', type: 'tel', required: true }],
    },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.event.slug, 'llamada-corta');

  const copy = await api('/api/admin/events', { method: 'POST', admin: true, body: { duplicateOf: created.data.event.id } });
  assert.equal(copy.data.event.title, 'Llamada corta (copia)');
  assert.equal((await api(`/api/admin/events/${copy.data.event.id}`, { method: 'DELETE', admin: true })).status, 200);

  const list = await api('/api/events');
  assert.deepEqual(list.data.events.map((e) => e.slug), ['reunion', 'llamada-corta']);
  const invalid = await api('/api/admin/events', { method: 'POST', admin: true, body: { title: '', accentColor: 'x' } });
  assert.equal(invalid.status, 400);
});

test('webhook: configurar y recibir la prueba', async () => {
  const saved = await api('/api/admin/global', {
    method: 'PUT',
    admin: true,
    body: { ownerName: 'Gus', timezone: 'America/Argentina/Buenos_Aires', webhookUrl: `http://localhost:${HOOK_PORT}/hook`, webhookSecret: 'secreto-e2e' },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.global.webhookSecretSet, true);
  assert.equal(saved.data.global.webhookSecret, undefined); // el secreto nunca vuelve al navegador
  assert.equal((await api('/api/admin/webhook/test', { method: 'POST', admin: true, body: {} })).data.ok, true);
  assert.ok(await waitFor(() => received.some((r) => r.body.event === 'test')));
  assert.equal(received.find((r) => r.body.event === 'test').secret, 'secreto-e2e');
});

test('flujo completo: reservar → agenda compartida → reprogramar → cancelar', async () => {
  received.length = 0;
  const slots = (await api('/api/slots?slug=llamada-corta')).data.slots;
  assert.ok(slots.length > 10, 'debería haber horarios disponibles');
  const start = slots[0];

  const fieldId = (await api('/api/event?slug=llamada-corta')).data.fields[0].id;

  // validaciones
  assert.equal((await api('/api/book', { method: 'POST', body: { slug: 'llamada-corta', name: 'Ana', email: 'ana@example.com', start, answers: {} } })).status, 400); // falta el WhatsApp obligatorio
  assert.equal((await api('/api/book', { method: 'POST', body: { slug: 'llamada-corta', name: 'Ana', email: 'no-es-email', start, answers: { [fieldId]: '1' } } })).status, 400);
  assert.equal((await api('/api/book', { method: 'POST', body: { slug: 'llamada-corta', name: 'Ana', email: 'ana@example.com', start: start + 1000, answers: { [fieldId]: '1' } } })).status, 409); // horario que no existe

  const booked = await api('/api/book', {
    method: 'POST',
    body: {
      slug: 'llamada-corta', name: 'Ana Pérez', email: 'ana@example.com', start, tz: 'Europe/Madrid',
      answers: { [fieldId]: '+34 600 000 000' }, tracking: { utm_source: 'instagram', basura: 'x' },
    },
  });
  assert.equal(booked.status, 201);
  const token = booked.data.token;

  // la reserva se guarda en la zona horaria del visitante y la ve con su token
  const view = (await api(`/api/booking?t=${token}`)).data;
  assert.equal(view.tz, 'Europe/Madrid');
  assert.equal(view.status, 'confirmed');
  assert.equal(view.end - view.start, 15 * 60_000);
  assert.deepEqual(view.answers.map((a) => a.value), ['+34 600 000 000']);

  // no se puede reservar dos veces el mismo horario, y la agenda se comparte entre eventos
  assert.equal((await api('/api/book', { method: 'POST', body: { slug: 'llamada-corta', name: 'Bob', email: 'bob@example.com', start, answers: { [fieldId]: '1' } } })).status, 409);
  const other = (await api('/api/slots?slug=reunion')).data.slots;
  assert.ok(!other.some((s) => s < start + 15 * 60_000 && s + 30 * 60_000 > start), 'el otro evento debería bloquear ese horario');

  // reprogramar
  const target = slots.find((s) => s > start + 3 * 3_600_000);
  assert.equal((await api('/api/reschedule', { method: 'POST', body: { t: token, start: target } })).status, 200);
  assert.equal((await api(`/api/booking?t=${token}`)).data.start, target);
  assert.ok((await api('/api/slots?slug=llamada-corta')).data.slots.includes(start), 'el horario viejo vuelve a estar libre');

  // cancelar
  assert.equal((await api('/api/cancel', { method: 'POST', body: { t: token } })).status, 200);
  assert.equal((await api(`/api/booking?t=${token}`)).data.status, 'cancelled');
  assert.equal((await api('/api/cancel', { method: 'POST', body: { t: token } })).status, 409);
  assert.ok((await api('/api/slots?slug=llamada-corta')).data.slots.includes(target), 'el horario cancelado vuelve a estar libre');

  // links inválidos o manipulados
  assert.equal((await api('/api/booking?t=abc.def')).status, 404);
  assert.equal((await api(`/api/booking?t=${token.slice(0, -2)}xx`)).status, 404);

  // webhook: creada → reprogramada → cancelada, con el secreto y el payload esperado
  assert.ok(await waitFor(() => received.length >= 3), `llegaron ${received.length} eventos`);
  assert.deepEqual(received.map((r) => r.body.event), ['invitee.created', 'invitee.rescheduled', 'invitee.canceled']);
  const created = received[0].body.payload;
  assert.equal(created.email, 'ana@example.com');
  assert.equal(created.timezone, 'Europe/Madrid');
  assert.equal(created.scheduled_event.start_time, new Date(start).toISOString());
  assert.equal(created.tracking.utm_source, 'instagram');
  assert.deepEqual(created.questions_and_answers, [{ question: 'WhatsApp', answer: '+34 600 000 000', position: 0 }]);
  assert.equal(received[1].body.payload.old_start_time, new Date(start).toISOString());
  assert.ok(received.every((r) => r.secret === 'secreto-e2e'));
});

test('inicio del panel: estadísticas y borrado protegido', async () => {
  const stats = (await api('/api/admin/stats', { admin: true })).data;
  assert.equal(stats.upcoming, 0); // la única reserva quedó cancelada
  assert.equal(stats.activeEvents, 2);
  assert.ok(Array.isArray(stats.next) && Array.isArray(stats.byEvent));

  // un evento con reservas (aunque estén canceladas) no se puede borrar
  const events = (await api('/api/admin/settings', { admin: true })).data.events;
  const shortId = events.find((e) => e.slug === 'llamada-corta').id;
  assert.equal((await api(`/api/admin/events/${shortId}`, { method: 'DELETE', admin: true })).status, 400);
});
