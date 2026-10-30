import { parsePhoneNumberFromString } from 'libphonenumber-js/max';

// Teléfonos en formato internacional compacto, como los guarda WhatsApp/Chatwoot:
//   +54 11 6549-6243 / 11 15 6549-6243 / 011 6549-6243 / 1165496243 → +5491165496243
//   +598 99 123-456 → +59899123456
// Sin código de país (10 dígitos o empieza con 0) se asume Argentina.
// Antes se valida con libphonenumber (lo mismo que usa el formulario con intl-tel-input).
// El flujo de n8n «Recordatorio llamada (reservas propias)» usa la misma lógica.

// Posición del 15 en un número nacional de 12 dígitos (área + 15 + abonado), o 0.
function pos15(n) {
  if (n.length !== 12) return 0;
  const corte = n.startsWith('11') ? [2] : [3, 4];
  return corte.find((k) => n.slice(k, k + 2) === '15') || 0;
}

function nacionalAR(n) {
  n = n.replace(/^0/, '');
  const i = pos15(n);
  return i ? n.slice(0, i) + n.slice(i + 2) : n;
}

export function normalizePhone(text) {
  const raw = String(text).trim();
  let n = raw.replace(/\D/g, '');
  if (raw.startsWith('+') || n.startsWith('00')) {
    n = n.replace(/^00/, '');
    if (!n.startsWith('54')) return '+' + n;
    n = n.slice(2).replace(/^9/, '');
  } else if (n.startsWith('549') && n.length >= 12) {
    n = n.slice(3);
  } else if (n.startsWith('54') && n.length >= 12) {
    n = n.slice(2);
  } else if (n.length > 10 && !n.startsWith('0') && !pos15(n)) {
    return '+' + n; // ya trae otro código de país
  }
  return '+549' + nacionalAR(n);
}

// Número válido normalizado, o null si no es un teléfono real. Sin + se asume Argentina.
export function parsePhone(text) {
  const raw = String(text).trim();
  if (!/^\+?[0-9 ()\-.]{6,30}$/.test(raw)) return null;
  const phone = parsePhoneNumberFromString(raw, 'AR');
  return phone?.isValid() ? normalizePhone(phone.number) : null;
}
