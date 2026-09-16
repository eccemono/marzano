import { describe, expect, it } from "vitest";

import { getChannelConfig, saveChannelConfig } from "../src/db/config-repository";
import { openInMemoryDatabase } from "../src/db/database";
import { migrate } from "../src/db/migrations";
import type { HandlerDeps } from "../src/discord/handlers";
import { planStart } from "../src/discord/handlers";
import { CHANNEL, GUILD } from "./helpers/harness";

/**
 * The resolution rules behind starting a session.
 *
 * `planStart` only reads the database, so the rest of the handler's
 * dependencies are irrelevant here and deliberately not provided.
 */
function deps(db: ReturnType<typeof openInMemoryDatabase>): HandlerDeps {
  return { db } as unknown as HandlerDeps;
}

function request(splitInput: string | null) {
  return {
    guildId: GUILD,
    textChannelId: CHANNEL,
    voiceChannelId: CHANNEL,
    splitInput,
  };
}

describe("planStart", () => {
  it("lets the split given on the command override the channel's saved config", () => {
    // The bug: the saved channel config was applied *after* the command's split,
    // so `/start 2 2 2` in a channel saved as 1/1/1 ran 1/1/1. What the caller
    // just typed is the most specific thing anybody said.
    const db = openInMemoryDatabase();
    migrate(db);
    saveChannelConfig(db, GUILD, CHANNEL, {
      focusMinutes: 1,
      shortBreakMinutes: 1,
      longBreakMinutes: 1,
    });

    const plan = planStart(deps(db), request("2 2 2"));

    expect(plan.kind).toBe("ready");
    if (plan.kind !== "ready") return;

    expect(plan.config.focusMinutes).toBe(2);
    expect(plan.config.shortBreakMinutes).toBe(2);
    expect(plan.config.longBreakMinutes).toBe(2);
  });

  it("still takes the other settings from the saved config", () => {
    // Only the split is overridden; everything the command did not mention is
    // still the channel's.
    const db = openInMemoryDatabase();
    migrate(db);
    saveChannelConfig(db, GUILD, CHANNEL, {
      focusMinutes: 1,
      shortBreakMinutes: 1,
      longBreakMinutes: 1,
      cyclesBeforeLongBreak: 7,
      soundVolume: 35,
    });

    const plan = planStart(deps(db), request("2 2 2"));

    expect(plan.kind).toBe("ready");
    if (plan.kind !== "ready") return;

    expect(plan.config.cyclesBeforeLongBreak).toBe(7);
    expect(plan.config.soundVolume).toBe(35);
  });

  it("uses the saved config when the command gives no split", () => {
    const db = openInMemoryDatabase();
    migrate(db);
    saveChannelConfig(db, GUILD, CHANNEL, {
      focusMinutes: 3,
      shortBreakMinutes: 3,
      longBreakMinutes: 3,
    });

    const plan = planStart(deps(db), request(null));

    expect(plan.kind).toBe("ready");
    if (plan.kind !== "ready") return;

    expect(plan.config.focusMinutes).toBe(3);
    expect(getChannelConfig(db, GUILD, CHANNEL)?.config.focusMinutes).toBe(3);
  });

  it("asks for setup when there is no split and nothing saved", () => {
    const db = openInMemoryDatabase();
    migrate(db);

    expect(planStart(deps(db), request(null)).kind).toBe("open-setup");
  });
});
