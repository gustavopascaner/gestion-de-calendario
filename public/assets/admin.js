import { $, el, api, fmtLong, applyTheme } from './common.js';

const DAYS = [['mon', 'Lunes'], ['tue', 'Martes'], ['wed', 'Miércoles'], ['thu', 'Jueves'], ['fri', 'Viernes'], ['sat', 'Sábado'], ['sun', 'Domingo']];
const TYPES = [['text', 'Texto corto'], ['textarea', 'Texto largo'], ['tel', 'Teléfono'], ['select', 'Lista desplegable'], ['checkbox', 'Casilla (sí/no)']];
const TABS = [['evento', 'Evento'], ['horarios', 'Horarios'], ['formulario', 'Formulario'], ['apariencia', 'Apariencia'], ['reservas', 'Reservas'], ['integraciones', 'Integraciones']];
const EDITABLE = new Set(['evento', 'horarios', 'formulario', 'apariencia']);

const app = $('#app');
let S; // ajustes en edición
let meta; // { google, smtp }
let tab = 'evento';
let dirty = false;
let saveMsg = null;
let bookings = null;

// ---------- helpers ----------

const markDirty = () => {
  dirty = true;
  saveMsg = null;
  const bar = $('#savebar');
  if (bar) renderSaveBar(bar);
};

function field(label, control, hint) {
  return el('label', {}, label, control, hint ? el('span', { class: 'hint' }, hint) : null);
}

function bound(tag, key, attrs = {}, { number = false } = {}) {
  const input = el(tag, attrs);
  input.value = S[key] ?? '';
  input.addEventListener('input', () => {
    S[key] = number ? Number(input.value) : input.value;
    markDirty();
  });
  return input;
}

const move = (arr, i, d) => {
  const j = i + d;
  if (j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
};

// ---------- login ----------

function loginView() {
  const error = el('p', { class: 'error', role: 'alert' });
  const form = el(
    'form',
    {
      class: 'booking',
      onsubmit: async (e) => {
        e.preventDefault();
        error.textContent = '';
        try {
          await api('/api/admin/login', { method: 'POST', body: { password: form.elements.password.value } });
          await boot();
        } catch (err) {
          error.textContent = err.message;
        }
      },
    },
    field('Contraseña del panel', el('input', { name: 'password', type: 'password', required: true, autocomplete: 'current-password' }), 'Es el valor de ADMIN_SECRET en tu .env'),
    error,
    el('button', { class: 'primary', type: 'submit' }, 'Entrar'),
  );
  app.replaceChildren(form);
  form.elements.password.focus();
}

// ---------- paneles ----------

function panelEvento() {
  const tzs = Intl.supportedValuesOf?.('timeZone') ?? [S.timezone];
  const tz = bound('select', 'timezone');
  tz.replaceChildren(...tzs.map((z) => el('option', { value: z }, z.replaceAll('_', ' '))));
  tz.value = S.timezone;
  return el(
    'div',
    { class: 'panel' },
    field('Tu nombre', bound('input', 'ownerName', { maxlength: '100' })),
    field('Título del evento', bound('input', 'title', { maxlength: '100' })),
    field('Descripción', bound('textarea', 'description', { rows: '4', maxlength: '1000' }), 'Se muestra en el panel izquierdo de la página de reservas.'),
    field('Ubicación', bound('input', 'location', { maxlength: '100' }), 'Texto libre (p. ej. «Google Meet», «Zoom»). Si Google está conectado, el link de Meet se agrega solo.'),
    el(
      'div',
      { class: 'row' },
      field('Duración (min)', bound('input', 'slotMinutes', { type: 'number', min: '5', max: '480' }, { number: true })),
      field('Descanso entre reuniones (min)', bound('input', 'bufferMinutes', { type: 'number', min: '0', max: '240' }, { number: true })),
      field('Antelación mínima (horas)', bound('input', 'minNoticeHours', { type: 'number', min: '0', max: '720' }, { number: true })),
      field('Días hacia adelante', bound('input', 'horizonDays', { type: 'number', min: '1', max: '90' }, { number: true })),
    ),
    field('Tu zona horaria', tz, 'Los horarios de la pestaña «Horarios» están escritos en esta zona.'),
  );
}

function panelHorarios() {
  const rows = DAYS.map(([key, name]) => {
    const ranges = S.weekly[key] ?? (S.weekly[key] = []);
    const toggle = el('input', {
      type: 'checkbox',
      checked: ranges.length > 0,
      onchange: (e) => {
        S.weekly[key] = e.target.checked ? [['09:00', '17:00']] : [];
        markDirty();
        renderPanel();
      },
    });
    const list = el(
      'div',
      {},
      ...ranges.map((r, i) =>
        el(
          'div',
          { class: 'range' },
          el('input', { type: 'time', value: r[0], 'aria-label': `${name}: desde`, oninput: (e) => { r[0] = e.target.value; markDirty(); } }),
          '–',
          el('input', { type: 'time', value: r[1], 'aria-label': `${name}: hasta`, oninput: (e) => { r[1] = e.target.value; markDirty(); } }),
          el('button', { type: 'button', 'aria-label': 'Quitar horario', onclick: () => { ranges.splice(i, 1); markDirty(); renderPanel(); } }, '✕'),
        ),
      ),
      ranges.length
        ? el('button', { type: 'button', class: 'link', onclick: () => { ranges.push(['09:00', '17:00']); markDirty(); renderPanel(); } }, '+ Agregar otro horario')
        : el('span', { class: 'muted' }, 'No disponible'),
    );
    return el('div', { class: 'day-row' }, el('label', { class: 'check' }, toggle, name), list);
  });
  return el('div', { class: 'panel' }, el('p', { class: 'muted' }, `Horas en ${S.timezone.replaceAll('_', ' ')}. Podés tener varios tramos por día (p. ej. mañana y tarde).`), ...rows);
}

function panelFormulario() {
  const cards = S.fields.map((f, i) => {
    const opts = f.type === 'select'
      ? field('Opciones (una por línea)', el('textarea', { rows: '4', oninput: (e) => { f.options = e.target.value.split('\n'); markDirty(); } }, (f.options ?? []).join('\n')))
      : null;
    if (opts) $('textarea', opts).value = (f.options ?? []).join('\n');
    const typeSel = el('select', {
      onchange: (e) => { f.type = e.target.value; if (f.type === 'select' && !f.options?.length) f.options = ['Opción 1']; markDirty(); renderPanel(); },
    }, ...TYPES.map(([v, l]) => el('option', { value: v, selected: v === f.type }, l)));
    return el(
      'div',
      { class: 'qcard' },
      el('div', { class: 'row' },
        field('Pregunta', el('input', { value: f.label, maxlength: '80', oninput: (e) => { f.label = e.target.value; markDirty(); } })),
        field('Tipo', typeSel),
      ),
      f.type === 'checkbox' ? null : field('Texto de ayuda', el('input', { value: f.placeholder ?? '', maxlength: '120', oninput: (e) => { f.placeholder = e.target.value; markDirty(); } })),
      opts,
      el(
        'div',
        { class: 'tools' },
        el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: Boolean(f.required), onchange: (e) => { f.required = e.target.checked; markDirty(); } }), 'Obligatoria'),
        el('button', { type: 'button', 'aria-label': 'Subir', disabled: i === 0, onclick: () => { move(S.fields, i, -1); markDirty(); renderPanel(); } }, '↑'),
        el('button', { type: 'button', 'aria-label': 'Bajar', disabled: i === S.fields.length - 1, onclick: () => { move(S.fields, i, 1); markDirty(); renderPanel(); } }, '↓'),
        el('button', { type: 'button', class: 'danger', onclick: () => { S.fields.splice(i, 1); markDirty(); renderPanel(); } }, 'Eliminar'),
      ),
    );
  });
  return el(
    'div',
    { class: 'panel' },
    el('p', { class: 'muted' }, 'Nombre y email siempre se piden. Acá definís las preguntas adicionales (hasta 12).'),
    ...cards,
    el('div', {}, el('button', {
      type: 'button',
      disabled: S.fields.length >= 12,
      onclick: () => { S.fields.push({ label: 'Nueva pregunta', type: 'text', required: false, options: [], placeholder: '' }); markDirty(); renderPanel(); },
    }, '+ Agregar pregunta')),
  );
}

function panelApariencia() {
  const color = bound('input', 'accentColor', { type: 'color' });
  color.addEventListener('input', () => applyTheme(S.accentColor));
  return el(
    'div',
    { class: 'panel' },
    field('Color principal', color, 'Botones, días disponibles y enlaces de la página de reservas.'),
    field('Mensaje de confirmación', bound('textarea', 'confirmationMessage', { rows: '3', maxlength: '500' }), 'Se muestra al visitante después de reservar (p. ej. instrucciones para prepararse).'),
    field('Redirigir a otra página tras reservar', bound('input', 'redirectUrl', { type: 'url', placeholder: 'https://tusitio.com/gracias' }), 'Opcional. Si lo completás, no se muestra la página de confirmación y el visitante va a esta URL. Los mails se envían igual.'),
  );
}

function panelReservas() {
  const box = el('div', { class: 'panel' }, el('p', { class: 'muted' }, 'Cargando…'));
  (async () => {
    try {
      bookings = (await api('/api/admin/bookings')).bookings;
    } catch (err) {
      box.replaceChildren(el('p', { class: 'error' }, err.message));
      return;
    }
    if (!bookings.length) return box.replaceChildren(el('p', { class: 'muted' }, 'Todavía no hay reservas próximas.'));
    box.replaceChildren(
      el('table', {},
        el('thead', {}, el('tr', {}, ...['Cuándo', 'Quién', 'Respuestas', ''].map((h) => el('th', {}, h)))),
        el('tbody', {}, ...bookings.map((b) => {
          const btn = el('button', { type: 'button', class: 'danger' }, 'Cancelar');
          btn.onclick = async () => {
            if (btn.dataset.armed !== '1') { btn.dataset.armed = '1'; btn.textContent = '¿Seguro?'; return; }
            btn.disabled = true;
            try { await api('/api/admin/cancel', { method: 'POST', body: { id: b.id } }); renderPanel(); } catch (err) { btn.textContent = err.message; }
          };
          return el('tr', {},
            el('td', {}, fmtLong(b.start, S.timezone), el('br'), b.status === 'cancelled' ? el('span', { class: 'badge off' }, 'Cancelada') : el('span', { class: 'badge' }, 'Confirmada')),
            el('td', {}, b.name, el('br'), el('a', { href: `mailto:${b.email}` }, b.email)),
            el('td', {}, ...b.answers.flatMap((a) => [el('div', {}, el('span', { class: 'muted' }, `${a.label}: `), a.value)])),
            el('td', {}, b.status === 'confirmed' ? btn : null),
          );
        })),
      ),
    );
  })();
  return box;
}

function panelIntegraciones() {
  const g = meta.google;
  return el(
    'div',
    { class: 'panel' },
    el('h2', {}, 'Google Calendar + Meet'),
    !g.configured
      ? el('p', {}, 'Faltan GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET y GOOGLE_REDIRECT_URI en .env. Seguí la guía del README.')
      : el('p', {}, g.connected ? el('span', { class: 'ok' }, '✅ Conectado. ') : 'Todavía no está conectado. ', el('a', { href: '/admin/google/connect' }, g.connected ? 'Reconectar' : 'Conectar con Google')),
    el('h2', {}, 'Email (SMTP)'),
    el('p', {}, meta.smtp ? el('span', { class: 'ok' }, '✅ Configurado.') : 'Sin configurar: los mails solo se registran en la consola del servidor. Completá SMTP_* en .env.'),
  );
}

const PANELS = { evento: panelEvento, horarios: panelHorarios, formulario: panelFormulario, apariencia: panelApariencia, reservas: panelReservas, integraciones: panelIntegraciones };

// ---------- armado ----------

function renderSaveBar(bar) {
  const btn = el('button', { type: 'button', class: 'primary', disabled: !dirty, onclick: save }, 'Guardar cambios');
  bar.replaceChildren(
    saveMsg ? el('span', { class: saveMsg.ok ? 'ok' : 'error', role: 'status' }, saveMsg.text) : el('span', { class: 'muted' }, dirty ? 'Tenés cambios sin guardar' : 'Todo guardado'),
    btn,
  );
}

async function save() {
  saveMsg = null;
  try {
    S = (await api('/api/admin/settings', { method: 'PUT', body: S })).settings;
    dirty = false;
    saveMsg = { ok: true, text: 'Guardado ✓' };
    applyTheme(S.accentColor);
    renderPanel();
  } catch (err) {
    saveMsg = { ok: false, text: err.message };
  }
  renderSaveBar($('#savebar'));
}

function renderPanel() {
  const slot = $('#panel');
  slot.replaceChildren(PANELS[tab]());
  const bar = $('#savebar');
  bar.hidden = !EDITABLE.has(tab);
  renderSaveBar(bar);
}

function renderShell() {
  const tabs = el('nav', { class: 'tabs', role: 'tablist' }, ...TABS.map(([id, label]) =>
    el('button', {
      type: 'button',
      role: 'tab',
      class: id === tab ? 'active' : '',
      onclick: () => { tab = id; renderShell(); },
    }, label)));
  app.replaceChildren(tabs, el('div', { id: 'panel' }), el('div', { id: 'savebar', class: 'savebar' }));
  renderPanel();
}

async function boot() {
  try {
    const data = await api('/api/admin/settings');
    S = data.settings;
    meta = data;
    $('#logout').hidden = false;
    applyTheme(S.accentColor);
    renderShell();
  } catch (err) {
    if (err.status === 401) return loginView();
    app.replaceChildren(el('p', { class: 'error' }, err.message));
  }
}

$('#logout').addEventListener('click', async () => {
  await api('/api/admin/logout', { method: 'POST', body: {} });
  location.reload();
});

boot();
