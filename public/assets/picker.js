import { api, el, detectTz, dayKey, fmtTime, fmtDayLong, fmtMonth } from './common.js';

const WEEKDAYS = ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'];

/**
 * Calendario mensual + lista de horarios, en la zona horaria del visitante.
 * onSelect(startMs, tz) se llama al apretar "Siguiente" junto al horario elegido.
 */
export async function mountPicker(root, { slug, onSelect }) {
  const state = { tz: detectTz(), month: null, day: null, pending: null, slots: [], byDay: new Map() };

  function group() {
    state.byDay = new Map();
    for (const ms of state.slots) {
      const key = dayKey(ms, state.tz);
      if (!state.byDay.has(key)) state.byDay.set(key, []);
      state.byDay.get(key).push(ms);
    }
  }

  async function load() {
    root.replaceChildren(el('p', { class: 'muted' }, 'Cargando horarios…'));
    try {
      state.slots = (await api(`/api/slots?slug=${encodeURIComponent(slug)}`)).slots;
    } catch (err) {
      root.replaceChildren(el('p', { class: 'error' }, err.message));
      return;
    }
    group();
    state.day = null;
    state.pending = null;
    state.month = [...state.byDay.keys()][0]?.slice(0, 7) ?? null;
    render();
  }

  function render() {
    if (!state.byDay.size) {
      root.replaceChildren(el('p', {}, 'No hay horarios disponibles en los próximos días. Volvé a pasar más tarde.'));
      return;
    }
    const keys = [...state.byDay.keys()];
    const firstMonth = keys[0].slice(0, 7);
    const lastMonth = keys.at(-1).slice(0, 7);
    const [year, month] = state.month.split('-').map(Number);
    const shift = (delta) => {
      const d = new Date(Date.UTC(year, month - 1 + delta, 1));
      state.month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      render();
    };

    const cells = [];
    const offset = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7; // semana desde el lunes
    for (let i = 0; i < offset; i++) cells.push(el('span'));
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    for (let d = 1; d <= daysInMonth; d++) {
      const key = `${state.month}-${String(d).padStart(2, '0')}`;
      const avail = state.byDay.has(key);
      cells.push(
        el('button', {
          type: 'button',
          class: `day${avail ? ' avail' : ''}${key === state.day ? ' sel' : ''}`,
          disabled: !avail,
          'aria-pressed': String(key === state.day),
          onclick: () => { state.day = key; state.pending = null; render(); },
        }, String(d)),
      );
    }

    const zones = Intl.supportedValuesOf?.('timeZone') ?? [];
    if (!zones.includes(state.tz)) zones.unshift(state.tz);
    const tzSelect = el(
      'select',
      {
        'aria-label': 'Zona horaria',
        onchange: (e) => { state.tz = e.target.value; group(); state.day = null; state.pending = null; state.month = [...state.byDay.keys()][0]?.slice(0, 7) ?? state.month; render(); },
      },
      ...zones.map((z) => el('option', { value: z, selected: z === state.tz }, z.replaceAll('_', ' '))),
    );

    const calendar = el(
      'div',
      { class: 'cal' },
      el(
        'div',
        { class: 'cal-head' },
        el('button', { type: 'button', class: 'nav', 'aria-label': 'Mes anterior', disabled: state.month <= firstMonth, onclick: () => shift(-1) }, '‹'),
        el('strong', {}, fmtMonth(year, month)),
        el('button', { type: 'button', class: 'nav', 'aria-label': 'Mes siguiente', disabled: state.month >= lastMonth, onclick: () => shift(1) }, '›'),
      ),
      el('div', { class: 'grid' }, ...WEEKDAYS.map((w) => el('span', { class: 'wd' }, w)), ...cells),
      el('label', { class: 'tzrow' }, el('span', { class: 'muted' }, 'Zona horaria'), tzSelect),
    );

    const pick = el('div', { class: 'pick' }, calendar);
    if (state.day) {
      const list = state.byDay.get(state.day);
      pick.append(
        el(
          'div',
          { class: 'times' },
          el('h3', {}, fmtDayLong(list[0], state.tz)),
          ...list.map((ms) =>
            el(
              'div',
              { class: `slot${ms === state.pending ? ' open' : ''}` },
              el('button', { type: 'button', class: 'time', onclick: () => { state.pending = ms; render(); } }, fmtTime(ms, state.tz)),
              ms === state.pending ? el('button', { type: 'button', class: 'next', onclick: () => onSelect(ms, state.tz) }, 'Siguiente') : null,
            ),
          ),
        ),
      );
    }
    root.replaceChildren(pick);
  }

  await load();
  return { reload: load };
}
