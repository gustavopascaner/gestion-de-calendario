import { api, el, detectTz, dayKey, fmtDayShort, fmtTime } from './common.js';

/**
 * Selector de día y horario, mostrado en la zona horaria del visitante.
 * onSelect(startMs, tz) se llama al elegir un horario.
 */
export async function mountPicker(root, { onSelect }) {
  const state = { tz: detectTz(), day: null, selected: null, data: null };

  async function load() {
    root.replaceChildren(el('p', { class: 'muted' }, 'Cargando horarios…'));
    try {
      state.data = await api('/api/slots');
    } catch (err) {
      root.replaceChildren(el('p', { class: 'error' }, err.message));
      return;
    }
    state.day = null;
    state.selected = null;
    render();
  }

  function render() {
    const { tz, data } = state;
    const byDay = new Map();
    for (const ms of data.slots) {
      const key = dayKey(ms, tz);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(ms);
    }
    if (!byDay.has(state.day)) state.day = [...byDay.keys()][0] ?? null;

    const zones = Intl.supportedValuesOf?.('timeZone') ?? [];
    if (!zones.includes(tz)) zones.unshift(tz);
    const tzSelect = el(
      'select',
      { id: 'tz', 'aria-label': 'Zona horaria', onchange: (e) => { state.tz = e.target.value; render(); } },
      ...zones.map((z) => el('option', { value: z, selected: z === tz }, z.replaceAll('_', ' '))),
    );

    if (!byDay.size) {
      root.replaceChildren(el('p', {}, 'No hay horarios disponibles en los próximos días. Volvé a pasar más tarde.'));
      return;
    }

    const days = el(
      'div',
      { class: 'days', role: 'tablist' },
      ...[...byDay].map(([key, list]) =>
        el('button', {
          type: 'button',
          class: `chip${key === state.day ? ' active' : ''}`,
          role: 'tab',
          'aria-selected': String(key === state.day),
          onclick: () => { state.day = key; render(); },
        }, fmtDayShort(list[0], tz)),
      ),
    );

    const times = el(
      'div',
      { class: 'times' },
      ...(byDay.get(state.day) ?? []).map((ms) =>
        el('button', {
          type: 'button',
          class: `chip${ms === state.selected ? ' active' : ''}`,
          onclick: () => { state.selected = ms; render(); onSelect(ms, tz); },
        }, fmtTime(ms, tz)),
      ),
    );

    root.replaceChildren(
      el('label', { class: 'tzrow' }, el('span', { class: 'muted' }, 'Tu zona horaria'), tzSelect),
      days,
      times,
    );
  }

  await load();
  return { reload: load };
}
