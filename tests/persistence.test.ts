import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { openMigratedDatabase } from "../src/db/bootstrap";
import {
  deleteChannelConfig,
  deleteGuildDefaults,
  getChannelConfig,
  getGuildDefaults,
  listChannelConfigs,
  saveChannelConfig,
  saveGuildDefaults,
} from "../src/db/config-repository";
import { type Db, openInMemoryDatabase } from "../src/db/database";
import { currentVersion, migrate } from "../src/db/migrations";
import {
  type ActiveSessionRecord,
  deleteActiveSession,
  getActiveSession,
  listActiveSessions,
  saveActiveSession,
} from "../src/db/session-repository";
import { BUILT_IN_DEFAULTS } from "../src/domain/config";

const GUILD = "111111111111111111";
const CHANNEL_A = "222222222222222222";
const CHANNEL_B = "333333333333333333";

function withDatabase<T>(run: (db: Db) => T): T {
  const db = openInMemoryDatabase();
  try {
    migrate(db);
    return run(db);
  } finally {
    db.close();
  }
}

function sessionRecord(overrides: Partial<ActiveSessionRecord> = {}): ActiveSessionRecord {
  return {
    guildId: GUILD,
    voiceChannelId: CHANNEL_A,
    textChannelId: null,
    statusMessageId: null,
    stage: "focus",
    state: "running",
    stageStartedAt: 1_760_000_000_000,
    awaitingContinue: false,
    stageEndsAt: 1_760_001_500_000,
    pausedRemainingMs: null,
    completedFocusStages: 0,
    config: BUILT_IN_DEFAULTS,
    stopReason: null,
    ...overrides,
  };
}

describe("migrations", () => {
  it("reports version 0 before anything is applied", () => {
    const db = openInMemoryDatabase();
    expect(currentVersion(db)).toBe(0);
    db.close();
  });

  it("applies pending migrations and records them", () => {
    const db = openInMemoryDatabase();
    const result = migrate(db);

    expect(result.from).toBe(0);
    expect(result.to).toBe(3);
    expect(result.applied).toEqual([1, 2, 3]);

    db.close();
  });

  it("is idempotent when run repeatedly", () => {
    const db = openInMemoryDatabase();
    migrate(db);
    const second = migrate(db);

    expect(second.applied).toEqual([]);
    expect(second.from).toBe(3);
    expect(second.to).toBe(3);

    db.close();
  });

  it("creates the expected tables", () => {
    withDatabase((db) => {
      const rows = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as Array<{ name: string }>;
      const names = rows.map((row) => row.name);

      expect(names).toContain("guild_defaults");
      expect(names).toContain("channel_configs");
      expect(names).toContain("active_sessions");
      expect(names).toContain("schema_migrations");

      // v2: durable history.
      expect(names).toContain("session_runs");
      expect(names).toContain("stage_outcomes");
      expect(names).toContain("attendance");
      expect(names).toContain("credit_segments");
      expect(names).toContain("active_run");
    });
  });
});

describe("guild defaults repository", () => {
  it("returns null when the guild has no defaults", () => {
    withDatabase((db) => {
      expect(getGuildDefaults(db, GUILD)).toBeNull();
    });
  });

  it("round-trips a partial configuration", () => {
    withDatabase((db) => {
      saveGuildDefaults(db, GUILD, { focusMinutes: 50, cyclesBeforeLongBreak: 2 });

      const stored = getGuildDefaults(db, GUILD);

      expect(stored).toEqual({ focusMinutes: 50, cyclesBeforeLongBreak: 2 });
    });
  });

  it("replaces the layer wholesale on the second save", () => {
    withDatabase((db) => {
      saveGuildDefaults(db, GUILD, { focusMinutes: 50, soundVolume: 20 });
      saveGuildDefaults(db, GUILD, { focusMinutes: 30 });

      expect(getGuildDefaults(db, GUILD)).toEqual({ focusMinutes: 30 });
    });
  });

  it("deletes the guild layer", () => {
    withDatabase((db) => {
      saveGuildDefaults(db, GUILD, { focusMinutes: 50 });

      expect(deleteGuildDefaults(db, GUILD)).toBe(true);
      expect(getGuildDefaults(db, GUILD)).toBeNull();
      expect(deleteGuildDefaults(db, GUILD)).toBe(false);
    });
  });
});

describe("channel configuration repository", () => {
  it("returns null for an unconfigured channel", () => {
    withDatabase((db) => {
      expect(getChannelConfig(db, GUILD, CHANNEL_A)).toBeNull();
    });
  });

  it("round-trips a channel override, preserving booleans", () => {
    withDatabase((db) => {
      saveChannelConfig(
        db,
        GUILD,
        CHANNEL_A,
        { focusMinutes: 30, soundEnabled: false, soundVolume: 40 },
        "999",
      );

      const stored = getChannelConfig(db, GUILD, CHANNEL_A);

      expect(stored?.config).toEqual({
        focusMinutes: 30,
        soundEnabled: false,
        soundVolume: 40,
      });
      expect(stored?.configuredBy).toBe("999");
    });
  });

  it("keeps channels in the same guild independent", () => {
    withDatabase((db) => {
      saveChannelConfig(db, GUILD, CHANNEL_A, { focusMinutes: 30 });
      saveChannelConfig(db, GUILD, CHANNEL_B, { focusMinutes: 45 });

      expect(getChannelConfig(db, GUILD, CHANNEL_A)?.config.focusMinutes).toBe(30);
      expect(getChannelConfig(db, GUILD, CHANNEL_B)?.config.focusMinutes).toBe(45);
    });
  });

  it("lists configured channels for the copy-from autocomplete", () => {
    withDatabase((db) => {
      saveChannelConfig(db, GUILD, CHANNEL_A, { focusMinutes: 30 });
      saveChannelConfig(db, GUILD, CHANNEL_B, { focusMinutes: 45 });

      const list = listChannelConfigs(db, GUILD);

      expect(list).toHaveLength(2);
      expect(list.map((entry) => entry.voiceChannelId).sort()).toEqual([CHANNEL_A, CHANNEL_B]);
    });
  });

  it("deletes a channel override", () => {
    withDatabase((db) => {
      saveChannelConfig(db, GUILD, CHANNEL_A, { focusMinutes: 30 });

      expect(deleteChannelConfig(db, GUILD, CHANNEL_A)).toBe(true);
      expect(getChannelConfig(db, GUILD, CHANNEL_A)).toBeNull();
    });
  });
});

describe("active session repository", () => {
  it("returns null when the guild has no session", () => {
    withDatabase((db) => {
      expect(getActiveSession(db, GUILD)).toBeNull();
      expect(listActiveSessions(db)).toEqual([]);
    });
  });

  it("round-trips a session including its resolved configuration", () => {
    withDatabase((db) => {
      const record = sessionRecord();
      saveActiveSession(db, record);

      expect(getActiveSession(db, GUILD)).toEqual(record);
    });
  });

  it("keeps exactly one row per guild", () => {
    withDatabase((db) => {
      saveActiveSession(db, sessionRecord({ voiceChannelId: CHANNEL_A }));
      saveActiveSession(db, sessionRecord({ voiceChannelId: CHANNEL_B, stage: "short_break" }));

      const stored = getActiveSession(db, GUILD);

      expect(stored?.voiceChannelId).toBe(CHANNEL_B);
      expect(stored?.stage).toBe("short_break");

      const count = db.prepare("SELECT COUNT(*) AS total FROM active_sessions").get() as {
        total: number;
      };
      expect(count.total).toBe(1);
    });
  });

  it("stores paused sessions with their exact remainder", () => {
    withDatabase((db) => {
      saveActiveSession(
        db,
        sessionRecord({ state: "paused", pausedRemainingMs: 90_000, stageEndsAt: null }),
      );

      const stored = getActiveSession(db, GUILD);
      expect(stored?.state).toBe("paused");
      expect(stored?.pausedRemainingMs).toBe(90_000);
    });
  });

  it("deletes a session", () => {
    withDatabase((db) => {
      saveActiveSession(db, sessionRecord());

      expect(deleteActiveSession(db, GUILD)).toBe(true);
      expect(getActiveSession(db, GUILD)).toBeNull();
      expect(deleteActiveSession(db, GUILD)).toBe(false);
    });
  });

  it("lists sessions across guilds for startup reconciliation", () => {
    withDatabase((db) => {
      saveActiveSession(db, sessionRecord());
      saveActiveSession(db, sessionRecord({ guildId: "444444444444444444" }));

      expect(listActiveSessions(db)).toHaveLength(2);
    });
  });
});

describe("durability", () => {
  it("survives closing and reopening the database file", () => {
    const directory = mkdtempSync(join(tmpdir(), "marzano-test-"));

    try {
      const first = openMigratedDatabase(directory);
      expect(first.migration.to).toBe(3);
      saveChannelConfig(first.db, GUILD, CHANNEL_A, { focusMinutes: 42 });
      saveActiveSession(first.db, sessionRecord({ completedFocusStages: 3 }));
      first.db.close();

      const second = openMigratedDatabase(directory);

      expect(currentVersion(second.db)).toBe(3);
      expect(getChannelConfig(second.db, GUILD, CHANNEL_A)?.config.focusMinutes).toBe(42);
      expect(getActiveSession(second.db, GUILD)?.completedFocusStages).toBe(3);

      second.db.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("creates the data directory when it does not exist", () => {
    const directory = mkdtempSync(join(tmpdir(), "marzano-test-"));

    try {
      const nested = join(directory, "deeply", "nested");
      const { db } = openMigratedDatabase(nested);

      expect(currentVersion(db)).toBe(3);
      db.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
