import { $, el, api, fmtLong, applyTheme } from './common.js';

const DAYS = [['mon', 'Lunes'], ['tue', 'Martes'], ['wed', 'Miércoles'], ['thu', 'Jueves'], ['fri', 'Viernes'], ['sat', 'Sábado'], ['sun', 'Domingo']];
const TYPES = [['text', 'Texto corto'], ['textarea', 'Texto largo'], ['tel', 'Teléfono'], ['select', 'Lista desplegable'], ['checkbox', 'Casilla (sí/no)']];
const TABS = [['inicio', 'Inicio'], ['eventos', 'Eventos'], ['reservas', 'Reservas'], ['general', 'General'], ['integraciones', 'Integraciones']];
const EDITOR_TABS = [['detalles', 'Detalles'], ['horarios', 'Horarios'], ['formulario', 'Formulario'], ['apariencia', 'Apariencia']];

const app = $('#app');
let G; // ajustes generales
let events = []; // tipos de evento guardados
let meta; // { google, smtp, defaultEvent }
let S = null; // evento en edición (copia)
let tab = 'inicio';
let etab = 'detalles';
let dirty = false;
let saveMsg = null;

const clone = (o) => JSON.parse(JSON.stringify(o));

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

function bound(obj, tag, key, attrs = {}, { number = false } = {}) {
  const input = el(tag, attrs);
  input.value = obj[key] ?? '';
  input.addEventListener('input', () => {
    obj[key] = number ? Number(input.value) : input.value;
    markDirty();
  });
  return input;
}

const move = (arr, i, d) => {
  const j = i + d;
  if (j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
};

const tzSelect = (obj) => {
  const zones = Intl.supportedValuesOf?.('timeZone') ?? [obj.timezone];
  const sel = bound(obj, 'select', 'timezone');
  sel.replaceChildren(...zones.map((z) => el('option', { value: z }, z.replaceAll('_', ' '))));
  sel.value = obj.timezone;
  return sel;
};

async function copy(text, button) {
  const old = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = '¡Copiado!';
  } catch {
    button.textContent = 'No se pudo copiar';
  }
  setTimeout(() => { button.textContent = old; }, 1500);
}

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

// ---------- lista de eventos ----------

function panelEventos() {
  const box = el('div', { class: 'panel' });
  const origin = location.origin;

  const rows = events.map((e, i) => {
    const del = el('button', { type: 'button', class: 'danger' }, 'Eliminar');
    del.onclick = async () => {
      if (del.dataset.armed !== '1') { del.dataset.armed = '1'; del.textContent = '¿Seguro?'; return; }
      try {
        await api(`/api/admin/events/${e.id}`, { method: 'DELETE' });
        await reload();
      } catch (err) {
        del.textContent = err.message;
        del.title = err.message;
      }
    };
    const iframeCode = `<iframe src="${origin}/book/${e.slug}" title="${e.title.replace(/"/g, '&quot;')}" style="width:100%;height:620px;border:0"></iframe>`;
    const linkBtn = el('button', { type: 'button' }, 'Copiar link');
    linkBtn.onclick = () => copy(`${origin}/book/${e.slug}`, linkBtn);
    const embedBtn = el('button', { type: 'button' }, 'Copiar iframe');
    embedBtn.onclick = () => copy(iframeCode, embedBtn);
    const row = el(
      'div',
      { class: `erow${e.active ? '' : ' off'}` },
      el('div', {},
        el('h3', {}, e.title, ' ', el('span', { class: `badge${e.active ? '' : ' off'}` }, e.active ? 'Activo' : 'Inactivo')),
        el('div', { class: 'muted' }, `${e.slotMinutes} min · `, el('a', { href: `/book/${e.slug}`, target: '_blank', rel: 'noopener' }, `/book/${e.slug}`)),
      ),
      el('div', { class: 'tools' },
        el('button', { type: 'button', 'aria-label': 'Subir', disabled: i === 0, onclick: () => reorder(i, -1) }, '↑'),
        el('button', { type: 'button', 'aria-label': 'Bajar', disabled: i === events.length - 1, onclick: () => reorder(i, 1) }, '↓'),
        linkBtn,
        embedBtn,
        el('button', { type: 'button', onclick: () => openEditor(clone(e)) }, 'Editar'),
        el('button', { type: 'button', onclick: () => duplicate(e.id) }, 'Duplicar'),
        del,
      ),
    );
    row.style.borderLeftColor = e.accentColor;
    return row;
  });

  box.append(
    el('div', { class: 'row' }, el('p', { class: 'muted' }, 'Cada tipo de evento tiene su propio link, duración, horarios y formulario. Todas las reservas comparten tu agenda: si te reservan uno, los demás se bloquean.'),
      el('div', {}, el('button', { type: 'button', class: 'primary', onclick: newEvent }, '+ Nuevo tipo de evento'))),
    ...(rows.length ? rows : [el('p', { class: 'muted' }, 'Todavía no hay eventos. Creá el primero.')]),
    el('p', { class: 'muted' }, `Página con todos tus eventos: `, el('a', { href: '/book', target: '_blank', rel: 'noopener' }, `${location.origin}/book`)),
  );
  return box;
}

async function reorder(i, d) {
  move(events, i, d);
  await api('/api/admin/events/order', { method: 'POST', body: { ids: events.map((e) => e.id) } });
  renderShell();
}

async function duplicate(id) {
  const { event } = await api('/api/admin/events', { method: 'POST', body: { duplicateOf: id } });
  await reload();
  openEditor(clone(events.find((e) => e.id === event.id)));
}

function newEvent() {
  openEditor({ ...clone(meta.defaultEvent), id: null });
}

function openEditor(event) {
  S = event;
  etab = 'detalles';
  dirty = !event.id; // un evento nuevo todavía no está guardado
  saveMsg = null;
  applyTheme(S.accentColor);
  renderShell();
}

function closeEditor() {
  if (dirty && !confirmLeave()) return;
  S = null;
  dirty = false;
  saveMsg = null;
  renderShell();
}

const confirmLeave = () => window.confirm('Tenés cambios sin guardar. ¿Salir igual?');

// ---------- paneles del editor ----------

function panelDetalles() {
  return el(
    'div',
    { class: 'panel' },
    field('Título del evento', bound(S, 'input', 'title', { maxlength: '100' })),
    field('Link', el('div', { class: 'slugrow' }, el('span', {}, `${location.origin}/book/`), bound(S, 'input', 'slug', { maxlength: '40', placeholder: 'se genera del título' })), 'Solo minúsculas, números y guiones.'),
    el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: S.active !== false, onchange: (e) => { S.active = e.target.checked; markDirty(); } }), 'Activo (visible en la página pública)'),
    field('Descripción', bound(S, 'textarea', 'description', { rows: '4', maxlength: '1000' }), 'Se muestra en el panel izquierdo de la página de reservas.'),
    field('Ubicación', bound(S, 'input', 'location', { maxlength: '100' }), 'Texto libre (p. ej. «Google Meet», «Zoom»). Si Google está conectado, el link de Meet se agrega solo.'),
    el(
      'div',
      { class: 'row' },
      field('Duración (min)', bound(S, 'input', 'slotMinutes', { type: 'number', min: '5', max: '480' }, { number: true })),
      field('Descanso entre reuniones (min)', bound(S, 'input', 'bufferMinutes', { type: 'number', min: '0', max: '240' }, { number: true })),
      field('Antelación mínima (horas)', bound(S, 'input', 'minNoticeHours', { type: 'number', min: '0', max: '720' }, { number: true })),
      field('Días hacia adelante', bound(S, 'input', 'horizonDays', { type: 'number', min: '1', max: '90' }, { number: true })),
    ),
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
        renderEditorPanel();
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
          el('button', { type: 'button', 'aria-label': 'Quitar horario', onclick: () => { ranges.splice(i, 1); markDirty(); renderEditorPanel(); } }, '✕'),
        ),
      ),
      ranges.length
        ? el('button', { type: 'button', class: 'link', onclick: () => { ranges.push(['09:00', '17:00']); markDirty(); renderEditorPanel(); } }, '+ Agregar otro horario')
        : el('span', { class: 'muted' }, 'No disponible'),
    );
    return el('div', { class: 'day-row' }, el('label', { class: 'check' }, toggle, name), list);
  });
  return el('div', { class: 'panel' }, el('p', { class: 'muted' }, `Horas en ${G.timezone.replaceAll('_', ' ')} (se cambia en «General»). Podés tener varios tramos por día.`), ...rows);
}

function panelFormulario() {
  const cards = S.fields.map((f, i) => {
    const opts = f.type === 'select'
      ? field('Opciones (una por línea)', el('textarea', { rows: '4', oninput: (e) => { f.options = e.target.value.split('\n'); markDirty(); } }))
      : null;
    if (opts) $('textarea', opts).value = (f.options ?? []).join('\n');
    const typeSel = el('select', {
      onchange: (e) => { f.type = e.target.value; if (f.type === 'select' && !f.options?.length) f.options = ['Opción 1']; markDirty(); renderEditorPanel(); },
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
        el('button', { type: 'button', 'aria-label': 'Subir', disabled: i === 0, onclick: () => { move(S.fields, i, -1); markDirty(); renderEditorPanel(); } }, '↑'),
        el('button', { type: 'button', 'aria-label': 'Bajar', disabled: i === S.fields.length - 1, onclick: () => { move(S.fields, i, 1); markDirty(); renderEditorPanel(); } }, '↓'),
        el('button', { type: 'button', class: 'danger', onclick: () => { S.fields.splice(i, 1); markDirty(); renderEditorPanel(); } }, 'Eliminar'),
      ),
    );
  });
  return el(
    'div',
    { class: 'panel' },
    el('p', { class: 'muted' }, 'Nombre y email siempre se piden. Acá definís las preguntas adicionales de este evento (hasta 12).'),
    ...cards,
    el('div', {}, el('button', {
      type: 'button',
      disabled: S.fields.length >= 12,
      onclick: () => { S.fields.push({ label: 'Nueva pregunta', type: 'text', required: false, options: [], placeholder: '' }); markDirty(); renderEditorPanel(); },
    }, '+ Agregar pregunta')),
  );
}

function panelApariencia() {
  const color = bound(S, 'input', 'accentColor', { type: 'color' });
  color.addEventListener('input', () => applyTheme(S.accentColor));
  return el(
    'div',
    { class: 'panel' },
    field('Color principal', color, 'Botones, días disponibles y enlaces de la página de este evento.'),
    field('Mensaje de confirmación', bound(S, 'textarea', 'confirmationMessage', { rows: '3', maxlength: '500' }), 'Se muestra al visitante después de reservar (p. ej. instrucciones para prepararse).'),
    field('Redirigir a otra página tras reservar', bound(S, 'input', 'redirectUrl', { type: 'url', placeholder: 'https://tusitio.com/gracias' }), 'Opcional. Si lo completás, no se muestra la página de confirmación y el visitante va a esta URL. Los mails se envían igual.'),
  );
}

const EDITOR_PANELS = { detalles: panelDetalles, horarios: panelHorarios, formulario: panelFormulario, apariencia: panelApariencia };

// ---------- otros paneles ----------

function panelGeneral() {
  return el(
    'div',
    { class: 'panel' },
    el('p', { class: 'muted' }, 'Ajustes compartidos por todos los tipos de evento.'),
    field('Tu nombre', bound(G, 'input', 'ownerName', { maxlength: '100' })),
    field('Tu zona horaria', tzSelect(G), 'Los horarios de cada evento están escritos en esta zona.'),
  );
}

function panelInicio() {
  const box = el('div', { class: 'panel' }, el('p', { class: 'muted' }, 'Cargando…'));
  (async () => {
    let s;
    try {
      s = await api('/api/admin/stats');
    } catch (err) {
      box.replaceChildren(el('p', { class: 'error' }, err.message));
      return;
    }
    const stat = (n, label) => el('div', { class: 'stat' }, el('strong', {}, String(n)), el('span', {}, label));
    const chip = (ok, text) => el('span', { class: `badge${ok ? '' : ' off'}` }, `${ok ? '✓' : '✗'} ${text}`);
    const max = Math.max(1, ...s.byEvent.map((e) => e.n));
    const extra = meta.busyAccounts?.length ?? 0;

    box.replaceChildren(
      el('div', { class: 'stats' },
        stat(s.upcoming, 'Próximas reservas'),
        stat(s.week, 'En los próximos 7 días'),
        stat(s.monthCount, `Reservas en ${s.monthLabel}`),
        stat(`${s.monthHours} h`, 'Horas agendadas este mes'),
        stat(s.monthCancelled, 'Canceladas este mes'),
        stat(s.activeEvents, 'Eventos activos')),
      el('h2', {}, 'Próximas reuniones'),
      s.next.length
        ? el('table', {},
            el('thead', {}, el('tr', {}, ...['Cuándo', 'Evento', 'Quién'].map((h) => el('th', {}, h)))),
            el('tbody', {}, ...s.next.map((b) => el('tr', {},
              el('td', {}, fmtLong(b.start, G.timezone)),
              el('td', {}, b.title),
              el('td', {}, b.name, el('br'), el('a', { href: `mailto:${b.email}` }, b.email))))))
        : el('p', { class: 'muted' }, 'No hay reuniones próximas.'),
      el('h2', {}, `Reservas por evento (${s.monthLabel})`),
      ...(s.byEvent.length
        ? s.byEvent.map((e) => {
            const bar = el('div', { class: 'bar' });
            bar.style.width = `${Math.round((e.n / max) * 100)}%`; // CSSOM: permitido por la CSP
            return el('div', { class: 'barrow' }, el('span', {}, e.title), bar, el('strong', {}, String(e.n)));
          })
        : [el('p', { class: 'muted' }, 'Todavía no hay reservas este mes.')]),
      el('h2', {}, 'Estado'),
      el('div', { class: 'chips' },
        chip(meta.google.connected, 'Google Calendar'),
        chip(extra > 0, extra === 1 ? '1 cuenta extra' : `${extra} cuentas extra`),
        chip(meta.smtp, 'Email (SMTP)'),
        chip(Boolean(G.webhookUrl), 'Webhook n8n')),
    );
  })();
  return box;
}

function panelReservas() {
  const box = el('div', { class: 'panel' }, el('p', { class: 'muted' }, 'Cargando…'));
  (async () => {
    let bookings;
    try {
      bookings = (await api('/api/admin/bookings')).bookings;
    } catch (err) {
      box.replaceChildren(el('p', { class: 'error' }, err.message));
      return;
    }
    if (!bookings.length) return box.replaceChildren(el('p', { class: 'muted' }, 'Todavía no hay reservas próximas.'));
    box.replaceChildren(
      el('table', {},
        el('thead', {}, el('tr', {}, ...['Cuándo', 'Evento', 'Quién', 'Respuestas', ''].map((h) => el('th', {}, h)))),
        el('tbody', {}, ...bookings.map((b) => {
          const btn = el('button', { type: 'button', class: 'danger' }, 'Cancelar');
          btn.onclick = async () => {
            if (btn.dataset.armed !== '1') { btn.dataset.armed = '1'; btn.textContent = '¿Seguro?'; return; }
            btn.disabled = true;
            try { await api('/api/admin/cancel', { method: 'POST', body: { id: b.id } }); renderShell(); } catch (err) { btn.textContent = err.message; }
          };
          return el('tr', {},
            el('td', {}, fmtLong(b.start, G.timezone), el('br'), b.status === 'cancelled' ? el('span', { class: 'badge off' }, 'Cancelada') : el('span', { class: 'badge' }, 'Confirmada')),
            el('td', {}, b.title),
            el('td', {}, b.name, el('br'), el('a', { href: `mailto:${b.email}` }, b.email)),
            el('td', {}, ...b.answers.map((a) => el('div', {}, el('span', { class: 'muted' }, `${a.label}: `), a.value))),
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
  const W = { url: G.webhookUrl ?? '', secret: '', clear: false };
  const msg = el('span', { role: 'status' });
  const deliveries = el('div');

  const renderDeliveries = () => {
    const list = meta.deliveries ?? [];
    deliveries.replaceChildren(
      list.length
        ? el('table', {},
            el('thead', {}, el('tr', {}, ...['Cuándo', 'Evento', 'Estado', 'Intentos', 'Error'].map((h) => el('th', {}, h)))),
            el('tbody', {}, ...list.map((d) => el('tr', {},
              el('td', {}, fmtLong(d.created_at, G.timezone)),
              el('td', {}, d.event),
              el('td', {}, el('span', { class: `badge${d.status === 'ok' ? '' : ' off'}` }, d.status === 'ok' ? 'Enviado' : d.status === 'failed' ? 'Falló' : 'Reintentando')),
              el('td', {}, String(d.attempts)),
              el('td', {}, d.last_error || ''),
            ))),
          )
        : el('p', { class: 'muted' }, 'Todavía no se envió ningún evento.'),
    );
  };
  renderDeliveries();

  const saveBtn = el('button', { type: 'button', class: 'primary' }, 'Guardar webhook');
  saveBtn.onclick = async () => {
    msg.className = 'muted';
    msg.textContent = 'Guardando…';
    try {
      const res = await api('/api/admin/global', {
        method: 'PUT',
        body: { ownerName: G.ownerName, timezone: G.timezone, webhookUrl: W.url, webhookSecret: W.secret, clearWebhookSecret: W.clear },
      });
      G = res.global;
      meta.deliveries = res.deliveries;
      renderShell();
    } catch (err) {
      msg.className = 'error';
      msg.textContent = err.message;
    }
  };
  const testBtn = el('button', { type: 'button' }, 'Enviar prueba');
  testBtn.onclick = async () => {
    msg.className = 'muted';
    msg.textContent = 'Enviando…';
    try {
      const res = await api('/api/admin/webhook/test', { method: 'POST', body: {} });
      meta.deliveries = res.deliveries;
      msg.className = res.ok ? 'ok' : 'error';
      msg.textContent = res.ok ? 'Prueba enviada ✓ (event: "test")' : `No se pudo enviar: ${res.error}`;
      renderDeliveries();
    } catch (err) {
      msg.className = 'error';
      msg.textContent = err.message;
    }
  };

  const busy = (meta.busyAccounts ?? []).map((a) => {
    const del = el('button', { type: 'button', class: 'danger' }, 'Quitar');
    del.onclick = async () => {
      if (del.dataset.armed !== '1') { del.dataset.armed = '1'; del.textContent = '¿Seguro?'; return; }
      await api(`/api/admin/google/busy/${a.id}`, { method: 'DELETE' });
      await reload();
    };
    return el('div', { class: 'erow' }, el('div', {}, el('strong', {}, a.email), el('div', { class: 'muted' }, 'Solo se lee si estás ocupado')), el('div', { class: 'tools' }, del));
  });

  return el(
    'div',
    { class: 'panel' },
    el('h2', {}, 'Google Calendar + Meet'),
    !g.configured
      ? el('p', {}, 'Faltan GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET y GOOGLE_REDIRECT_URI en .env. Seguí la guía del README.')
      : el('p', {}, g.connected ? el('span', { class: 'ok' }, '✅ Cuenta principal conectada (crea los eventos y los links de Meet). ') : 'Todavía no está conectada la cuenta principal. ', el('a', { href: '/admin/google/connect' }, g.connected ? 'Reconectar' : 'Conectar con Google')),
    el('h2', {}, 'Cuentas extra: solo disponibilidad'),
    el('p', { class: 'muted' }, 'Los eventos ocupados de estas cuentas bloquean horarios en tus páginas de reserva. No se crea ningún evento ni link de Meet ahí; solo se pide el permiso de «ver si estás libre u ocupado».'),
    ...busy,
    g.configured ? el('div', {}, el('a', { href: '/admin/google/connect?mode=busy' }, '+ Conectar otra cuenta de Google')) : null,
    el('h2', {}, 'Webhook (n8n)'),
    el('p', { class: 'muted' }, 'Cada vez que alguien reserva, reprograma o cancela, se envía un POST JSON a esta URL (formato parecido al de Calendly: event + payload). En n8n usá un nodo Webhook con método POST.'),
    field('URL del webhook', el('input', { type: 'url', value: W.url, placeholder: 'https://n8n.tudominio.com/webhook/…', oninput: (e) => { W.url = e.target.value; } })),
    field('Secreto (opcional)', el('input', { type: 'password', autocomplete: 'off', placeholder: G.webhookSecretSet ? 'Guardado: escribí para reemplazarlo' : 'Se envía en el header X-Webhook-Secret', oninput: (e) => { W.secret = e.target.value; } })),
    G.webhookSecretSet ? el('label', { class: 'check' }, el('input', { type: 'checkbox', onchange: (e) => { W.clear = e.target.checked; } }), 'Quitar el secreto guardado') : null,
    el('div', { class: 'actions' }, saveBtn, testBtn, msg),
    deliveries,
    el('h2', {}, 'Email (SMTP)'),
    el('p', {}, meta.smtp ? el('span', { class: 'ok' }, '✅ Configurado.') : 'Sin configurar: los mails solo se registran en la consola del servidor. Completá SMTP_* en .env.'),
  );
}

// ---------- guardado ----------

function renderSaveBar(bar) {
  const editing = S !== null || tab === 'general';
  bar.hidden = !editing;
  if (!editing) return;
  bar.replaceChildren(
    saveMsg ? el('span', { class: saveMsg.ok ? 'ok' : 'error', role: 'status' }, saveMsg.text) : el('span', { class: 'muted' }, dirty ? 'Tenés cambios sin guardar' : 'Todo guardado'),
    el('button', { type: 'button', class: 'primary', disabled: !dirty, onclick: save }, 'Guardar cambios'),
  );
}

async function save() {
  saveMsg = null;
  try {
    if (S) {
      const { event } = S.id
        ? await api(`/api/admin/events/${S.id}`, { method: 'PUT', body: S })
        : await api('/api/admin/events', { method: 'POST', body: S });
      S = clone(event);
      await refreshEvents();
      applyTheme(S.accentColor);
    } else {
      G = (await api('/api/admin/global', { method: 'PUT', body: G })).global;
    }
    dirty = false;
    saveMsg = { ok: true, text: 'Guardado ✓' };
    renderShell();
  } catch (err) {
    saveMsg = { ok: false, text: err.message };
    renderSaveBar($('#savebar'));
  }
}

// ---------- armado ----------

function renderEditorPanel() {
  const slot = $('#etab-panel');
  if (slot) slot.replaceChildren(EDITOR_PANELS[etab]());
}

function renderShell() {
  const tabs = el('nav', { class: 'tabs', role: 'tablist' }, ...TABS.map(([id, label]) =>
    el('button', {
      type: 'button',
      role: 'tab',
      class: id === tab ? 'active' : '',
      onclick: () => {
        if (id === tab && !S) return;
        if (dirty && !confirmLeave()) return;
        tab = id;
        S = null;
        dirty = false;
        saveMsg = null;
        renderShell();
      },
    }, label)));

  let body;
  if (tab === 'eventos' && S) {
    body = el(
      'div',
      {},
      el('div', { class: 'actions' },
        el('button', { type: 'button', onclick: closeEditor }, '← Volver a los eventos'),
        el('strong', {}, S.id ? `Editando: ${S.title}` : 'Nuevo tipo de evento')),
      el('div', { class: 'subtabs' }, ...EDITOR_TABS.map(([id, label]) =>
        el('button', { type: 'button', class: id === etab ? 'active' : '', onclick: () => { etab = id; renderShell(); } }, label))),
      el('div', { id: 'etab-panel' }),
    );
  } else {
    body = el('div', { id: 'main-panel' });
  }
  app.replaceChildren(tabs, body, el('div', { id: 'savebar', class: 'savebar' }));

  if (tab === 'eventos' && S) renderEditorPanel();
  else $('#main-panel').replaceChildren({ inicio: panelInicio, eventos: panelEventos, reservas: panelReservas, general: panelGeneral, integraciones: panelIntegraciones }[tab]());
  renderSaveBar($('#savebar'));
}

async function refreshEvents() {
  const data = await api('/api/admin/settings');
  events = data.events;
  meta = data;
}

async function reload() {
  await refreshEvents();
  renderShell();
}

async function boot() {
  try {
    const data = await api('/api/admin/settings');
    G = data.global;
    events = data.events;
    meta = data;
    $('#logout').hidden = false;
    applyTheme(events[0]?.accentColor);
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
