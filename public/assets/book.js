import { $, el, api, fmtLong, applyTheme, tzLabel, reportHeight } from './common.js';
import { mountPicker } from './picker.js';
import { initPixel, trackPixel } from './pixel.js';

const card = $('.card');
const info = $('#info');
const stage = $('#stage');

// /book -> lista de eventos (o directo el evento si hay uno solo); /book/<slug> -> ese evento.
const slugFromPath = location.pathname.split('/').filter(Boolean)[1] ?? null;

// Parámetros utm_* del link (p. ej. /book/reunion?utm_source=instagram): viajan con la reserva hasta el webhook.
// Países del selector del teléfono (el primero es el que viene elegido). '' = el número ya trae su +código.
const COUNTRIES = [
  ['54', 'Argentina'], ['598', 'Uruguay'], ['56', 'Chile'], ['595', 'Paraguay'], ['591', 'Bolivia'], ['51', 'Perú'],
  ['57', 'Colombia'], ['593', 'Ecuador'], ['58', 'Venezuela'], ['52', 'México'], ['55', 'Brasil'], ['34', 'España'],
  ['1', 'EE. UU./Canadá'], ['', 'Otro (escribí +código)'],
];
const tracking = Object.fromEntries([...new URLSearchParams(location.search)].filter(([key]) => key.startsWith('utm_')));

function showMessage(text) {
  card.classList.add('single');
  info.hidden = true;
  stage.replaceChildren(el('p', { class: 'error' }, text));
}

function showList(ownerName, events) {
  card.classList.add('single');
  info.hidden = true;
  document.title = ownerName;
  stage.replaceChildren(
    el('h1', {}, ownerName),
    el('p', { class: 'muted' }, 'Elegí el tipo de reunión que querés agendar.'),
    ...events.map((e) => {
      const row = el(
        'a',
        { class: 'eventrow', href: `/book/${e.slug}` },
        el('strong', {}, e.title),
        el('span', { class: 'muted' }, `${e.slotMinutes} min${e.location ? ` · ${e.location}` : ''}`),
        e.description ? el('span', { class: 'desc' }, e.description) : null,
      );
      row.style.borderLeftColor = e.accentColor; // CSSOM: permitido por la CSP
      return row;
    }),
  );
}

async function showEvent(slug) {
  let event;
  try {
    event = await api(`/api/event?slug=${encodeURIComponent(slug)}`);
  } catch (err) {
    return showMessage(err.message);
  }
  applyTheme(event.accentColor);
  document.title = `${event.title} · ${event.ownerName}`;
  if (event.pixel) initPixel(event.pixel.id);

  let choice = null; // { ms, tz } del horario elegido
  let draft = {}; // lo que el visitante ya escribió, para no perderlo al ir y venir entre pasos

  const steps = el('ol', { class: 'steps' });
  const pickerBox = el('div');
  const formBox = el('div', { hidden: true });
  stage.replaceChildren(steps, pickerBox, formBox);

  function renderInfo() {
    const header = event.showHeader !== false;
    info.replaceChildren(
      ...[
        header && el('p', { class: 'owner' }, event.ownerName),
        header && el('h1', {}, event.title),
        header && el('p', { class: 'meta' }, `${event.slotMinutes} min`),
        header && event.location && el('p', { class: 'meta' }, event.location),
        choice && el('p', { class: 'chosen' }, `${fmtLong(choice.ms, choice.tz)} · ${tzLabel(choice.tz)}`),
        event.description && el('p', { class: 'desc' }, event.description),
      ].filter(Boolean),
    );
    // Sin encabezado ni nada que mostrar, el panel izquierdo desaparece y el calendario ocupa todo el ancho.
    info.hidden = !info.children.length;
    card.classList.toggle('single', info.hidden);
  }

  function renderSteps(active) {
    const step = (n, label, onclick, disabled = false) =>
      el('li', { class: active === n ? 'on' : active > n ? 'done' : '' },
        el('button', { type: 'button', disabled, onclick, 'aria-current': active === n ? 'step' : false }, el('span', { class: 'n' }, String(n)), label));
    steps.replaceChildren(step(1, 'Fecha y hora', goPick), step(2, 'Tus datos', goForm, !choice));
  }

  const toTop = () => {
    if (matchMedia('(max-width: 720px)').matches) stage.scrollIntoView({ block: 'start' });
  };

  function goPick() {
    pickerBox.hidden = false;
    formBox.hidden = true;
    renderInfo();
    renderSteps(1);
    toTop();
  }

  function goForm() {
    if (!choice) return;
    pickerBox.hidden = true;
    formBox.hidden = false;
    renderInfo();
    renderSteps(2);
    toTop();
    formBox.querySelector('input[name=name]')?.focus({ preventScroll: true });
  }

  function fieldControl(f) {
    const common = { name: f.id, ...(f.required && f.type !== 'checkbox' ? { required: true } : {}) };
    if (f.type === 'textarea') return el('textarea', { ...common, rows: '3', maxlength: '2000', placeholder: f.placeholder || false });
    if (f.type === 'select') {
      return el('select', common, el('option', { value: '' }, 'Elegí una opción…'), ...f.options.map((o) => el('option', { value: o }, o)));
    }
    if (f.type === 'tel') {
      return el(
        'div',
        { class: 'phone' },
        el('select', { name: `${f.id}__cc`, 'aria-label': 'País', autocomplete: 'tel-country-code' }, ...COUNTRIES.map(([cc, name]) => el('option', { value: cc }, cc ? `${name} +${cc}` : name))),
        el('input', { ...common, type: 'tel', inputmode: 'tel', autocomplete: 'tel-national', pattern: '\\+?[0-9 ()\\-.]{6,25}', title: 'Código de área y número, por ejemplo 11 2345-6789', maxlength: '300', placeholder: f.placeholder || '11 2345-6789' }),
      );
    }
    return el('input', { ...common, type: 'text', maxlength: '300', placeholder: f.placeholder || false });
  }

  // Une el país elegido con el número: "54" + "011 15 2345-6789" → "+54 11 15 2345-6789" (el servidor quita el 0 y el 15).
  function phoneValue(form, f) {
    const number = String(form.elements[f.id].value).trim();
    const cc = form.elements[`${f.id}__cc`].value;
    if (!number || number.startsWith('+') || !cc) return number;
    return `+${cc} ${number.replace(/^0+/, '')}`;
  }

  function buildForm() {
    const error = el('p', { class: 'error', role: 'alert' });
    const submit = el('button', { type: 'submit', class: 'primary' }, 'Confirmar reserva');
    const names = ['name', 'email', ...event.fields.flatMap((f) => (f.type === 'tel' ? [`${f.id}__cc`, f.id] : [f.id]))];

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
          for (const f of event.fields) answers[f.id] = f.type === 'checkbox' ? form.elements[f.id].checked : f.type === 'tel' ? phoneValue(form, f) : data.get(f.id);
          try {
            const { token, redirectUrl } = await api('/api/book', {
              method: 'POST',
              body: { slug, name: data.get('name'), email: data.get('email'), answers, tracking, start: choice.ms, tz: choice.tz },
            });
            if (event.pixel) await trackPixel(event.pixel.event, { content_name: event.title });
            if (redirectUrl) {
              try { window.top.location.href = redirectUrl; } catch { location.href = redirectUrl; }
            } else {
              location.href = `/confirm?t=${encodeURIComponent(token)}`;
            }
          } catch (err) {
            error.textContent = err.message;
            submit.disabled = false;
            if (err.status === 409) { // el horario se ocupó: volver a elegir
              choice = null;
              formBox.replaceChildren();
              picker.reload();
              goPick();
            }
          }
        },
        oninput: () => saveDraft(),
        onchange: () => saveDraft(),
      },
      el('label', {}, el('span', { class: 'req' }, 'Nombre'), el('input', { name: 'name', required: true, maxlength: '100', autocomplete: 'name' })),
      el('label', {}, el('span', { class: 'req' }, 'Email'), el('input', { name: 'email', type: 'email', required: true, maxlength: '200', autocomplete: 'email' })),
      ...event.fields.map((f) =>
        f.type === 'checkbox'
          ? el('label', { class: 'check' }, el('input', { name: f.id, type: 'checkbox' }), el('span', { class: f.required ? 'req' : '' }, f.label))
          : el('label', {}, el('span', { class: f.required ? 'req' : '' }, f.label), fieldControl(f)),
      ),
      error,
      el('div', { class: 'actions' }, submit),
    );

    function saveDraft() {
      for (const name of names) {
        const input = form.elements[name];
        draft[name] = input.type === 'checkbox' ? input.checked : input.value;
      }
    }
    for (const name of names) {
      if (!(name in draft)) continue;
      const input = form.elements[name];
      if (input.type === 'checkbox') input.checked = draft[name];
      else input.value = draft[name];
    }
    return form;
  }

  const picker = await mountPicker(pickerBox, {
    slug,
    onSelect: (ms, tz) => {
      choice = { ms, tz };
      formBox.replaceChildren(
        el('h2', {}, 'Ingresá tus datos'),
        el('p', { class: 'summary' }, `${fmtLong(ms, tz)} · ${tzLabel(tz)}`),
        buildForm(),
      );
      goForm();
    },
  });

  goPick();
}

async function main() {
  const { ownerName, events } = await api('/api/events');
  if (slugFromPath) await showEvent(slugFromPath);
  else if (events.length === 0) showMessage('Por ahora no hay eventos disponibles para reservar.');
  else if (events.length === 1) await showEvent(events[0].slug);
  else showList(ownerName, events);
  reportHeight();
}

main().catch((err) => showMessage(err.message));
