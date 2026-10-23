import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SIGNING_SECRET = 'test-secret-de-al-menos-16-caracteres';
const { sign, verify } = await import('../src/tokens.js');

test('firma y verifica', () => {
  const t = sign({ act: 'manage', id: 'abc', exp: Date.now() + 1000 });
  assert.equal(verify(t, 'manage').id, 'abc');
});

test('rechaza token manipulado', () => {
  const t = sign({ act: 'manage', id: 'abc', exp: Date.now() + 1000 });
  const [body, sig] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ act: 'manage', id: 'otro', exp: Date.now() + 1000 })).toString('base64url');
  assert.equal(verify(`${forged}.${sig}`, 'manage'), null);
  assert.equal(verify(`${body}.x${sig}`, 'manage'), null);
});

test('rechaza expirado y acción distinta', () => {
  assert.equal(verify(sign({ act: 'manage', id: 'a', exp: Date.now() - 1 }), 'manage'), null);
  assert.equal(verify(sign({ act: 'oauth', exp: Date.now() + 1000 }), 'manage'), null);
  assert.equal(verify('basura', 'manage'), null);
  assert.equal(verify(undefined, 'manage'), null);
});
