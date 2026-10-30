import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone } from '../src/phone.js';

test('deja los teléfonos como los guarda WhatsApp', () => {
  const casos = {
    '1131462156': '+5491131462156', // sin código de país → Argentina
    '2604043105': '+5492604043105',
    '+54 11 6549-6243': '+5491165496243',
    '+54 9 11 6549-6243': '+5491165496243',
    '011 15 6549-6243': '+5491165496243',
    '+54 11 15 6549-6243': '+5491165496243',
    '260 15 4043105': '+5492604043105',
    '5491165496243': '+5491165496243',
    '+598 99 123-456': '+59899123456',
    '+34 600 000 000': '+34600000000',
    '59899123456': '+59899123456',
  };
  for (const [entrada, salida] of Object.entries(casos)) assert.equal(normalizePhone(entrada), salida, entrada);
});
