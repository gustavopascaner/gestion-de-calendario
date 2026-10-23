import { $, el, api, fmtLong, applyTheme, reportHeight } from './common.js';
import { mountPicker } from './picker.js';

const info = $('#info');
const stage = $('#stage');
const event = await api('/api/event');

applyTheme(event.accentColor);
document.title = `${event.title} · ${event.ownerName}`;

function renderInfo(chosen) {
  info.replaceChildren(
    ...[
      el('p', { class: 'owner' }, event.ownerName),
      el('h1', {}, event.title),
      el('p', { class: 'meta' }, `${event.slotMinutes} min`),
      event.location && el('p', { class: 'meta' }, event.location),
      chosen && el('p', { class: 'chosen' }, `${fmtLong(chosen.ms, chosen.tz)} (${chosen.tz.replaceAll('_', ' ')})`),
      event.description && el('p', { class: 'desc' }, event.description),
    ].filter(Boolean),
  );
}

function fieldControl(f) {
  const common = { name: f.id, ...(f.required && f.type !== 'checkbox' ? { required: true } : {}) };
  if (f.type === 'textarea') return el('textarea', { ...common, rows: '3', maxlength: '2000', placeholder: f.placeholder || false });
  if (f.type === 'select') {
    return el('select', common, el('option', { value: '' }, 'Elegí una opción…'), ...f.options.map((o) => el('option', { value: o }, o)));
  }
  return el('input', { ...common, type: f.type === 'tel' ? 'tel' : 'text', maxlength: '300', placeholder: f.placeholder || false });
}

function showForm(choice) {
  renderInfo(choice);
  const error = el('p', { class: 'error', role: 'alert' });
  const submit = el('button', { type: 'submit', class: 'primary' }, 'Confirmar reserva');

  const form = el(
    'form',
    {
      class: 'booking',
      onsubmit: async (e) => {
        e.preventDefault();
        error.textContent = '';
        submit.disabled = true;
        const data = new FormData(form);
        const answers = {};
        for (const f of event.fields) answers[f.id] = f.type === 'checkbox' ? form.elements[f.id].checked : data.get(f.id);
        try {
          const { token, redirectUrl } = await api('/api/book', {
            method: 'POST',
            body: { name: data.get('name'), email: data.get('email'), answers, start: choice.ms, tz: choice.tz },
          });
          if (redirectUrl) {
            try { window.top.location.href = redirectUrl; } catch { location.href = redirectUrl; }
          } else {
            location.href = `/confirm?t=${encodeURIComponent(token)}`;
          }
        } catch (err) {
          error.textContent = err.message;
          submit.disabled = false;
          if (err.status === 409) start();
        }
      },
    },
    el('label', {}, el('span', { class: 'req' }, 'Nombre'), el('input', { name: 'name', required: true, maxlength: '100', autocomplete: 'name' })),
    el('label', {}, el('span', { class: 'req' }, 'Email'), el('input', { name: 'email', type: 'email', required: true, maxlength: '200', autocomplete: 'email' })),
    ...event.fields.map((f) =>
      f.type === 'checkbox'
        ? el('label', { class: 'check' }, el('input', { name: f.id, type: 'checkbox' }), el('span', { class: f.required ? 'req' : '' }, f.label))
        : el('label', {}, el('span', { class: f.required ? 'req' : '' }, f.label), fieldControl(f)),
    ),
    error,
    el('div', { class: 'actions' }, submit, el('button', { type: 'button', onclick: () => start() }, 'Volver')),
  );
  stage.replaceChildren(el('h2', {}, 'Ingresá tus datos'), form);
  form.elements.name.focus({ preventScroll: true });
}

function start() {
  renderInfo(null);
  const box = el('div');
  stage.replaceChildren(el('h2', {}, 'Elegí una fecha y hora'), box);
  mountPicker(box, { onSelect: (ms, tz) => showForm({ ms, tz }) });
}

start();
reportHeight();
