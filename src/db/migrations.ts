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

const SCHEMA_V2 = `
-- One row per session, from start to stop. Everything else hangs off this, so
-- history is a record of what actually happened rather than something
-- reconstructed from whatever the live tables happen to hold.
CREATE TABLE session_runs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id          TEXT NOT NULL,
  voice_channel_id  TEXT NOT NULL,
  started_at        INTEGER NOT NULL,
  ended_at          INTEGER,
  stop_reason       TEXT,
  created_at        TEXT NOT NULL
);

CREATE INDEX idx_session_runs_guild ON session_runs (guild_id, started_at);

-- Each stage that ran, and how it ended. A skipped focus stage is recorded but
-- earns no focus credit, which is what keeps the summary honest.
CREATE TABLE stage_outcomes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      INTEGER NOT NULL REFERENCES session_runs (id) ON DELETE CASCADE,
  guild_id    TEXT NOT NULL,
  stage       TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER NOT NULL,
  outcome     TEXT NOT NULL,
  CHECK (outcome IN ('completed', 'skipped', 'interrupted'))
);

CREATE INDEX idx_stage_outcomes_run ON stage_outcomes (run_id);
CREATE INDEX idx_stage_outcomes_guild ON stage_outcomes (guild_id, ended_at);

-- Presence windows. An open window has left_at NULL so a crash is recoverable:
-- the row is still there to be closed on the next boot.
CREATE TABLE attendance (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     INTEGER NOT NULL REFERENCES session_runs (id) ON DELETE CASCADE,
  guild_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  joined_at  INTEGER NOT NULL,
  left_at    INTEGER
);

CREATE INDEX idx_attendance_run ON attendance (run_id);
CREATE INDEX idx_attendance_open ON attendance (run_id, left_at);

-- Credit already resolved against a stage. Focus and break are separate rows
-- (and separate kinds) so the leaderboard can sum them while the summary can
-- still show them apart.
CREATE TABLE credit_segments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      INTEGER NOT NULL REFERENCES session_runs (id) ON DELETE CASCADE,
  guild_id    TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  stage       TEXT NOT NULL,
  kind        TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  CHECK (kind IN ('focus', 'break'))
);

CREATE INDEX idx_credit_ranking ON credit_segments (guild_id, ended_at, user_id);
CREATE INDEX idx_credit_run ON credit_segments (run_id);

-- The live session's run, so a restart continues the same run instead of
-- opening a second one for the same session.
CREATE TABLE active_run (
  guild_id  TEXT PRIMARY KEY,
  run_id    INTEGER NOT NULL
);
`;

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "core schema: guild defaults, channel configs, active sessions",
    up(db) {
      db.exec(SCHEMA_V1);
    },
  },
  {
    version: 2,
    name: "history: session runs, stage outcomes, attendance and credit segments",
    up(db) {
      db.exec(SCHEMA_V2);
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
