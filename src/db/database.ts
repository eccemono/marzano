import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

export type Db = Database.Database;

/**
 * Open the SQLite database and apply the pragmas the bot relies on.
 *
 * WAL keeps readers from blocking the writer, which matters because the timer
 * writes on every stage transition while commands read configuration.
 */
export function openDatabase(filePath: string): Db {
  if (filePath !== ":memory:") {
    mkdirSync(dirname(filePath), { recursive: true });
  }

  const db = new Database(filePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");

  return db;
}

/** Convenience for tests and tooling that want an isolated database. */
export function openInMemoryDatabase(): Db {
  return openDatabase(":memory:");
}
