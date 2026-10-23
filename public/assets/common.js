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
  const send = () => window.parent.postMessage({ type: 'booking:height', height: document.documentElement.scrollHeight }, '*');
  new ResizeObserver(send).observe(document.body);
  send();
}
