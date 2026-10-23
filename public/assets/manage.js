import { $, el, api, fmtLong, applyTheme, reportHeight } from './common.js';
import { mountPicker } from './picker.js';

const root = $('#content');
const token = new URLSearchParams(location.search).get('t') ?? '';
const justBooked = location.pathname === '/confirm';

async function render() {
  let b;
  try {
    b = await api(`/api/booking?t=${encodeURIComponent(token)}`);
  } catch (err) {
    root.replaceChildren(el('h1', {}, 'Link no válido'), el('p', { class: 'error' }, err.message));
    return;
  }

  applyTheme(b.accentColor);
  const when = `${fmtLong(b.start, b.tz)} (${b.tz.replaceAll('_', ' ')})`;
  const active = b.status === 'confirmed' && b.start > Date.now();
  const heading = b.status === 'cancelled' ? 'Reserva cancelada' : justBooked ? '¡Reserva confirmada!' : 'Tu reserva';

  const details = el(
    'dl',
    { class: 'details' },
    el('dt', {}, 'Reunión'), el('dd', {}, `${b.title} con ${b.ownerName}`),
    el('dt', {}, 'Cuándo'), el('dd', {}, when),
    el('dt', {}, 'Invitado'), el('dd', {}, `${b.name} · ${b.email}`),
    ...(b.location && b.status === 'confirmed' && !b.meetUrl ? [el('dt', {}, 'Dónde'), el('dd', {}, b.location)] : []),
    ...(b.meetUrl && b.status === 'confirmed' ? [el('dt', {}, 'Google Meet'), el('dd', {}, el('a', { href: b.meetUrl, target: '_blank', rel: 'noopener' }, b.meetUrl))] : []),
    ...b.answers.flatMap((a) => [el('dt', {}, a.label), el('dd', {}, a.value)]),
  );

  const status = el(
    'div',
    {},
    justBooked && active ? el('p', { class: 'muted' }, 'Te enviamos un email con los detalles y el link para cancelar o reprogramar.') : null,
    justBooked && active && b.confirmationMessage ? el('p', { class: 'notice' }, b.confirmationMessage) : null,
  );
  const message = el('p', { role: 'alert' });
  const actions = el('div', { class: 'actions' });

  if (active) {
    actions.append(
      el('button', { type: 'button', onclick: () => reschedule(b) }, 'Reprogramar'),
      el('button', { type: 'button', class: 'danger', onclick: (e) => confirmCancel(e.target, message) }, 'Cancelar reserva'),
    );
  }
  root.replaceChildren(el('h1', {}, heading), details, status, actions, message, el('div', { id: 'resched' }));
}

function confirmCancel(button, message) {
  button.textContent = 'Sí, cancelar definitivamente';
  button.onclick = async () => {
    button.disabled = true;
    try {
      await api('/api/cancel', { method: 'POST', body: { t: token } });
      await render();
    } catch (err) {
      message.className = 'error';
      message.textContent = err.message;
      button.disabled = false;
    }
  };
}

async function reschedule(b) {
  const box = $('#resched');
  box.replaceChildren(el('h2', {}, 'Elegí un nuevo horario'), el('div', { id: 'picker' }), el('div', { id: 'confirm-new' }));
  await mountPicker($('#picker', box), {
    slug: b.slug,
    onSelect: (ms, tz) => {
      const error = el('p', { class: 'error', role: 'alert' });
      const button = el('button', { type: 'button', class: 'primary' }, 'Confirmar nuevo horario');
      button.onclick = async () => {
        button.disabled = true;
        try {
          await api('/api/reschedule', { method: 'POST', body: { t: token, start: ms } });
          await render();
        } catch (err) {
          error.textContent = err.message;
          button.disabled = false;
          if (err.status === 409) reschedule(b);
        }
      };
      $('#confirm-new', box).replaceChildren(el('p', { class: 'summary' }, `${fmtLong(ms, tz)} (${tz.replaceAll('_', ' ')})`), error, button);
    },
  });
}

await render();
reportHeight();
