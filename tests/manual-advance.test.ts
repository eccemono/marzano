import { describe, expect, it } from "vitest";

import { applyChannelWizard } from "../src/commands/wizard";
import { getChannelConfig } from "../src/db/config-repository";
import { openInMemoryDatabase } from "../src/db/database";
import { migrate } from "../src/db/migrations";
import { getActiveSession, saveActiveSession } from "../src/db/session-repository";
import { BUILT_IN_DEFAULTS } from "../src/domain/config";
import { advance, resume } from "../src/domain/timer";
import { buildSessionComponents } from "../src/discord/session-components";
import { CHANNEL, GUILD, MINUTE, START, newSession } from "./helpers/harness";

/** A manual-mode session: focus 25, short break 5. */
function manualSession() {
  return newSession({
    config: {
      ...BUILT_IN_DEFAULTS,
      focusMinutes: 25,
      shortBreakMinutes: 5,
      longBreakMinutes: 15,
      autoAdvance: false,
    },
  });
}

describe("manual advance", () => {
  it("holds at the boundary and waits for Continue when auto-advance is off", () => {
    const result = advance(manualSession(), START + 25 * MINUTE);

    expect(result.transitions).toHaveLength(1);
    expect(result.session.stage).toBe("short_break");
    expect(result.session.state).toBe("paused");
    expect(result.session.awaitingContinue).toBe(true);
    expect(result.session.stageEndsAt).toBeNull();
  });

  it("advances only one boundary even when several have passed", () => {
    const result = advance(manualSession(), START + 30 * MINUTE);

    expect(result.transitions).toHaveLength(1);
    expect(result.session.stage).toBe("short_break");
    expect(result.session.awaitingContinue).toBe(true);
  });

  it("resuming after a Continue starts the next stage fresh", () => {
    const held = advance(manualSession(), START + 25 * MINUTE).session;
    const now = START + 25 * MINUTE + 10_000;

    const resumed = resume(held, now);

    expect(resumed.state).toBe("running");
    expect(resumed.awaitingContinue).toBe(false);
    expect(resumed.stageEndsAt).toBe(now + 5 * MINUTE);
  });

  it("shows a Continue button, not Resume, while waiting", () => {
    const held = advance(manualSession(), START + 25 * MINUTE).session;

    const button = buildSessionComponents(held)[0]?.components[0];
    const label = (button?.data as { label?: string } | undefined)?.label;

    expect(label).toBe("Continue");
  });

  it("auto-advance still chains several boundaries as before", () => {
    const auto = newSession({ config: { ...BUILT_IN_DEFAULTS, autoAdvance: true } });

    const result = advance(auto, START + 30 * MINUTE);

    expect(result.transitions).toHaveLength(2);
    expect(result.session.stage).toBe("focus");
    expect(result.session.state).toBe("running");
    expect(result.session.awaitingContinue).toBe(false);
  });

  it("defaults to manual: a fresh config does not auto-advance", () => {
    expect(BUILT_IN_DEFAULTS.autoAdvance).toBe(false);
  });
});

describe("auto-advance configuration", () => {
  it("is recorded and persisted by the channel wizard", () => {
    const db = openInMemoryDatabase();
    migrate(db);

    const result = applyChannelWizard(db, GUILD, CHANNEL, { auto: true }, "user-1");

    expect(result.config?.autoAdvance).toBe(true);
    expect(getChannelConfig(db, GUILD, CHANNEL)?.config.autoAdvance).toBe(true);
  });

  it("defaults to manual when not specified", () => {
    const db = openInMemoryDatabase();
    migrate(db);

    applyChannelWizard(db, GUILD, CHANNEL, { split: "25 5 15" }, "user-1");

    expect(getChannelConfig(db, GUILD, CHANNEL)?.config.autoAdvance).toBeUndefined();
  });
});

describe("manual-advance persistence", () => {
  it("round-trips the awaitingContinue flag and the auto-advance setting", () => {
    const db = openInMemoryDatabase();
    migrate(db);

    const session = {
      ...manualSession(),
      state: "paused" as const,
      awaitingContinue: true,
      stageEndsAt: null,
    };

    saveActiveSession(db, session);

    const loaded = getActiveSession(db, GUILD);

    expect(loaded?.awaitingContinue).toBe(true);
    expect(loaded?.config.autoAdvance).toBe(false);
  });
});
