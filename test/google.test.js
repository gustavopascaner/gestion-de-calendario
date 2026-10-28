import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(os.tmpdir(), `google-test-${process.pid}-${Date.now()}.db`);
Object.assign(process.env, { GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret', GOOGLE_REDIRECT_URI: 'http://localhost/cb' });
const { setKv } = await import('../src/db.js');
const { eventStates } = await import('../src/google.js');
setKv('google_refresh_token', 'refresh');

// Google falso: token OAuth + un evento por id con el status HTTP que se le pida.
function fakeGoogle(events) {
  globalThis.fetch = async (url) => {
    if (String(url).startsWith('https://oauth2.googleapis.com/token')) return Response.json({ access_token: 'tok', expires_in: 3600 });
    const id = decodeURIComponent(String(url).split('/events/')[1]);
    const [status, body] = events[id];
    return Response.json(body, { status });
  };
}

test('lee de Google si el evento sigue, se borró, se movió o el invitado lo rechazó', async () => {
  fakeGoogle({
    vivo: [200, { id: 'vivo', status: 'confirmed', start: { dateTime: '2026-10-29T13:00:00Z' }, end: { dateTime: '2026-10-29T13:45:00Z' } }],
    rechazado: [200, {
      id: 'rechazado', status: 'confirmed',
      start: { dateTime: '2026-10-29T10:00:00-03:00' }, end: { dateTime: '2026-10-29T10:45:00-03:00' },
      attendees: [{ email: 'Gus@example.com', responseStatus: 'accepted' }, { email: 'Seba@Example.com', responseStatus: 'declined' }],
    }],
    diaCompleto: [200, { id: 'diaCompleto', status: 'confirmed', start: { date: '2026-10-29' }, end: { date: '2026-10-30' } }],
    papelera: [200, { id: 'papelera', status: 'cancelled' }],
    borrado: [404, { error: { code: 404 } }],
    eliminado: [410, { error: { code: 410 } }],
  });
  const s = await eventStates(['vivo', 'rechazado', 'diaCompleto', 'papelera', 'borrado', 'eliminado']);
  assert.deepEqual(s.get('vivo'), { start: Date.UTC(2026, 9, 29, 13), end: Date.UTC(2026, 9, 29, 13, 45), declined: [] });
  assert.deepEqual(s.get('rechazado'), { start: Date.UTC(2026, 9, 29, 13), end: Date.UTC(2026, 9, 29, 13, 45), declined: ['seba@example.com'] });
  assert.deepEqual(s.get('diaCompleto'), { start: null, end: null, declined: [] });
  for (const id of ['papelera', 'borrado', 'eliminado']) assert.equal(s.get(id), null);
});

test('ante un error de Google no da nada por cancelado', async () => {
  fakeGoogle({ vivo: [200, { id: 'vivo', status: 'confirmed' }], roto: [500, { error: { code: 500 } }] });
  await assert.rejects(eventStates(['vivo', 'roto']), /500/);
});
