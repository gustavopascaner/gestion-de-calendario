import { $, el, api, fmtLong, applyTheme, tzLabel, reportHeight } from './common.js';
import { mountPicker } from './picker.js';
import { initPixel, trackPixel } from './pixel.js';
import es from './vendor/intl-tel-input/js/es.js';

const card = $('.card');
const info = $('#info');
const stage = $('#stage');

// /book -> lista de eventos (o directo el evento si hay uno solo); /book/<slug> -> ese evento.
const slugFromPath = location.pathname.split('/').filter(Boolean)[1] ?? null;

// Parámetros utm_* del link (p. ej. /book/reunion?utm_source=instagram): viajan con la reserva hasta el webhook.
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
    if (f.type === 'tel') return phoneControl(f);
    if (f.type === 'textarea') return el('textarea', { ...common, rows: '3', maxlength: '2000', placeholder: f.placeholder || false });
    if (f.type === 'select') {
      return el('select', common, el('option', { value: '' }, 'Elegí una opción…'), ...f.options.map((o) => el('option', { value: o }, o)));
    }
    return el('input', { ...common, type: 'text', maxlength: '300', placeholder: f.placeholder || false });
  }

  // Teléfono como el de Calendly: bandera con buscador, código del país fijo al lado, formato mientras se escribe
  // y validación con libphonenumber (intl-tel-input, cargado en book.html). Devuelve el número en formato +54….
  const phones = new Map();
  const PHONE_ERRORS = { INVALID_COUNTRY_CODE: 'Elegí el país del número.', TOO_SHORT: 'Al número le faltan dígitos.', IS_POSSIBLE_LOCAL_ONLY: 'Agregá el código de área (por ejemplo 11).', TOO_LONG: 'El número tiene dígitos de más.' };

  function phoneControl(f) {
    const input = el('input', { name: f.id, id: `f-${f.id}`, type: 'tel', autocomplete: 'tel', maxlength: '30', ...(f.required ? { required: true } : {}) });
    const box = el('div', { class: 'phone' }, input);
    const iti = window.intlTelInput(input, {
      initialCountry: 'ar',
      countryOrder: ['ar', 'uy', 'cl', 'py', 'bo', 'pe', 'co', 'ec', 've', 'mx', 'br', 'es', 'us'],
      separateDialCode: true,
      countrySearch: true,
      countryNameLocale: 'es',
      uiTranslations: es,
      // En Argentina el ejemplo oficial es "011 15-2345-6789"; mostramos cómo lo escribe la gente.
      customPlaceholder: (example, country) => (country?.iso2 === 'ar' ? '11 2345-6789' : example),
    });
    // Si escribió el código del país de nuevo (Argentina +54 y "54 11 …"), lo saca.
    const fix = () => {
      const digits = input.value.replace(/\D/g, '');
      const dial = iti.getSelectedCountry()?.dialCode;
      if (dial && digits.startsWith(dial) && !iti.isValidNumber()) {
        iti.setNumber(`+${digits}`);
        if (!iti.isValidNumber()) iti.setNumber(input.value); // no era eso: lo deja como estaba
      }
    };
    const check = () => {
      fix();
      if (!input.value.trim()) return '';
      return iti.isValidNumber() ? '' : PHONE_ERRORS[iti.getValidationError()] || 'Revisá el número: no parece válido.';
    };
    input.addEventListener('blur', () => {
      const msg = check();
      input.setCustomValidity(msg);
      box.classList.toggle('invalid', Boolean(msg));
    });
    input.addEventListener('input', () => {
      input.setCustomValidity('');
      box.classList.remove('invalid');
    });
    phones.set(f.id, { iti, input, check });
    return box;
  }

  function buildForm() {
    const error = el('p', { class: 'error', role: 'alert' });
    const submit = el('button', { type: 'submit', class: 'primary' }, 'Confirmar reserva');
    const names = ['name', 'email', ...event.fields.map((f) => f.id)];

    const form = el(
      'form',
      {
        class: 'booking',
        onsubmit: async (e) => {
          e.preventDefault();
          error.textContent = '';
          for (const f of event.fields.filter((f) => f.type === 'tel')) {
            const { input, check } = phones.get(f.id);
            const msg = check();
            if (msg) {
              error.textContent = `«${f.label}»: ${msg}`;
              input.focus();
              return;
            }
          }
          submit.disabled = true;
          const data = new FormData(form);
          const answers = {};
          for (const f of event.fields) answers[f.id] = f.type === 'checkbox' ? form.elements[f.id].checked : f.type === 'tel' ? phones.get(f.id).iti.getNumber() || data.get(f.id) : data.get(f.id);
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
          : f.type === 'tel'
            ? el('div', { class: 'field' }, el('label', { for: `f-${f.id}` }, el('span', { class: f.required ? 'req' : '' }, f.label)), fieldControl(f))
            : el('label', {}, el('span', { class: f.required ? 'req' : '' }, f.label), fieldControl(f)),
      ),
      error,
      el('div', { class: 'actions' }, submit),
    );

    function saveDraft() {
      for (const name of names) {
        const input = form.elements[name];
        draft[name] = input.type === 'checkbox' ? input.checked : phones.has(name) ? phones.get(name).iti.getNumber() || input.value : input.value;
      }
    }
    for (const name of names) {
      if (!(name in draft)) continue;
      const input = form.elements[name];
      if (input.type === 'checkbox') input.checked = draft[name];
      else if (phones.has(name)) phones.get(name).iti.setNumber(draft[name]);
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
