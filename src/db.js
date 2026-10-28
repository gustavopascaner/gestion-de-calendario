import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const file = process.env.DB_PATH || path.resolve('data/bookings.db');
fs.mkdirSync(path.dirname(file), { recursive: true });

const db = new DatabaseSync(file);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS bookings (
    id              TEXT PRIMARY KEY,
    start_utc       INTEGER NOT NULL,
    end_utc         INTEGER NOT NULL,
    name            TEXT NOT NULL,
    email           TEXT NOT NULL,
    note            TEXT NOT NULL DEFAULT '',
    tz              TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'confirmed',
    google_event_id TEXT,
    meet_url        TEXT,
    created_at      INTEGER NOT NULL
  );
  -- Red de seguridad contra doble reserva del mismo horario.
  CREATE UNIQUE INDEX IF NOT EXISTS bookings_active_start
    ON bookings (start_utc) WHERE status = 'confirmed';

  CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  -- Cuentas de Google extra: solo se consulta su disponibilidad (freeBusy), nunca se escribe en ellas.
  CREATE TABLE IF NOT EXISTS google_busy_accounts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT NOT NULL UNIQUE,
    refresh_token TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );

  -- Historial de envíos al webhook (n8n).
  CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id TEXT,
    event      TEXT NOT NULL,
    status     TEXT NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );

  -- Tipos de evento: slug/orden/activo como columnas, el resto de la configuración en JSON.
  CREATE TABLE IF NOT EXISTS event_types (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    slug     TEXT NOT NULL UNIQUE,
    position INTEGER NOT NULL DEFAULT 0,
    active   INTEGER NOT NULL DEFAULT 1,
    data     TEXT NOT NULL
  );
`);

// Migraciones livianas: agregan la columna solo si todavía no existe.
for (const sql of [
  "ALTER TABLE bookings ADD COLUMN answers TEXT NOT NULL DEFAULT '[]'", // respuestas del formulario: [{ id, label, value }]
  'ALTER TABLE bookings ADD COLUMN event_type_id INTEGER',
  "ALTER TABLE bookings ADD COLUMN event_title TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE bookings ADD COLUMN tracking TEXT NOT NULL DEFAULT '{}'", // utm_* del link de origen
  "ALTER TABLE webhook_deliveries ADD COLUMN destination TEXT NOT NULL DEFAULT ''", // nombre del webhook al que se envió
]) {
  try {
    db.exec(sql);
  } catch {
    // la columna ya existe
  }
}

export const getKv = (key) => db.prepare('SELECT value FROM kv WHERE key = ?').get(key)?.value ?? null;
export const setKv = (key, value) =>
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);

export default db;
