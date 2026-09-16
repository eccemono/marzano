import { describe, expect, it } from "vitest";

import { applyChannelWizard } from "../src/commands/wizard";
import { getChannelConfig } from "../src/db/config-repository";
import { openInMemoryDatabase } from "../src/db/database";
import { migrate } from "../src/db/migrations";
import { getActiveSession, saveActiveSession } from "../src/db/session-repository";
import { BUILT_IN_DEFAULTS, holdsAtBoundary } from "../src/domain/config";
import { advance, resume } from "../src/domain/timer";
import { buildSessionComponents } from "../src/discord/session-components";
import { CHANNEL, GUILD, MINUTE, START, newSession } from "./helpers/harness";

/**
 * The three ways a boundary can be crossed.
 *
 * `manual` waits every time, `auto` never waits, and `semi` advances into a
 * break by itself while still holding before the next work period.
 */

function sessionWith(advanceMode: "auto" | "manual" | "semi") {
  return newSession({
    config: {
      ...BUILT_IN_DEFAULTS,
      focusMinutes: 25,
      shortBreakMinutes: 5,
      longBreakMinutes: 15,
      advanceMode,
    },
  });
}

describe("holdsAtBoundary", () => {
  it("manual holds at every boundary", () => {
    expect(holdsAtBoundary("manual", "short_break")).toBe(true);
    expect(holdsAtBoundary("manual", "focus")).toBe(true);
  });

  it("auto holds at none", () => {
    expect(holdsAtBoundary("auto", "short_break")).toBe(false);
    expect(holdsAtBoundary("auto", "focus")).toBe(false);
  });

  it("semi holds only before the next work period", () => {
    expect(holdsAtBoundary("semi", "short_break")).toBe(false);
    expect(holdsAtBoundary("semi", "long_break")).toBe(false);
    expect(holdsAtBoundary("semi", "focus")).toBe(true);
  });
});

describe("manual mode", () => {
  it("holds at the boundary and waits for Continue", () => {
    const result = advance(sessionWith("manual"), START + 25 * MINUTE);

    expect(result.transitions).toHaveLength(1);
    expect(result.session.stage).toBe("short_break");
    expect(result.session.state).toBe("paused");
    expect(result.session.awaitingContinue).toBe(true);
    expect(result.session.stageEndsAt).toBeNull();
  });

  it("advances only one boundary even when several have passed", () => {
    const result = advance(sessionWith("manual"), START + 30 * MINUTE);

    expect(result.transitions).toHaveLength(1);
    expect(result.session.stage).toBe("short_break");
    expect(result.session.awaitingContinue).toBe(true);
  });

  it("resuming after a Continue starts the next stage fresh", () => {
    const held = advance(sessionWith("manual"), START + 25 * MINUTE).session;
    const now = START + 25 * MINUTE + 10_000;

    const resumed = resume(held, now);

    expect(resumed.state).toBe("running");
    expect(resumed.awaitingContinue).toBe(false);
    expect(resumed.stageEndsAt).toBe(now + 5 * MINUTE);
  });

  it("shows a Continue button, not Resume, while waiting", () => {
    const held = advance(sessionWith("manual"), START + 25 * MINUTE).session;

    const button = buildSessionComponents(held)[0]?.components[0];
    const label = (button?.data as { label?: string } | undefined)?.label;

    expect(label).toBe("Continue");
  });

  it("is the default: a fresh config waits", () => {
    expect(BUILT_IN_DEFAULTS.advanceMode).toBe("manual");
  });
});

describe("auto mode", () => {
  it("chains several boundaries as before", () => {
    const result = advance(sessionWith("auto"), START + 30 * MINUTE);

    expect(result.transitions).toHaveLength(2);
    expect(result.session.stage).toBe("focus");
    expect(result.session.state).toBe("running");
    expect(result.session.awaitingContinue).toBe(false);
  });
});

describe("semi mode", () => {
  it("enters the break by itself when a work period ends", () => {
    const result = advance(sessionWith("semi"), START + 25 * MINUTE);

    expect(result.transitions).toHaveLength(1);
    expect(result.session.stage).toBe("short_break");
    // Running, not held: nobody has to press anything to start the break.
    expect(result.session.state).toBe("running");
    expect(result.session.awaitingContinue).toBe(false);
  });

  it("holds before the next work period so starting work is deliberate", () => {
    // Past the focus boundary (25m) and the break boundary (30m).
    const result = advance(sessionWith("semi"), START + 30 * MINUTE + 1_000);

    expect(result.transitions).toHaveLength(2);
    expect(result.session.stage).toBe("focus");
    expect(result.session.state).toBe("paused");
    expect(result.session.awaitingContinue).toBe(true);
  });
});

describe("advance mode configuration", () => {
  it("is recorded and persisted by the channel wizard", () => {
    const db = openInMemoryDatabase();
    migrate(db);

    const result = applyChannelWizard(db, GUILD, CHANNEL, { advanceMode: "semi" }, "user-1");

    expect(result.config?.advanceMode).toBe("semi");
    expect(getChannelConfig(db, GUILD, CHANNEL)?.config.advanceMode).toBe("semi");
  });

  it("leaves the setting unset when not specified, so the layer below applies", () => {
    const db = openInMemoryDatabase();
    migrate(db);

    applyChannelWizard(db, GUILD, CHANNEL, { split: "25 5 15" }, "user-1");

    expect(getChannelConfig(db, GUILD, CHANNEL)?.config.advanceMode).toBeUndefined();
  });
});

describe("advance mode persistence", () => {
  it("round-trips the awaitingContinue flag and the mode", () => {
    const db = openInMemoryDatabase();
    migrate(db);

    const session = {
      ...sessionWith("semi"),
      state: "paused" as const,
      awaitingContinue: true,
      stageEndsAt: null,
    };

    saveActiveSession(db, session);

    const loaded = getActiveSession(db, GUILD);

    expect(loaded?.awaitingContinue).toBe(true);
    expect(loaded?.config.advanceMode).toBe("semi");
  });
});
