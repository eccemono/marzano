import { describe, expect, it } from "vitest";

import { WizardError, applyChannelWizard, applyGuildDefaultsWizard } from "../src/commands/wizard";
import { getChannelConfig, getGuildDefaults, saveGuildDefaults } from "../src/db/config-repository";
import { type Db, openInMemoryDatabase } from "../src/db/database";
import { migrate } from "../src/db/migrations";
import { getActiveSession, saveActiveSession } from "../src/db/session-repository";
import { BUILT_IN_DEFAULTS } from "../src/domain/config";
import { SplitError } from "../src/domain/split";
import { startSession } from "../src/domain/timer";

const GUILD = "111111111111111111";
const CHANNEL = "222222222222222222";
const OTHER = "333333333333333333";

function withDatabase<T>(run: (db: Db) => T): T {
  const db = openInMemoryDatabase();
  try {
    migrate(db);
    return run(db);
  } finally {
    db.close();
  }
}

describe("applyChannelWizard", () => {
  it("saves a split for the channel", () => {
    withDatabase((db) => {
      const result = applyChannelWizard(db, GUILD, CHANNEL, { split: "50 10 20" }, "999");

      expect(result.action).toBe("updated");
      expect(result.changed).toContain("split");
      expect(result.config).toMatchObject({
        focusMinutes: 50,
        shortBreakMinutes: 10,
        longBreakMinutes: 20,
      });

      const stored = getChannelConfig(db, GUILD, CHANNEL);
      expect(stored?.config.focusMinutes).toBe(50);
      expect(stored?.configuredBy).toBe("999");
    });
  });

  it("applies several settings in one call and reports what changed", () => {
    withDatabase((db) => {
      const result = applyChannelWizard(db, GUILD, CHANNEL, {
        split: "30 6 18",
        cycles: 3,
        sound: false,
        volume: 25,
      });

      expect(result.changed).toEqual(
        expect.arrayContaining(["split", "cycles", "sound", "volume"]),
      );
      expect(result.config).toMatchObject({
        cyclesBeforeLongBreak: 3,
        soundEnabled: false,
        soundVolume: 25,
      });
    });
  });

  it("merges into the existing channel configuration rather than replacing it", () => {
    withDatabase((db) => {
      applyChannelWizard(db, GUILD, CHANNEL, { split: "30 6 18", volume: 10 });
      applyChannelWizard(db, GUILD, CHANNEL, { sound: false });

      const stored = getChannelConfig(db, GUILD, CHANNEL);

      expect(stored?.config.focusMinutes).toBe(30);
      expect(stored?.config.soundVolume).toBe(10);
      expect(stored?.config.soundEnabled).toBe(false);
    });
  });

  it("deletes the row on reset, so the channel reads as unconfigured again", () => {
    withDatabase((db) => {
      applyChannelWizard(db, GUILD, CHANNEL, { split: "30 5 15" });

      const result = applyChannelWizard(db, GUILD, CHANNEL, { reset: true });

      expect(result.action).toBe("reset");
      expect(result.config).toBeNull();
      expect(getChannelConfig(db, GUILD, CHANNEL)).toBeNull();
    });
  });

  it("reports nothing changed when resetting a channel that was never configured", () => {
    withDatabase((db) => {
      expect(applyChannelWizard(db, GUILD, CHANNEL, { reset: true }).changed).toEqual([]);
    });
  });

  it("copies another channel's configuration", () => {
    withDatabase((db) => {
      applyChannelWizard(db, GUILD, OTHER, { split: "45 9 27", volume: 60 });

      const result = applyChannelWizard(db, GUILD, CHANNEL, { copyFromChannelId: OTHER });

      expect(result.changed).toContain("copy_from");
      expect(result.config).toMatchObject({
        focusMinutes: 45,
        shortBreakMinutes: 9,
        longBreakMinutes: 27,
        soundVolume: 60,
      });
    });
  });

  it("can copy and then override in the same call", () => {
    withDatabase((db) => {
      applyChannelWizard(db, GUILD, OTHER, { split: "45 9 27" });

      const result = applyChannelWizard(db, GUILD, CHANNEL, {
        copyFromChannelId: OTHER,
        split: "20 4 8",
      });

      expect(result.config).toMatchObject({ focusMinutes: 20, longBreakMinutes: 8 });
    });
  });

  it("rejects copying from a channel with no saved configuration", () => {
    withDatabase((db) => {
      expect(() => applyChannelWizard(db, GUILD, CHANNEL, { copyFromChannelId: OTHER })).toThrow(
        WizardError,
      );
    });
  });

  it("rejects an empty change set", () => {
    withDatabase((db) => {
      expect(() => applyChannelWizard(db, GUILD, CHANNEL, {})).toThrow(WizardError);
    });
  });

  it("rejects a malformed split and persists nothing", () => {
    withDatabase((db) => {
      expect(() => applyChannelWizard(db, GUILD, CHANNEL, { split: "nonsense" })).toThrow(
        SplitError,
      );
      expect(getChannelConfig(db, GUILD, CHANNEL)).toBeNull();
    });
  });

  it("validates the resolved configuration against the guild layer", () => {
    withDatabase((db) => {
      saveGuildDefaults(db, GUILD, { focusMinutes: 50 });

      // A 5 minute focus with a 10 minute break cannot be intended, even
      // though the channel itself only overrides the split.
      expect(() => applyChannelWizard(db, GUILD, CHANNEL, { split: "5 10 20" })).toThrow(
        /cannot be longer than the focus period/,
      );
    });
  });

  it("validates volume bounds", () => {
    withDatabase((db) => {
      expect(() => applyChannelWizard(db, GUILD, CHANNEL, { volume: 150 })).toThrow(WizardError);
    });
  });
});

describe("applyGuildDefaultsWizard", () => {
  it("saves guild defaults", () => {
    withDatabase((db) => {
      const result = applyGuildDefaultsWizard(db, GUILD, { split: "40 8 24", cycles: 5 });

      expect(result.config).toMatchObject({ focusMinutes: 40, cyclesBeforeLongBreak: 5 });
      expect(getGuildDefaults(db, GUILD)).toMatchObject({ focusMinutes: 40 });
    });
  });

  it("refuses copy and reset, which only apply to a specific channel", () => {
    withDatabase((db) => {
      expect(() => applyGuildDefaultsWizard(db, GUILD, { reset: true })).toThrow(WizardError);
      expect(() => applyGuildDefaultsWizard(db, GUILD, { copyFromChannelId: CHANNEL })).toThrow(
        WizardError,
      );
    });
  });

  it("rejects an empty change set", () => {
    withDatabase((db) => {
      expect(() => applyGuildDefaultsWizard(db, GUILD, {})).toThrow(WizardError);
    });
  });
});

describe("configuration changes versus running sessions", () => {
  it("never mutates an active session's resolved settings", () => {
    withDatabase((db) => {
      const session = startSession({
        guildId: GUILD,
        voiceChannelId: CHANNEL,
        config: BUILT_IN_DEFAULTS,
        now: 1_760_000_000_000,
      });
      saveActiveSession(db, session);

      applyChannelWizard(db, GUILD, CHANNEL, { split: "50 10 20", volume: 5 });

      const stored = getActiveSession(db, GUILD);

      expect(stored?.config.focusMinutes).toBe(BUILT_IN_DEFAULTS.focusMinutes);
      expect(stored?.config.soundVolume).toBe(BUILT_IN_DEFAULTS.soundVolume);
    });
  });
});
