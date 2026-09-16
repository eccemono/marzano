import { describe, expect, it, vi } from "vitest";

import { openInMemoryDatabase } from "../src/db/database";
import { migrate } from "../src/db/migrations";
import {
  getActiveSession,
  listActiveSessions,
  saveActiveSession,
} from "../src/db/session-repository";
import { BUILT_IN_DEFAULTS } from "../src/domain/config";
import { pause, startSession, type TimerSession } from "../src/domain/timer";
import type { SessionPresenter } from "../src/discord/session-presenter";
import { createLogger } from "../src/logger";
import type { ScheduleFn, TimerHandle, VoiceAudience } from "../src/session/ports";
import { SessionSupervisor } from "../src/session/supervisor";
import type { SessionVoice } from "../src/voice/manager";

const GUILD = "111111111111111111";
const GUILD_B = "444444444444444444";
const CHANNEL = "222222222222222222";
const MINUTE = 60_000;
const START = 1_760_000_000_000;

function silentLogger() {
  return createLogger({ level: "error", sink: () => {} });
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * A controllable clock and timer queue.
 *
 * Session behaviour is almost entirely about time, so the tests drive time
 * directly rather than sleeping. `advanceTo` moves the clock and fires whatever
 * has come due in order.
 */
class FakeTimers {
  now = START;
  private pending: { id: number; at: number; fn: () => void }[] = [];
  private nextId = 1;
  /** Delays requested, in order, for assertions about scheduling. */
  readonly delays: number[] = [];

  readonly schedule: ScheduleFn = (delayMs: number, fn: () => void): TimerHandle => {
    const entry = { id: this.nextId++, at: this.now + delayMs, fn };
    this.pending.push(entry);
    this.delays.push(delayMs);
    return {
      cancel: () => {
        this.pending = this.pending.filter((candidate) => candidate.id !== entry.id);
      },
    };
  };

  get pendingCount(): number {
    return this.pending.length;
  }

  async advanceTo(instant: number): Promise<void> {
    this.now = instant;
    const due = this.pending.filter((entry) => entry.at <= this.now);
    this.pending = this.pending.filter((entry) => entry.at > this.now);

    for (const entry of due) entry.fn();
    await flush();
  }
}

class FakeVoice {
  joins: string[] = [];
  leaves = 0;
  startCues = 0;
  transitions = 0;

  async join(session: { voiceChannelId: string }): Promise<boolean> {
    this.joins.push(session.voiceChannelId);
    return true;
  }
  async leave(): Promise<void> {
    this.leaves += 1;
  }
  async announceStart(): Promise<void> {
    this.startCues += 1;
  }
  async announceTransition(): Promise<void> {
    this.transitions += 1;
  }
}

class FakePresenter {
  renders: TimerSession[] = [];
  nextMessageId = "message-1";

  async render(session: TimerSession) {
    this.renders.push(session);
    return { messageId: session.statusMessageId ?? this.nextMessageId, replaced: false };
  }
}

class FakeAudience implements VoiceAudience {
  humans: string[] | null = ["user-1"];
  exists = true;

  async channelExists(): Promise<boolean> {
    return this.exists;
  }
  async humanMembers(): Promise<string[] | null> {
    return this.humans;
  }
}

function setup(options: { graceMs?: number } = {}) {
  const db = openInMemoryDatabase();
  migrate(db);
  const timers = new FakeTimers();
  const voice = new FakeVoice();
  const presenter = new FakePresenter();
  const audience = new FakeAudience();

  const supervisor = new SessionSupervisor({
    db,
    voice: voice as unknown as SessionVoice,
    presenter: presenter as unknown as SessionPresenter,
    audience,
    logger: silentLogger(),
    now: () => timers.now,
    schedule: (delayMs, fn) => timers.schedule(delayMs, fn),
    ...(options.graceMs === undefined ? {} : { graceMs: options.graceMs }),
  });

  return { db, timers, voice, presenter, audience, supervisor };
}

function newSession(overrides: Partial<TimerSession> = {}): TimerSession {
  return {
    ...startSession({
      guildId: GUILD,
      voiceChannelId: CHANNEL,
      textChannelId: CHANNEL,
      config: { ...BUILT_IN_DEFAULTS, focusMinutes: 25, shortBreakMinutes: 5 },
      now: START,
    }),
    ...overrides,
  };
}

describe("begin", () => {
  it("persists the session, schedules its first wake and plays the cue", async () => {
    const { db, timers, voice, supervisor } = setup();

    await supervisor.begin(newSession());

    expect(getActiveSession(db, GUILD)).not.toBeNull();
    expect(timers.pendingCount).toBe(1);
    expect(timers.delays[0]).toBe(25 * MINUTE);
    await flush();
    expect(voice.startCues).toBe(1);
  });
});

describe("wake", () => {
  it("advances across an elapsed boundary, persists it and rings once", async () => {
    const { db, timers, voice, supervisor } = setup();
    await supervisor.begin(newSession());

    await timers.advanceTo(START + 25 * MINUTE);

    const session = getActiveSession(db, GUILD);
    expect(session?.stage).toBe("short_break");
    expect(session?.completedFocusStages).toBe(1);
    expect(voice.transitions).toBe(1);
    expect(voice.startCues).toBe(1); // the start cue is never replayed
  });

  it("persists the transition BEFORE scheduling the next wake", async () => {
    // The ordering is the crash-safety property: if the process dies between
    // persisting and scheduling, the session is merely behind and catches up.
    // The reverse order could double-apply a boundary.
    const { db, supervisor, timers } = setup();
    await supervisor.begin(newSession());

    const observedAtScheduleTime: string[] = [];
    const original = timers.schedule;
    vi.spyOn(timers, "schedule").mockImplementation((delayMs, fn) => {
      const session = getActiveSession(db, GUILD);
      observedAtScheduleTime.push(`${session?.stage}/${session?.completedFocusStages}`);
      return original(delayMs, fn);
    });

    await timers.advanceTo(START + 25 * MINUTE);

    // By the time the next wake was scheduled, the advanced state was already
    // on disk - not still in memory.
    expect(observedAtScheduleTime).toContain("short_break/1");
  });

  it("collapses several missed boundaries into a single bell", async () => {
    const { db, voice, supervisor, timers } = setup();
    await supervisor.begin(newSession());

    // Two whole cycles pass without the scheduler firing.
    await timers.advanceTo(START + 25 * MINUTE + 5 * MINUTE + 25 * MINUTE);

    const session = getActiveSession(db, GUILD);
    expect(session?.completedFocusStages).toBe(2);
    expect(voice.transitions).toBe(1);
  });

  it("does not wake a paused session", async () => {
    const { db, supervisor } = setup();
    const paused = pause(newSession(), START + MINUTE);
    saveActiveSession(db, paused);

    const outcome = await supervisor.wake(GUILD, { announce: true });

    expect(outcome.transitions).toBe(0);
    expect(getActiveSession(db, GUILD)?.state).toBe("paused");
  });

  it("is a no-op for a guild with no session", async () => {
    const { supervisor } = setup();

    const outcome = await supervisor.wake(GUILD, { announce: true });

    expect(outcome.transitions).toBe(0);
    expect(outcome.stopped).toBe(false);
  });
});

describe("recovery", () => {
  it("replays elapsed boundaries without ringing, and reports how many it skipped", async () => {
    const { db, voice, presenter, supervisor, timers } = setup();

    // A session that has been sitting in the database since before the restart.
    saveActiveSession(db, newSession());
    timers.now = START + 25 * MINUTE + 5 * MINUTE + 25 * MINUTE;

    const report = await supervisor.recover();

    // focus 25 -> break 5 -> focus 25: three boundaries have landed, and the
    // third lands exactly on `now`, which counts.
    expect(report.resumed).toBe(1);
    expect(report.transitionsReplayed).toBe(3);
    expect(report.bellsSkipped).toBe(3);
    expect(voice.transitions).toBe(0); // no bells replayed
    expect(voice.startCues).toBe(0);
    expect(voice.joins).toEqual([CHANNEL]);
    expect(presenter.renders.length).toBeGreaterThan(0);
    expect(getActiveSession(db, GUILD)?.stage).toBe("short_break");
  });

  it("recovers a paused session with its exact remaining duration", async () => {
    const { db, supervisor, timers } = setup();
    const paused = pause(newSession(), START + 10 * MINUTE); // 15 minutes left
    saveActiveSession(db, paused);

    timers.now = START + 10 * 60 * MINUTE; // a long time later

    const report = await supervisor.recover();

    expect(report.resumedPaused).toBe(1);
    expect(report.transitionsReplayed).toBe(0);
    const session = getActiveSession(db, GUILD);
    expect(session?.state).toBe("paused");
    expect(session?.pausedRemainingMs).toBe(15 * MINUTE);
  });

  it("stops a session whose voice channel is gone, recording why", async () => {
    const { db, audience, supervisor } = setup();
    saveActiveSession(db, newSession());
    audience.exists = false;

    const report = await supervisor.recover();

    expect(report.unrecoverable).toBe(1);
    // The row is released so the guild can start a new session.
    expect(listActiveSessions(db)).toHaveLength(0);
  });

  it("stops a session when nobody is left in the channel", async () => {
    const { db, audience, supervisor } = setup();
    saveActiveSession(db, newSession());
    audience.humans = [];

    const report = await supervisor.recover();

    expect(report.unrecoverable).toBe(1);
    expect(listActiveSessions(db)).toHaveLength(0);
  });

  it("does not reconnect when presence cannot be determined", async () => {
    // "I could not tell" must not be treated as "nobody is here".
    const { db, audience, supervisor, voice } = setup();
    saveActiveSession(db, newSession());
    audience.humans = null;

    const report = await supervisor.recover();

    expect(report.unrecoverable).toBe(0);
    expect(report.resumed).toBe(1);
    expect(voice.joins).toEqual([CHANNEL]);
  });

  it("clears stopped residue so the guild can start again", async () => {
    const { db, supervisor } = setup();
    saveActiveSession(db, {
      ...newSession(),
      state: "stopped",
      stopReason: "stopped by a participant",
    });

    await supervisor.recover();

    expect(listActiveSessions(db)).toHaveLength(0);
  });

  it("recovers guilds independently", async () => {
    const { db, supervisor } = setup();
    saveActiveSession(db, newSession());
    saveActiveSession(db, newSession({ guildId: GUILD_B, voiceChannelId: "555555555555555555" }));

    const report = await supervisor.recover();

    expect(report.resumed).toBe(2);
    expect(supervisor.isScheduled(GUILD)).toBe(true);
    expect(supervisor.isScheduled(GUILD_B)).toBe(true);
  });
});

describe("grace period", () => {
  it("starts a grace period when the last human leaves", async () => {
    const { audience, supervisor } = setup();
    await supervisor.begin(newSession());
    audience.humans = [];

    await supervisor.presenceChanged(GUILD);

    expect(supervisor.isGracePending(GUILD)).toBe(true);
  });

  it("cancels the grace period when someone returns", async () => {
    const { audience, supervisor } = setup();
    await supervisor.begin(newSession());
    audience.humans = [];

    await supervisor.presenceChanged(GUILD);
    expect(supervisor.isGracePending(GUILD)).toBe(true);

    audience.humans = ["user-2"];
    await supervisor.presenceChanged(GUILD);

    expect(supervisor.isGracePending(GUILD)).toBe(false);
  });

  it("does not start a grace period while someone is present", async () => {
    const { supervisor } = setup();
    await supervisor.begin(newSession());

    await supervisor.presenceChanged(GUILD);

    expect(supervisor.isGracePending(GUILD)).toBe(false);
  });

  it("does not start a grace period when presence is unknown", async () => {
    const { audience, supervisor } = setup();
    await supervisor.begin(newSession());
    audience.humans = null;

    await supervisor.presenceChanged(GUILD);

    expect(supervisor.isGracePending(GUILD)).toBe(false);
  });

  it("ends the session when the grace period expires with nobody back", async () => {
    const { db, audience, voice, supervisor, timers } = setup({ graceMs: 60_000 });
    await supervisor.begin(newSession());
    audience.humans = [];

    await supervisor.presenceChanged(GUILD);
    await timers.advanceTo(timers.now + 60_000);

    expect(listActiveSessions(db)).toHaveLength(0);
    expect(voice.leaves).toBe(1);
  });

  it("does not end the session if someone returns before the grace expires", async () => {
    const { db, audience, voice, supervisor, timers } = setup({ graceMs: 60_000 });
    await supervisor.begin(newSession());
    audience.humans = [];

    await supervisor.presenceChanged(GUILD);
    audience.humans = ["user-3"];

    await timers.advanceTo(timers.now + 60_000);

    expect(listActiveSessions(db)).toHaveLength(1);
    expect(voice.leaves).toBe(0);
  });

  it("does not end the session if the channel refilled but no event arrived", async () => {
    // The timer re-checks presence rather than trusting the state at the time
    // it was set, so a missed event cannot kill a live session.
    const { db, audience, voice, supervisor, timers } = setup({ graceMs: 60_000 });
    await supervisor.begin(newSession());
    audience.humans = [];

    await supervisor.presenceChanged(GUILD);
    audience.humans = ["user-4"]; // no presenceChanged call

    await timers.advanceTo(timers.now + 60_000);

    expect(listActiveSessions(db)).toHaveLength(1);
    expect(voice.leaves).toBe(0);
  });
});

describe("stop", () => {
  it("records the reason, cancels timers, leaves and frees the guild", async () => {
    const { db, voice, presenter, supervisor } = setup();
    await supervisor.begin(newSession());

    await supervisor.stop(GUILD, "stopped by a participant");

    expect(listActiveSessions(db)).toHaveLength(0);
    expect(voice.leaves).toBe(1);
    expect(supervisor.isScheduled(GUILD)).toBe(false);
    // The final, terminal state is shown before the row is released.
    expect(presenter.renders.at(-1)?.stopReason).toBe("stopped by a participant");
  });

  it("is a no-op for a guild with no session", async () => {
    const { voice, supervisor } = setup();

    await supervisor.stop(GUILD, "nothing to stop");

    expect(voice.leaves).toBe(0);
  });
});

describe("shutdown", () => {
  it("cancels timers, persists elapsed state and leaves Discord", async () => {
    const { db, voice, supervisor, timers } = setup();
    await supervisor.begin(newSession());

    // A boundary elapses without a wake having been delivered.
    timers.now = START + 30 * MINUTE;

    await supervisor.shutdown();

    expect(supervisor.isScheduled(GUILD)).toBe(false);
    expect(timers.pendingCount).toBe(0);
    // State was flushed on the way out rather than lost: focus (25) and the
    // 5-minute break both completed inside the 30 minutes that elapsed, so the
    // session is back in focus with one cycle banked.
    const persisted = getActiveSession(db, GUILD);
    expect(persisted?.stage).toBe("focus");
    expect(persisted?.completedFocusStages).toBe(1);
    expect(voice.leaves).toBe(1);
  });

  it("is safe to call twice", async () => {
    const { voice, supervisor } = setup();
    await supervisor.begin(newSession());

    await supervisor.shutdown();
    await supervisor.shutdown();

    expect(voice.leaves).toBe(1);
  });
});

describe("reschedule", () => {
  it("re-arms the wake after a skip moved the deadline", async () => {
    const { db, supervisor, timers } = setup();
    await supervisor.begin(newSession());

    // A skip jumps to the next stage with a fresh deadline.
    saveActiveSession(db, {
      ...newSession(),
      stage: "short_break",
      completedFocusStages: 1,
      stageEndsAt: START + 5 * MINUTE,
    });
    supervisor.reschedule(GUILD);

    expect(timers.delays.at(-1)).toBe(5 * MINUTE);
  });

  it("clears the wake when the session is paused", async () => {
    const { db, supervisor } = setup();
    await supervisor.begin(newSession());

    saveActiveSession(db, pause(newSession(), START + MINUTE));
    supervisor.reschedule(GUILD);

    expect(supervisor.isScheduled(GUILD)).toBe(false);
  });
});
