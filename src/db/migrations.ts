import type { Db } from "./database";

/**
 * Versioned, forward-only migrations.
 *
 * Each migration runs inside its own transaction together with the row that
 * records it, so a failure can never leave the schema half-applied. Running
 * `migrate` twice is a no-op.
 */

export interface Migration {
  version: number;
  name: string;
  up(db: Db): void;
}

const SCHEMA_V1 = `
CREATE TABLE guild_defaults (
  guild_id                  TEXT PRIMARY KEY,
  focus_minutes             INTEGER,
  short_break_minutes       INTEGER,
  long_break_minutes        INTEGER,
  cycles_before_long_break  INTEGER,
  sound_enabled             INTEGER,
  sound_volume              INTEGER,
  updated_at                TEXT NOT NULL
);

CREATE TABLE channel_configs (
  guild_id                  TEXT NOT NULL,
  voice_channel_id          TEXT NOT NULL,
  focus_minutes             INTEGER,
  short_break_minutes       INTEGER,
  long_break_minutes        INTEGER,
  cycles_before_long_break  INTEGER,
  sound_enabled             INTEGER,
  sound_volume              INTEGER,
  configured_by             TEXT,
  updated_at                TEXT NOT NULL,
  PRIMARY KEY (guild_id, voice_channel_id)
);

CREATE INDEX idx_channel_configs_guild ON channel_configs (guild_id);

-- One row per guild: Discord allows a bot a single voice connection per guild.
CREATE TABLE active_sessions (
  guild_id                  TEXT PRIMARY KEY,
  voice_channel_id          TEXT NOT NULL,
  text_channel_id           TEXT,
  status_message_id         TEXT,
  stage                     TEXT NOT NULL,
  state                     TEXT NOT NULL,
  stage_started_at          INTEGER,
  stage_ends_at             INTEGER,
  paused_remaining_ms       INTEGER,
  completed_focus_stages    INTEGER NOT NULL DEFAULT 0,
  focus_minutes             INTEGER NOT NULL,
  short_break_minutes       INTEGER NOT NULL,
  long_break_minutes        INTEGER NOT NULL,
  cycles_before_long_break  INTEGER NOT NULL,
  sound_enabled             INTEGER NOT NULL,
  sound_volume              INTEGER NOT NULL,
  stop_reason               TEXT,
  updated_at                TEXT NOT NULL
);

CREATE INDEX idx_active_sessions_updated ON active_sessions (updated_at);
`;

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "core schema: guild defaults, channel configs, active sessions",
    up(db) {
      db.exec(SCHEMA_V1);
    },
  },
];

const CREATE_MIGRATION_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
`;

function ensureMigrationTable(db: Db): void {
  db.exec(CREATE_MIGRATION_TABLE);
}

export function currentVersion(db: Db): number {
  ensureMigrationTable(db);
  const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as
    | { version: number | null }
    | undefined;
  return row?.version ?? 0;
}

export interface MigrationResult {
  from: number;
  to: number;
  applied: readonly number[];
}

/** Apply every pending migration. Safe to call on every boot. */
export function migrate(db: Db): MigrationResult {
  ensureMigrationTable(db);
  const from = currentVersion(db);
  const applied: number[] = [];

  const ordered = [...MIGRATIONS].sort((left, right) => left.version - right.version);

  for (const migration of ordered) {
    if (migration.version <= from) continue;

    const apply = db.transaction(() => {
      migration.up(db);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
    });

    apply();
    applied.push(migration.version);
  }

  return { from, to: currentVersion(db), applied };
}
