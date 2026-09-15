import { join } from "node:path";

import { type Db, openDatabase } from "./database";
import { type MigrationResult, migrate } from "./migrations";

/**
 * Open the runtime database and bring the schema up to date.
 *
 * The path is always supplied by configuration; nothing here hard-codes a
 * location, so production can point `DATA_DIR` at `/srv/marzano` while tests
 * use a temporary directory.
 */
export function openMigratedDatabase(
  dataDir: string,
  fileName = "marzano.db",
): { db: Db; migration: MigrationResult } {
  const db = openDatabase(join(dataDir, fileName));
  const migration = migrate(db);
  return { db, migration };
}
