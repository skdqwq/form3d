import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';

// A narrow D1-compatible interface keeps the task API independent of hosting.
export function openDatabase(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(resolve(filename)), {recursive: true, mode: 0o700});
  const raw = new DatabaseSync(filename);
  raw.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
  raw.exec('CREATE TABLE IF NOT EXISTS form3d_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL)');
  const name = '0000_reconstruction';
  const sql = readFileSync(new URL('../drizzle/0000_reconstruction.sql', import.meta.url), 'utf8');
  const checksum = createHash('sha256').update(sql.replaceAll('\r\n', '\n')).digest('hex');
  raw.exec('BEGIN IMMEDIATE');
  try {
    const previous = raw.prepare('SELECT checksum FROM form3d_migrations WHERE name=?').get(name);
    if (previous && previous.checksum !== checksum) throw new Error('Applied database migration has changed');
    if (!previous) {
      raw.exec(sql);
      raw.prepare('INSERT INTO form3d_migrations VALUES (?,?,?)').run(name, checksum, Date.now());
    }
    raw.exec('COMMIT');
  } catch (error) { raw.exec('ROLLBACK'); raw.close(); throw error; }
  return {
    raw,
    close: () => raw.close(),
    prepare(sql) {
      const statement = raw.prepare(sql);
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async first() { return statement.get(...values) ?? null; },
        async all() { return {results: statement.all(...values)}; },
        async run() { const result = statement.run(...values); return {meta: {changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid)}}; }
      };
    }
  };
}
