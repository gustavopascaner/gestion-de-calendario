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
`);

// Respuestas del formulario configurable: [{ id, label, value }] en JSON.
try {
  db.exec("ALTER TABLE bookings ADD COLUMN answers TEXT NOT NULL DEFAULT '[]'");
} catch {
  // la columna ya existe
}

export const getKv = (key) => db.prepare('SELECT value FROM kv WHERE key = ?').get(key)?.value ?? null;
export const setKv = (key, value) =>
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);

export default db;
