/**
 * Thin wrapper around `node:sqlite` `DatabaseSync` matching the subset of
 * better-sqlite3 API used in this project (prepare/get/all/run, transaction).
 */
import { DatabaseSync } from "node:sqlite";

function wrapStatement(stmt) {
  return {
    get(...params) {
      const row = stmt.get(...params);
      return row === undefined ? undefined : row;
    },
    all(...params) {
      const rows = stmt.all(...params);
      return rows ?? [];
    },
    run(...params) {
      const r = stmt.run(...params);
      return { lastInsertRowid: Number(r.lastInsertRowid) };
    },
  };
}

export function wrapSqliteDatabase(raw) {
  return {
    exec(sql) {
      raw.exec(sql);
    },
    prepare(sql) {
      return wrapStatement(raw.prepare(sql));
    },
    transaction(fn) {
      return () => {
        raw.exec("BEGIN IMMEDIATE");
        try {
          const out = fn();
          raw.exec("COMMIT");
          return out;
        } catch (e) {
          try {
            raw.exec("ROLLBACK");
          } catch {
            /* ignore */
          }
          throw e;
        }
      };
    },
    /** @internal */
    _raw: raw,
  };
}

export function openDatabaseSync(path) {
  const raw = new DatabaseSync(path);
  return wrapSqliteDatabase(raw);
}
