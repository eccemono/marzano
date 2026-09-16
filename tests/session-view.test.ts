import { describe, expect, it } from "vitest";

import { BUILT_IN_DEFAULTS } from "../src/domain/config";
import { type TimerSession, pause, startSession, terminate } from "../src/domain/timer";
import {
  buildSessionEmbed,
  cyclePosition,
  formatDuration,
  progressBar,
} from "../src/discord/session-view";

const T0 = 1_760_000_000_000;
const MINUTE = 60_000;

function newSession(): TimerSession {
  return startSession({
    guildId: "111111111111111111",
    voiceChannelId: "222222222222222222",
    config: BUILT_IN_DEFAULTS,
    now: T0,
  });
}

function fieldValue(session: TimerSession, now: number, name: string): string | undefined {
  return buildSessionEmbed({ session, now }).fields.find((field) => field.name === name)?.value;
}

describe("formatDuration", () => {
  it("formats sub-hour durations as minutes and seconds", () => {
    expect(formatDuration(0)).toBe("0m 00s");
    expect(formatDuration(90_000)).toBe("1m 30s");
    expect(formatDuration(25 * MINUTE)).toBe("25m 00s");
  });

  it("formats an hour or more as hours and minutes", () => {
    expect(formatDuration(3_600_000)).toBe("1h 00m");
    expect(formatDuration(3_900_000)).toBe("1h 05m");
  });

  it("never shows a negative duration", () => {
    expect(formatDuration(-5_000)).toBe("0m 00s");
  });
});

describe("progressBar", () => {
  it("is empty at the start and full at the end", () => {
    expect(progressBar(0, 100, 10)).toBe("[----------]");
    expect(progressBar(100, 100, 10)).toBe("[##########]");
  });

  it("fills proportionally", () => {
    expect(progressBar(50, 100, 10)).toBe("[#####-----]");
  });

  it("clamps out-of-range input and tolerates a zero duration", () => {
    expect(progressBar(500, 100, 10)).toBe("[##########]");
    expect(progressBar(-5, 100, 10)).toBe("[----------]");
    expect(progressBar(10, 0, 10)).toBe("[----------]");
  });
});

describe("cyclePosition", () => {
  it("counts completed focus stages within the cycle", () => {
    expect(cyclePosition(newSession())).toBe("0 of 4");
    expect(cyclePosition({ ...newSession(), completedFocusStages: 2 })).toBe("2 of 4");
  });

  it("reports the completed cycle during a long break", () => {
    const session = { ...newSession(), stage: "long_break" as const, completedFocusStages: 4 };

    expect(cyclePosition(session)).toBe("4 of 4");
  });
});

describe("buildSessionEmbed", () => {
  it("labels every stage distinctly", () => {
    const focus = buildSessionEmbed({ session: newSession(), now: T0 });
    expect(focus.title).toContain("Focus");

    const shortBreak = buildSessionEmbed({
      session: { ...newSession(), stage: "short_break" },
      now: T0,
    });
    expect(shortBreak.title).toContain("Short break");

    const longBreak = buildSessionEmbed({
      session: { ...newSession(), stage: "long_break" },
      now: T0,
    });
    expect(longBreak.title).toContain("Long break");
  });

  it("shows remaining time derived from the deadline", () => {
    const embed = buildSessionEmbed({ session: newSession(), now: T0 + 10 * MINUTE });

    expect(embed.description).toContain("15m 00s remaining");
  });

  it("marks a paused session and shows its held remainder", () => {
    const paused = pause(newSession(), T0 + 10 * MINUTE);
    const embed = buildSessionEmbed({ session: paused, now: T0 + 99 * MINUTE });

    expect(embed.title).toContain("(paused)");
    expect(embed.description).toContain("Paused");
    expect(embed.description).toContain("15m 00s left");
    expect(embed.footer.text).toMatch(/Paused/i);
  });

  it("reports the split, cycle, sound state and voice channel", () => {
    const session = newSession();

    expect(fieldValue(session, T0, "Split")).toBe("25/5/15");
    expect(fieldValue(session, T0, "Cycle")).toBe("0 of 4");
    expect(fieldValue(session, T0, "Sound")).toBe("on (80%)");
    expect(fieldValue(session, T0, "Voice channel")).toBe("<#222222222222222222>");
  });

  it("reflects sound being turned off", () => {
    const session = newSession();
    session.config.soundEnabled = false;

    expect(fieldValue(session, T0, "Sound")).toBe("off");
  });

  it("renders a stopped session without claiming time remains", () => {
    const stopped = terminate(newSession(), "everyone left");

    expect(buildSessionEmbed({ session: stopped, now: T0 + 999 * MINUTE }).description).toContain(
      "0m 00s remaining",
    );
  });

  it("is pure: the same input always renders the same output", () => {
    const session = newSession();

    expect(buildSessionEmbed({ session, now: T0 + MINUTE })).toEqual(
      buildSessionEmbed({ session, now: T0 + MINUTE }),
    );
  });
});
