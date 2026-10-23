import crypto from 'node:crypto';

const b64 = (s) => Buffer.from(s).toString('base64url');

function secret() {
  const s = process.env.SIGNING_SECRET;
  if (!s || s.length < 16) throw new Error('SIGNING_SECRET debe estar definido en .env (mínimo 16 caracteres)');
  return s;
}

const mac = (data) => crypto.createHmac('sha256', secret()).update(data).digest('base64url');

// payload: { act, exp (ms epoch), ...datos }
export function sign(payload) {
  const body = b64(JSON.stringify(payload));
  return `${body}.${mac(body)}`;
}

export function verify(token, act, now = Date.now()) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const given = Buffer.from(parts[1]);
  const expected = Buffer.from(mac(parts[0]));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
  } catch {
    return null;
  }
  if (payload.act !== act || typeof payload.exp !== 'number' || payload.exp < now) return null;
  return payload;
}
