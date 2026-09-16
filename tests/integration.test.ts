import { describe, expect, it } from "vitest";

import { getActiveSession, saveActiveSession } from "../src/db/session-repository";
import { pause, skip } from "../src/domain/timer";
import { GuildSerializer } from "../src/domain/serializer";
import { CHANNEL, GUILD, MINUTE, START, newSession, setup } from "./helpers/harness";

/**
 * Whole-session integration tests.
 *
 * These drive a session through an entire multi-cycle lifetime and through the
 * failure modes that only show up in production, using an accelerated clock so
 * nothing depends on wall-clock time.
 */

const FOCUS = 25 * MINUTE;
const SHORT = 5 * MINUTE;
const LONG = 15 * MINUTE;

describe("a full multi-cycle session", () => {
  it("walks focus, breaks and the long break in order, asserting every transition", async () => {
    const { db, supervisor, timers, voice } = setup();

    const session = newSession({
      config: {
        focusMinutes: 25,
        shortBreakMinutes: 5,
        longBreakMinutes: 15,
        cyclesBeforeLongBreak: 4,
        soundEnabled: true,
        soundVolume: 80,
        advanceMode: "auto",
      },
    });
    await supervisor.begin(session);

    expect(getActiveSession(db, GUILD)?.stage).toBe("focus");

    // Four focus periods, three short breaks, then a long break.
    const expected = [
      { after: FOCUS, stage: "short_break", cycles: 1 },
      { after: SHORT, stage: "focus", cycles: 1 },
      { after: FOCUS, stage: "short_break", cycles: 2 },
      { after: SHORT, stage: "focus", cycles: 2 },
      { after: FOCUS, stage: "short_break", cycles: 3 },
      { after: SHORT, stage: "focus", cycles: 3 },
      { after: FOCUS, stage: "long_break", cycles: 4 },
    ];

    for (const step of expected) {
      await timers.advanceBy(step.after);

      const current = getActiveSession(db, GUILD);
      expect(current?.stage, `after a ${step.after / MINUTE}m stage`).toBe(step.stage);
      expect(current?.completedFocusStages).toBe(step.cycles);
    }

    // Seven boundaries, seven bells - and the start cue still played only once.
    expect(voice.transitions).toBe(7);
    expect(voice.startCues).toBe(1);

    // The long break is now running and will hand back to focus.
    await timers.advanceBy(LONG);
    expect(getActiveSession(db, GUILD)?.stage).toBe("focus");
    expect(getActiveSession(db, GUILD)?.completedFocusStages).toBe(4);
  });

  it("keeps the schedule on its original lattice after a slow wake", async () => {
    // Waking late must not push every later boundary out by the delay.
    const { db, supervisor, timers } = setup();
    await supervisor.begin(newSession());

    // The timer fires 3 minutes late.
    await timers.advanceTo(START + FOCUS + 3 * MINUTE);

    const session = getActiveSession(db, GUILD);
    expect(session?.stage).toBe("short_break");
    // The break started on its boundary, not when we noticed.
    expect(session?.stageStartedAt).toBe(START + FOCUS);
  });
});

describe("restart mid-stage", () => {
  it("recovers the stage, remaining time and cycle", async () => {
    const first = setup();
    await first.supervisor.begin(newSession());

    // Ten minutes into the focus period the process is killed.
    first.timers.now = START + 10 * MINUTE;

    // A new process starts against the same database and clock.
    const second = setup({ db: first.db, timers: first.timers });
    await second.supervisor.recover();

    const recovered = getActiveSession(first.db, GUILD);
    expect(recovered?.stage).toBe("focus");
    expect(recovered?.completedFocusStages).toBe(0);
    expect(recovered?.state).toBe("running");
    // 15 of the 25 focus minutes remain.
    expect((recovered?.stageEndsAt ?? 0) - first.timers.now).toBe(15 * MINUTE);

    // And the resumed session still transitions correctly at the boundary.
    await first.timers.advanceBy(15 * MINUTE);
    const after = getActiveSession(first.db, GUILD);
    expect(after?.stage).toBe("short_break");
    expect(after?.completedFocusStages).toBe(1);
  });

  it("catches up across boundaries missed while offline, without bells", async () => {
    const first = setup();
    await first.supervisor.begin(newSession());

    // The process is down for 40 minutes: focus ends, the break ends.
    first.timers.now = START + 40 * MINUTE;

    const second = setup({ db: first.db, timers: first.timers });
    const report = await second.supervisor.recover();

    expect(report.transitionsReplayed).toBeGreaterThan(0);
    expect(second.voice.transitions).toBe(0); // no replay of bells
    expect(second.voice.startCues).toBe(0);

    const recovered = getActiveSession(first.db, GUILD);
    expect(recovered?.stage).toBe("focus");
    expect(recovered?.completedFocusStages).toBe(1);
  });

  it("resumes without a duplicate start cue", async () => {
    const first = setup();
    await first.supervisor.begin(newSession());
    first.timers.now = START + 5 * MINUTE;

    const second = setup({ db: first.db, timers: first.timers });
    await second.supervisor.recover();

    expect(second.voice.startCues).toBe(0);
    expect(second.voice.joins).toEqual([CHANNEL]);
  });
});

describe("concurrent interactions", () => {
  it("serialises pause and skip so exactly one transition happens", async () => {
    const { db, supervisor } = setup();
    await supervisor.begin(newSession());

    const serializer = new GuildSerializer();
    let transitions = 0;

    const doPause = () => {
      const current = getActiveSession(db, GUILD);
      if (!current) return;
      saveActiveSession(db, pause(current, START + MINUTE));
    };

    const doSkip = () => {
      const current = getActiveSession(db, GUILD);
      if (!current) return;
      const result = skip(current, START + MINUTE);
      if (result.transition) transitions += 1;
      saveActiveSession(db, result.session);
    };

    // Both interactions arrive in the same tick.
    await Promise.all([serializer.run(GUILD, doPause), serializer.run(GUILD, doSkip)]);

    // The skip moved the session on; the pause applied to what it actually
    // found, rather than clobbering the skip with a stale read.
    const session = getActiveSession(db, GUILD);
    expect(transitions).toBe(1);
    expect(session?.stage).toBe("short_break");
    expect(session?.completedFocusStages).toBe(1);
  });

  it("demonstrates the lost update without serialisation", () => {
    // This is what the serializer exists to prevent: two read-modify-write
    // cycles interleaved so the later write silently discards the earlier one.
    const { db } = setup();
    saveActiveSession(db, newSession());

    const readByPause = getActiveSession(db, GUILD);
    const readBySkip = getActiveSession(db, GUILD);
    if (!readByPause || !readBySkip) throw new Error("expected a session to exist");

    // Skip writes first...
    const skipped = skip(readBySkip, START + MINUTE);
    saveActiveSession(db, skipped.session);

    // ...then pause writes the state it read before the skip, losing it.
    saveActiveSession(db, pause(readByPause, START + MINUTE));

    const session = getActiveSession(db, GUILD);
    expect(session?.stage).toBe("focus"); // the skip was lost
    expect(session?.state).toBe("paused");
  });

  it("keeps different guilds independent", async () => {
    const { db, supervisor } = setup();
    await supervisor.begin(newSession());
    await supervisor.begin(
      newSession({ guildId: "444444444444444444", voiceChannelId: "555555555555555555" }),
    );

    // One guild stops; the other keeps running.
    await supervisor.stop(GUILD, "stopped by a participant");

    expect(getActiveSession(db, GUILD)).toBeNull();
    expect(getActiveSession(db, "444444444444444444")).not.toBeNull();
  });
});
