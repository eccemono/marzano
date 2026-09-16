import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { BUILT_IN_DEFAULTS, type PomodoroConfig } from "../src/domain/config";
import {
  MAX_REPLAYED_TRANSITIONS,
  TimerError,
  advance,
  changeSessionSettings,
  changeSplit,
  elapsedMs,
  extend,
  isRunning,
  isStageComplete,
  nextStage,
  pause,
  remainingMs,
  resume,
  skip,
  stageDurationMs,
  startSession,
  terminate,
} from "../src/domain/timer";

const MINUTE = 60_000;
const T0 = 1_760_000_000_000;

const CONFIG: PomodoroConfig = { ...BUILT_IN_DEFAULTS, autoAdvance: true };

function start(now = T0, config: PomodoroConfig = CONFIG) {
  return startSession({
    guildId: "111111111111111111",
    voiceChannelId: "222222222222222222",
    config,
    now,
    // Fixed so two sessions started in a test are equal in every field; the
    // real seed is random per session.
    factSeed: 7,
  });
}

describe("timer engine purity", () => {
  it("does not import discord.js anywhere in the engine", () => {
    const source = readFileSync("src/domain/timer.ts", "utf8");

    expect(source).not.toMatch(/from\s+["']discord/i);
    expect(source).not.toMatch(/require\(["']discord/i);
  });
});

describe("stageDurationMs", () => {
  it("converts each stage's minutes to milliseconds", () => {
    expect(stageDurationMs("focus", CONFIG)).toBe(25 * MINUTE);
    expect(stageDurationMs("short_break", CONFIG)).toBe(5 * MINUTE);
    expect(stageDurationMs("long_break", CONFIG)).toBe(15 * MINUTE);
  });
});

describe("nextStage", () => {
  it("inserts a long break after the configured number of focus stages", () => {
    expect(nextStage("focus", 0, CONFIG)).toEqual({
      stage: "short_break",
      completedFocusStages: 1,
    });
    expect(nextStage("focus", 3, CONFIG)).toEqual({ stage: "long_break", completedFocusStages: 4 });
    expect(nextStage("focus", 7, CONFIG)).toEqual({ stage: "long_break", completedFocusStages: 8 });
  });

  it("always returns to focus after a break", () => {
    expect(nextStage("short_break", 2, CONFIG)).toEqual({
      stage: "focus",
      completedFocusStages: 2,
    });
    expect(nextStage("long_break", 4, CONFIG)).toEqual({
      stage: "focus",
      completedFocusStages: 4,
    });
  });
});

describe("startSession", () => {
  it("begins in focus with a deadline derived from the configuration", () => {
    const session = start();

    expect(session.stage).toBe("focus");
    expect(session.state).toBe("running");
    expect(session.completedFocusStages).toBe(0);
    expect(session.stageStartedAt).toBe(T0);
    expect(session.stageEndsAt).toBe(T0 + 25 * MINUTE);
    expect(session.stopReason).toBeNull();
  });
});

describe("remaining time", () => {
  it("is derived from the deadline rather than accumulated by ticks", () => {
    const session = start();

    expect(remainingMs(session, T0)).toBe(25 * MINUTE);
    expect(remainingMs(session, T0 + 10 * MINUTE)).toBe(15 * MINUTE);
    expect(remainingMs(session, T0 + 25 * MINUTE)).toBe(0);
    expect(remainingMs(session, T0 + 99 * MINUTE)).toBe(0);
  });

  it("tracks elapsed time and caps it at the stage length", () => {
    const session = start();

    expect(elapsedMs(session, T0 + 10 * MINUTE)).toBe(10 * MINUTE);
    expect(elapsedMs(session, T0 + 99 * MINUTE)).toBe(25 * MINUTE);
  });

  it("reports completion only once the deadline passes while running", () => {
    const session = start();

    expect(isStageComplete(session, T0 + 24 * MINUTE)).toBe(false);
    expect(isStageComplete(session, T0 + 25 * MINUTE)).toBe(true);
    expect(isStageComplete(pause(session, T0 + MINUTE), T0 + 99 * MINUTE)).toBe(false);
  });
});

describe("advance", () => {
  it("does nothing before the boundary", () => {
    const result = advance(start(), T0 + 24 * MINUTE);

    expect(result.transitions).toEqual([]);
    expect(result.session.stage).toBe("focus");
  });

  it("moves to the short break when focus ends", () => {
    const result = advance(start(), T0 + 25 * MINUTE);

    expect(result.transitions).toHaveLength(1);
    expect(result.transitions[0]).toMatchObject({ from: "focus", to: "short_break" });
    expect(result.session.stage).toBe("short_break");
    expect(result.session.completedFocusStages).toBe(1);
  });

  it("chains boundaries from the scheduled end, not from the current time", () => {
    const result = advance(start(), T0 + 25 * MINUTE);

    // The new stage starts exactly when the previous one was due to end.
    expect(result.session.stageStartedAt).toBe(T0 + 25 * MINUTE);
    expect(result.session.stageEndsAt).toBe(T0 + 30 * MINUTE);
  });

  it("takes a long break after four focus stages", () => {
    let session = start();
    const stages: string[] = [];

    for (let index = 0; index < 8; index += 1) {
      session = advance(session, session.stageEndsAt ?? 0).session;
      stages.push(session.stage);
    }

    expect(stages).toEqual([
      "short_break",
      "focus",
      "short_break",
      "focus",
      "short_break",
      "focus",
      "long_break",
      "focus",
    ]);
  });

  it("replays a long offline gap deterministically", () => {
    const result = advance(start(), T0 + 240 * MINUTE);

    expect(result.truncated).toBe(false);
    expect(result.transitions).toHaveLength(14);
    expect(result.session.stage).toBe("focus");
    expect(result.session.completedFocusStages).toBe(7);
    expect(result.session.stageStartedAt).toBe(T0 + 220 * MINUTE);
    expect(result.session.stageEndsAt).toBe(T0 + 245 * MINUTE);
  });

  it("produces the same result on repeated calls with the same inputs", () => {
    const first = advance(start(), T0 + 240 * MINUTE);
    const second = advance(start(), T0 + 240 * MINUTE);

    expect(second.session).toEqual(first.session);
    expect(second.transitions).toEqual(first.transitions);
  });

  it("stops replaying at the bound instead of spinning forever", () => {
    const tiny: PomodoroConfig = {
      ...CONFIG,
      focusMinutes: 1,
      shortBreakMinutes: 1,
      longBreakMinutes: 1,
    };

    const result = advance(start(T0, tiny), T0 + 10_000 * MINUTE, 50);

    expect(result.truncated).toBe(true);
    expect(result.transitions).toHaveLength(50);
    expect(MAX_REPLAYED_TRANSITIONS).toBeGreaterThan(50);
  });

  it("is a no-op while paused or stopped", () => {
    const paused = pause(start(), T0 + MINUTE);
    expect(advance(paused, T0 + 999 * MINUTE).transitions).toEqual([]);

    const stopped = terminate(start(), "user stopped");
    expect(advance(stopped, T0 + 999 * MINUTE).transitions).toEqual([]);
  });
});

describe("pause and resume", () => {
  it("captures the exact remaining time and clears the deadline", () => {
    const paused = pause(start(), T0 + 10 * MINUTE);

    expect(paused.state).toBe("paused");
    expect(paused.pausedRemainingMs).toBe(15 * MINUTE);
    expect(paused.stageEndsAt).toBeNull();
  });

  it("holds the remaining time constant while paused", () => {
    const paused = pause(start(), T0 + 10 * MINUTE);

    expect(remainingMs(paused, T0 + 11 * MINUTE)).toBe(15 * MINUTE);
    expect(remainingMs(paused, T0 + 5 * 60 * MINUTE)).toBe(15 * MINUTE);
  });

  it("keeps elapsed time coherent across a pause", () => {
    const paused = pause(start(), T0 + 10 * MINUTE);

    expect(elapsedMs(paused, T0 + 99 * MINUTE)).toBe(10 * MINUTE);
  });

  it("is idempotent when paused twice", () => {
    const once = pause(start(), T0 + 10 * MINUTE);
    const twice = pause(once, T0 + 20 * MINUTE);

    expect(twice).toEqual(once);
  });

  it("is a no-op when resumed while already running", () => {
    const session = start();
    expect(resume(session, T0 + MINUTE)).toEqual(session);
  });

  it("restores the remaining time on resume", () => {
    const paused = pause(start(), T0 + 10 * MINUTE);
    const resumed = resume(paused, T0 + 60 * MINUTE);

    expect(resumed.state).toBe("running");
    expect(resumed.pausedRemainingMs).toBeNull();
    expect(resumed.stageEndsAt).toBe(T0 + 60 * MINUTE + 15 * MINUTE);
    expect(remainingMs(resumed, T0 + 60 * MINUTE)).toBe(15 * MINUTE);
  });

  it("is a no-op when resuming a stopped session", () => {
    const stopped = terminate(start(), "done");
    expect(resume(stopped, T0 + MINUTE)).toEqual(stopped);
  });
});

describe("skip", () => {
  it("ends the current stage immediately and anchors the next one to now", () => {
    const { session, transition } = skip(start(), T0 + 3 * MINUTE);

    expect(transition).toMatchObject({ from: "focus", to: "short_break" });
    expect(session.stage).toBe("short_break");
    expect(session.stageStartedAt).toBe(T0 + 3 * MINUTE);
    expect(session.stageEndsAt).toBe(T0 + 8 * MINUTE);
    expect(session.completedFocusStages).toBe(1);
  });

  it("resumes running when a paused session is skipped", () => {
    const paused = pause(start(), T0 + MINUTE);
    const { session } = skip(paused, T0 + 2 * MINUTE);

    expect(session.state).toBe("running");
    expect(session.pausedRemainingMs).toBeNull();
    expect(session.stage).toBe("short_break");
  });

  it("does nothing to a stopped session", () => {
    const stopped = terminate(start(), "done");
    const result = skip(stopped, T0 + MINUTE);

    expect(result.transition).toBeNull();
    expect(result.session).toEqual(stopped);
  });
});

describe("extend", () => {
  it("pushes the deadline out while running", () => {
    const extended = extend(start(), 2 * MINUTE, T0 + MINUTE);

    expect(extended.stageEndsAt).toBe(T0 + 27 * MINUTE);
  });

  it("adds to the stored remainder while paused", () => {
    const paused = pause(start(), T0 + 10 * MINUTE);
    const extended = extend(paused, 2 * MINUTE, T0 + 10 * MINUTE);

    expect(extended.pausedRemainingMs).toBe(17 * MINUTE);
    expect(extended.stageEndsAt).toBeNull();
  });

  it("rejects zero, negative and non-finite durations", () => {
    const session = start();

    expect(() => extend(session, 0, T0)).toThrow(TimerError);
    expect(() => extend(session, -MINUTE, T0)).toThrow(TimerError);
    expect(() => extend(session, Number.NaN, T0)).toThrow(TimerError);
  });

  it("does nothing to a stopped session", () => {
    const stopped = terminate(start(), "done");
    expect(extend(stopped, MINUTE, T0)).toEqual(stopped);
  });
});

describe("changeSplit", () => {
  it("leaves the running stage's deadline untouched", () => {
    const session = start();
    const changed = changeSplit(session, {
      focusMinutes: 50,
      shortBreakMinutes: 10,
      longBreakMinutes: 20,
    });

    expect(changed.stageEndsAt).toBe(session.stageEndsAt);
    expect(changed.config.focusMinutes).toBe(50);
  });

  it("applies the new durations from the next stage onwards", () => {
    const changed = changeSplit(start(), {
      focusMinutes: 50,
      shortBreakMinutes: 10,
      longBreakMinutes: 20,
    });

    const advanced = advance(changed, changed.stageEndsAt ?? 0).session;

    expect(advanced.stage).toBe("short_break");
    expect(advanced.stageEndsAt).toBe((changed.stageEndsAt ?? 0) + 10 * MINUTE);
  });

  it("does not mutate the session or configuration it was given", () => {
    const session = start();
    const originalConfig = { ...session.config };

    changeSplit(session, { focusMinutes: 50, shortBreakMinutes: 10, longBreakMinutes: 20 });

    expect(session.config).toEqual(originalConfig);
    expect(session.config.focusMinutes).toBe(25);
  });
});

describe("changeSessionSettings", () => {
  it("changes sound and cycle settings without touching the split", () => {
    const changed = changeSessionSettings(start(), { soundEnabled: false, soundVolume: 10 });

    expect(changed.config.soundEnabled).toBe(false);
    expect(changed.config.soundVolume).toBe(10);
    expect(changed.config.focusMinutes).toBe(CONFIG.focusMinutes);
    expect(changed.config.cyclesBeforeLongBreak).toBe(CONFIG.cyclesBeforeLongBreak);
  });
});

describe("terminate", () => {
  it("clears the deadline and records why the session stopped", () => {
    const stopped = terminate(start(), "everyone left the channel");

    expect(stopped.state).toBe("stopped");
    expect(stopped.stageEndsAt).toBeNull();
    expect(stopped.pausedRemainingMs).toBeNull();
    expect(stopped.stopReason).toBe("everyone left the channel");
    expect(remainingMs(stopped, T0 + MINUTE)).toBe(0);
    expect(isRunning(stopped)).toBe(false);
  });
});
