import { DateTime } from 'luxon';

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * Devuelve los inicios (ms epoch) de los slots disponibles.
 * `blocked` es una lista de { start, end } en ms (reservas + eventos ocupados de Google).
 * Un slot se descarta si queda a menos de `bufferMinutes` de cualquier bloqueo.
 */
export function generateSlots(cfg, nowMs, blocked = []) {
  const zone = cfg.timezone;
  const slotMs = cfg.slotMinutes * 60_000;
  const bufferMs = cfg.bufferMinutes * 60_000;
  const earliest = nowMs + cfg.minNoticeHours * 3_600_000;
  const today = DateTime.fromMillis(nowMs, { zone }).startOf('day');
  const slots = [];

  for (let d = 0; d < cfg.horizonDays; d++) {
    const day = today.plus({ days: d });
    const ranges = cfg.weekly[DAY_KEYS[day.weekday % 7]] ?? [];
    for (const [from, to] of ranges) {
      const [fh, fm] = from.split(':').map(Number);
      const [th, tm] = to.split(':').map(Number);
      const end = day.set({ hour: th, minute: tm }).toMillis();
      for (let t = day.set({ hour: fh, minute: fm }).toMillis(); t + slotMs <= end; t += slotMs) {
        if (t < earliest) continue;
        const clash = blocked.some((b) => t < b.end + bufferMs && t + slotMs > b.start - bufferMs);
        if (!clash) slots.push(t);
      }
    }
  }
  return slots;
}
