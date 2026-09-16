import { describe, expect, it } from "vitest";

import { BUILT_IN_DEFAULTS } from "../src/domain/config";
import { TOMATO_FACTS } from "../src/domain/facts";
import { type TimerSession, pause, startSession, terminate } from "../src/domain/timer";
import {
  buildSessionEmbed,
  channelStatusText,
  cyclePosition,
  formatDuration,
  progressBar,
  relativeTimestamp,
} from "../src/discord/session-view";

const T0 = 1_760_000_000_000;
const MINUTE = 60_000;

function newSession(): TimerSession {
  return startSession({
    guildId: "111111111111111111",
    voiceChannelId: "222222222222222222",
    config: BUILT_IN_DEFAULTS,
    now: T0,
    // Fixed so the shuffled fact playlist is the same in every run.
    factSeed: 42,
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
    expect(progressBar(0, 100, 10)).toBe("▒▒▒▒▒▒▒▒▒▒ 0%");
    expect(progressBar(100, 100, 10)).toBe("██████████ 100%");
  });

  it("fills with blocks and reports the percentage", () => {
    expect(progressBar(50, 100, 10)).toBe("█████▒▒▒▒▒ 50%");
    expect(progressBar(30, 100, 10)).toBe("███▒▒▒▒▒▒▒ 30%");
  });

  it("quotes whole 10% steps rather than a rounded number", () => {
    // The bar and the label move together, one segment per 10%.
    expect(progressBar(33, 100, 10)).toBe("███▒▒▒▒▒▒▒ 30%");
    expect(progressBar(39, 100, 10)).toBe("███▒▒▒▒▒▒▒ 30%");
    expect(progressBar(99, 100, 10)).toBe("█████████▒ 90%");
  });

  it("clamps out-of-range input and tolerates a zero duration", () => {
    expect(progressBar(500, 100, 10)).toBe("██████████ 100%");
    expect(progressBar(-5, 100, 10)).toBe("▒▒▒▒▒▒▒▒▒▒ 0%");
    expect(progressBar(10, 0, 10)).toBe("▒▒▒▒▒▒▒▒▒▒ 0%");
  });
});

describe("cyclePosition", () => {
  it("counts the first focus period as 1 of the first window", () => {
    expect(cyclePosition(newSession())).toBe("1/4");
  });

  it("counts up within the first window", () => {
    expect(cyclePosition({ ...newSession(), completedFocusStages: 2 })).toBe("3/4");
  });

  it("expands the window instead of resetting after a long break", () => {
    // The whole point: a long session keeps counting rather than starting over,
    // so 1-4, then 5-8, then 9-12.
    expect(cyclePosition({ ...newSession(), completedFocusStages: 4 })).toBe("5/8");
    expect(cyclePosition({ ...newSession(), completedFocusStages: 8 })).toBe("9/12");
    expect(cyclePosition({ ...newSession(), completedFocusStages: 12 })).toBe("13/16");
  });

  it("keeps every position inside the window it belongs to", () => {
    const positions = Array.from({ length: 12 }, (_, index) =>
      cyclePosition({ ...newSession(), completedFocusStages: index }),
    );

    expect(positions).toEqual([
      "1/4",
      "2/4",
      "3/4",
      "4/4",
      "5/8",
      "6/8",
      "7/8",
      "8/8",
      "9/12",
      "10/12",
      "11/12",
      "12/12",
    ]);
  });

  it("credits the break to the focus period it follows", () => {
    const session = { ...newSession(), stage: "long_break" as const, completedFocusStages: 4 };

    expect(cyclePosition(session)).toBe("4/4");
  });

  it("follows a configured window size other than four", () => {
    // Clone the config: a session's config aliases BUILT_IN_DEFAULTS, so
    // assigning through it would mutate the shared constant for every other
    // test in this file.
    const session = { ...newSession(), config: { ...BUILT_IN_DEFAULTS, cyclesBeforeLongBreak: 2 } };

    expect(cyclePosition(session)).toBe("1/2");
    expect(cyclePosition({ ...session, completedFocusStages: 2 })).toBe("3/4");
  });
});

describe("relativeTimestamp", () => {
  it("renders a Discord relative countdown in whole seconds", () => {
    // The relative style, not the absolute one: the message should read as time
    // remaining, and each client keeps it current without the bot editing it.
    expect(relativeTimestamp(1_760_000_000_000)).toBe("<t:1760000000:R>");
  });

  it("rounds down, so it never names a second that has not arrived", () => {
    expect(relativeTimestamp(1_760_000_000_999)).toBe("<t:1760000000:R>");
  });
});

describe("channelStatusText", () => {
  it("names the stage and the minutes left", () => {
    const session = newSession();

    expect(channelStatusText(session, T0 + 13 * MINUTE)).toBe("Focus - 12m left");
  });

  it("says paused instead of a countdown when paused", () => {
    const paused = pause(newSession(), T0 + 10 * MINUTE);

    expect(channelStatusText(paused, T0 + 99 * MINUTE)).toBe("Focus - paused");
  });

  it("never rounds a live stage down to zero minutes", () => {
    const session = newSession();

    expect(channelStatusText(session, T0 + 25 * MINUTE - 1_000)).toBe("Focus - 1m left");
  });

  it("has nothing to say once the session has stopped", () => {
    expect(channelStatusText(terminate(newSession(), "everyone left"), T0)).toBeNull();
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

  it("counts down with a Discord relative timestamp", () => {
    const embed = buildSessionEmbed({ session: newSession(), now: T0 + 10 * MINUTE });

    expect(embed.description).toContain("<t:1760001500:R>");
    // The absolute clock-time form is deliberately gone.
    expect(embed.description).not.toContain(":t>");
  });

  it("does not carry the old auto-refresh footer", () => {
    const embed = buildSessionEmbed({ session: newSession(), now: T0 });

    expect(embed).not.toHaveProperty("footer");
  });

  it("marks a paused session and shows its held remainder", () => {
    const paused = pause(newSession(), T0 + 10 * MINUTE);
    const embed = buildSessionEmbed({ session: paused, now: T0 + 99 * MINUTE });

    expect(embed.title).toContain("(paused)");
    expect(embed.description).toContain("Paused");
    expect(embed.description).toContain("15m 00s left");
    // A paused session has no deadline, so it must not show a relative
    // timestamp - that would keep ticking and claim time is passing.
    expect(embed.description).not.toContain("<t:");
  });

  it("reports the split and the cycle position", () => {
    const session = newSession();

    expect(fieldValue(session, T0, "Split")).toBe("25/5/15");
    expect(fieldValue(session, T0, "Cycle")).toBe("1/4");
  });

  it("leaves out settings that the status message does not need", () => {
    const session = newSession();

    // Sound and the voice channel were on every embed but told the reader
    // nothing they could not already see, so they are gone.
    expect(fieldValue(session, T0, "Sound")).toBeUndefined();
    expect(fieldValue(session, T0, "Voice channel")).toBeUndefined();
  });

  it("shows a tomato fact on breaks, and none during focus", () => {
    const focus = newSession();
    expect(fieldValue(focus, T0, "\u{1F345} Tomato fact")).toBeUndefined();

    const shortBreak = { ...focus, stage: "short_break" as const, completedFocusStages: 1 };
    const fact = fieldValue(shortBreak, T0, "\u{1F345} Tomato fact");

    expect(typeof fact).toBe("string");
    expect(TOMATO_FACTS).toContain(fact);
  });

  it("gives consecutive breaks different facts", () => {
    const first = { ...newSession(), stage: "short_break" as const, completedFocusStages: 1 };
    const second = { ...first, completedFocusStages: 2 };

    expect(fieldValue(first, T0, "\u{1F345} Tomato fact")).not.toBe(
      fieldValue(second, T0, "\u{1F345} Tomato fact"),
    );
  });

  it("renders a stopped session without claiming time remains", () => {
    const stopped = terminate(newSession(), "everyone left");

    expect(buildSessionEmbed({ session: stopped, now: T0 + 999 * MINUTE }).description).toContain(
      "0m 00s left",
    );
  });

  it("is pure: the same input always renders the same output", () => {
    const session = newSession();

    expect(buildSessionEmbed({ session, now: T0 + MINUTE })).toEqual(
      buildSessionEmbed({ session, now: T0 + MINUTE }),
    );
  });
});
