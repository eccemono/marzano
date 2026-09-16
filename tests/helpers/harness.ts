/**
 * Shared harness for session-level tests.
 *
 * Everything here exists so that a session can be driven through a whole
 * multi-cycle lifetime - or killed and restarted - without a Discord
 * connection and without waiting on real time.
 */

import type { Db } from "../../src/db/database";
import { migrate } from "../../src/db/migrations";
import { openInMemoryDatabase } from "../../src/db/database";
import { BUILT_IN_DEFAULTS } from "../../src/domain/config";
import { startSession, type TimerSession } from "../../src/domain/timer";
import type { SessionRendererPort } from "../../src/discord/session-renderer";
import { createLogger, type Logger } from "../../src/logger";
import type { ScheduleFn, TimerHandle, VoiceAudience } from "../../src/session/ports";
import { SessionSupervisor } from "../../src/session/supervisor";
import type { SessionVoice } from "../../src/voice/manager";

export const GUILD = "111111111111111111";
export const GUILD_B = "444444444444444444";
export const CHANNEL = "222222222222222222";
export const MINUTE = 60_000;
export const START = 1_760_000_000_000;

export function silentLogger() {
  return createLogger({ level: "error", sink: () => {} });
}

/** Let queued promises settle after firing timers. */
export const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * A controllable clock and timer queue.
 *
 * Session behaviour is almost entirely about time, so tests drive time directly
 * rather than sleeping. `advanceTo` moves the clock and fires whatever has come
 * due.
 */
export class FakeTimers {
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

  /** Advance by a duration, firing everything that comes due on the way. */
  async advanceBy(durationMs: number): Promise<void> {
    await this.advanceTo(this.now + durationMs);
  }
}

export class FakeVoice {
  joins: string[] = [];
  leaves = 0;
  startCues = 0;
  transitions = 0;
  /** When set, join fails with this message. */
  joinError: string | null = null;

  async join(session: { voiceChannelId: string }): Promise<boolean> {
    if (this.joinError) throw new Error(this.joinError);
    this.joins.push(session.voiceChannelId);
    return true;
  }
  async leave(): Promise<void> {
    this.leaves += 1;
  }
  async leaveAll(): Promise<void> {
    this.leaves += 1;
  }
  async announceStart(): Promise<void> {
    this.startCues += 1;
  }
  async announceTransition(): Promise<void> {
    this.transitions += 1;
  }
}

export class FakePresenter {
  renders: TimerSession[] = [];
  nextMessageId = "message-1";
  /** Guilds with a live refresh loop. */
  readonly watching = new Set<string>();

  async render(session: TimerSession) {
    this.renders.push(session);
    return { messageId: session.statusMessageId ?? this.nextMessageId, replaced: false };
  }

  async renderWithEmbed(session: TimerSession) {
    this.renders.push(session);
    return { messageId: session.statusMessageId ?? this.nextMessageId, replaced: false };
  }

  watch(guildId: string): void {
    this.watching.add(guildId);
  }

  unwatch(guildId: string): void {
    this.watching.delete(guildId);
  }

  unwatchAll(): void {
    this.watching.clear();
  }
}

export class FakeAudience implements VoiceAudience {
  humans: string[] | null = ["user-1"];
  exists = true;

  async channelExists(): Promise<boolean> {
    return this.exists;
  }
  async humanMembers(): Promise<string[] | null> {
    return this.humans;
  }
}

export interface HarnessOptions {
  graceMs?: number;
  /** Capture logs from the supervisor under test. */
  logger?: Logger;
  /** Reuse an existing database, to simulate a process restart. */
  db?: Db;
  /** Reuse an existing timer queue, to simulate a process restart. */
  timers?: FakeTimers;
}

export function setup(options: HarnessOptions = {}) {
  const db = options.db ?? openInMemoryDatabase();
  if (!options.db) migrate(db);

  const timers = options.timers ?? new FakeTimers();
  const voice = new FakeVoice();
  const presenter = new FakePresenter();
  const audience = new FakeAudience();

  const supervisor = new SessionSupervisor({
    db,
    voice: voice as unknown as SessionVoice,
    presenter: presenter as unknown as SessionRendererPort,
    audience,
    logger: options.logger ?? silentLogger(),
    now: () => timers.now,
    schedule: (delayMs, fn) => timers.schedule(delayMs, fn),
    ...(options.graceMs === undefined ? {} : { graceMs: options.graceMs }),
  });

  return { db, timers, voice, presenter, audience, supervisor };
}

export function newSession(overrides: Partial<TimerSession> = {}): TimerSession {
  return {
    ...startSession({
      guildId: GUILD,
      voiceChannelId: CHANNEL,
      textChannelId: CHANNEL,
      config: { ...BUILT_IN_DEFAULTS, focusMinutes: 25, shortBreakMinutes: 5, advanceMode: "auto" },
      now: START,
    }),
    ...overrides,
  };
}
