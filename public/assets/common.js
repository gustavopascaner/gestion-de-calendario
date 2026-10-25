export const $ = (sel, root = document) => root.querySelector(sel);

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
  }
  node.append(...children.filter((c) => c != null));
  return node;
}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Ocurrió un error inesperado.'), { status: res.status });
  return data;
}

export const detectTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const fmt = (opts) => (ms, tz) => new Intl.DateTimeFormat('es', { timeZone: tz, ...opts }).format(ms);
export const fmtTime = fmt({ hour: '2-digit', minute: '2-digit', hour12: false });
export const fmtDayShort = fmt({ weekday: 'short', day: 'numeric', month: 'short' });
export const fmtLong = fmt({ weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hour12: false });

export const dayKey = (ms, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);

// Si la página está dentro de un iframe, avisa a la landing su altura para que pueda ajustarlo.
export function reportHeight() {
  if (window.parent === window) return;
  document.documentElement.classList.add('embedded');
  const send = () => window.parent.postMessage({ type: 'booking:height', height: document.documentElement.scrollHeight }, '*');
  new ResizeObserver(send).observe(document.body);
  send();
}

export const fmtDayLong = fmt({ weekday: 'long', day: 'numeric', month: 'long' });
export const fmtMonth = (year, month) => new Intl.DateTimeFormat('es', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(Date.UTC(year, month - 1, 1));

// Aplica el color de acento configurado (CSSOM: permitido por la CSP, a diferencia de style="").
export function applyTheme(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex ?? '')) return;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const light = (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6;
  document.documentElement.style.setProperty('--accent', hex);
  document.documentElement.style.setProperty('--accent-fg', light ? '#111111' : '#ffffff');
}

// "Salta (GMT-3)": nombre corto y legible de una zona horaria IANA, con su desfase actual.
export function tzLabel(tz) {
  const offset = new Intl.DateTimeFormat('es', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(Date.now()).find((p) => p.type === 'timeZoneName')?.value ?? '';
  return `${tz.split('/').pop().replaceAll('_', ' ')} (${offset})`;
}
