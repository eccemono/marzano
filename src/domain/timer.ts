/**
 * The Pomodoro timer engine.
 *
 * This module is deliberately free of any Discord or database code. It is a
 * pure state machine: every function takes the session it acts on plus the
 * current time, and returns the next session. That keeps the rules fully
 * testable with a simulated clock, and it means a logic bug cannot hide behind
 * an event handler.
 *
 * The source of truth is timestamps, never a tick counter. Remaining time is
 * always derived from `stageEndsAt - now`, so delays in the event loop cannot
 * make the timer drift, and a session can be reconstructed after a restart.
 */

import { type PomodoroConfig, applySplit, holdsAtBoundary } from "./config";
import { newFactSeed } from "./facts";
import type { Split } from "./split";

export const SESSION_STAGES = ["focus", "short_break", "long_break"] as const;
export type SessionStage = (typeof SESSION_STAGES)[number];

export const SESSION_STATES = ["running", "paused", "stopped"] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export interface TimerSession {
  guildId: string;
  voiceChannelId: string;
  textChannelId: string | null;
  statusMessageId: string | null;
  stage: SessionStage;
  state: SessionState;
  /** Epoch ms when the current stage began. Null while paused is not required. */
  stageStartedAt: number | null;
  /** Epoch ms when the current stage ends. Null while paused or stopped. */
  stageEndsAt: number | null;
  /** Exact remainder captured at the moment of pausing. */
  pausedRemainingMs: number | null;
  /**
   * True when the session is held at a stage boundary in manual mode, waiting
   * for someone to press Continue. Distinct from a user pause mid-stage.
   */
  awaitingContinue: boolean;
  /** Focus stages finished since the session began. */
  completedFocusStages: number;
  /**
   * Seed for this session's shuffled tomato-fact playlist.
   *
   * Fixed at start so the sequence is stable across restarts and renders, while
   * differing between sessions.
   */
  factSeed: number;
  config: PomodoroConfig;
  stopReason: string | null;
}

export interface Transition {
  from: SessionStage;
  to: SessionStage;
  completedFocusStages: number;
  /** The scheduled boundary time, not the time the transition was noticed. */
  at: number;
}

export class TimerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimerError";
  }
}

const MS_PER_MINUTE = 60_000;

/** Upper bound on transitions replayed in one call, so a tiny split cannot spin. */
export const MAX_REPLAYED_TRANSITIONS = 1_000;

export function stageDurationMs(stage: SessionStage, config: PomodoroConfig): number {
  switch (stage) {
    case "focus":
      return config.focusMinutes * MS_PER_MINUTE;
    case "short_break":
      return config.shortBreakMinutes * MS_PER_MINUTE;
    case "long_break":
      return config.longBreakMinutes * MS_PER_MINUTE;
  }
}

export interface StartOptions {
  guildId: string;
  voiceChannelId: string;
  textChannelId?: string | null;
  statusMessageId?: string | null;
  config: PomodoroConfig;
  now: number;
  /** Overrides the shuffled fact playlist's seed. Injected by tests. */
  factSeed?: number;
}

/** Begin a session in a fresh focus stage. */
export function startSession(options: StartOptions): TimerSession {
  const { config, now } = options;

  return {
    guildId: options.guildId,
    voiceChannelId: options.voiceChannelId,
    textChannelId: options.textChannelId ?? null,
    statusMessageId: options.statusMessageId ?? null,
    stage: "focus",
    state: "running",
    stageStartedAt: now,
    stageEndsAt: now + stageDurationMs("focus", config),
    pausedRemainingMs: null,
    awaitingContinue: false,
    completedFocusStages: 0,
    factSeed: options.factSeed ?? newFactSeed(),
    config,
    stopReason: null,
  };
}

/**
 * The stage that follows the current one.
 *
 * A long break replaces the short break after every `cyclesBeforeLongBreak`
 * completed focus stages.
 */
export function nextStage(
  current: SessionStage,
  completedFocusStages: number,
  config: PomodoroConfig,
): { stage: SessionStage; completedFocusStages: number } {
  if (current !== "focus") {
    return { stage: "focus", completedFocusStages };
  }

  const completed = completedFocusStages + 1;
  const isLongBreak = completed % config.cyclesBeforeLongBreak === 0;

  return {
    stage: isLongBreak ? "long_break" : "short_break",
    completedFocusStages: completed,
  };
}

/** Milliseconds left in the current stage. Derived, never accumulated. */
export function remainingMs(session: TimerSession, now: number): number {
  if (session.state === "paused") {
    return Math.max(0, session.pausedRemainingMs ?? 0);
  }
  if (session.state === "stopped" || session.stageEndsAt === null) {
    return 0;
  }
  return Math.max(0, session.stageEndsAt - now);
}

/** Milliseconds spent in the current stage. */
export function elapsedMs(session: TimerSession, now: number): number {
  const duration = stageDurationMs(session.stage, session.config);

  if (session.state === "paused") {
    return Math.max(0, duration - (session.pausedRemainingMs ?? 0));
  }
  if (session.state === "stopped" || session.stageStartedAt === null) {
    return 0;
  }
  return Math.min(duration, Math.max(0, now - session.stageStartedAt));
}

export function isStageComplete(session: TimerSession, now: number): boolean {
  return session.state === "running" && session.stageEndsAt !== null && now >= session.stageEndsAt;
}

export interface AdvanceResult {
  session: TimerSession;
  transitions: Transition[];
  /** True when the replay bound was hit before reaching the present. */
  truncated: boolean;
}

/**
 * Move the session forward across every boundary that has already passed.
 *
 * Boundaries are chained from the previous stage's scheduled end rather than
 * from `now`, so the schedule stays on its original lattice after an offline
 * gap instead of shifting by however long the process was down.
 */
export function advance(
  session: TimerSession,
  now: number,
  maxTransitions: number = MAX_REPLAYED_TRANSITIONS,
): AdvanceResult {
  if (session.state !== "running" || session.stageEndsAt === null) {
    return { session, transitions: [], truncated: false };
  }

  let current = session;
  const transitions: Transition[] = [];

  while (current.stageEndsAt !== null && now >= current.stageEndsAt) {
    if (transitions.length >= maxTransitions) {
      return { session: current, transitions, truncated: true };
    }

    const boundary = current.stageEndsAt;
    const next = nextStage(current.stage, current.completedFocusStages, current.config);

    transitions.push({
      from: current.stage,
      to: next.stage,
      completedFocusStages: next.completedFocusStages,
      at: boundary,
    });

    current = {
      ...current,
      stage: next.stage,
      completedFocusStages: next.completedFocusStages,
      stageStartedAt: boundary,
      stageEndsAt: boundary + stageDurationMs(next.stage, current.config),
    };

    if (holdsAtBoundary(current.config.advanceMode, next.stage)) {
      // The next stage is queued and the bell has rung, but the clock must not
      // start until someone presses Continue. Which boundaries hold depends on
      // the mode - see `holdsAtBoundary`.
      current = {
        ...current,
        state: "paused",
        awaitingContinue: true,
        pausedRemainingMs: stageDurationMs(current.stage, current.config),
        stageEndsAt: null,
      };
      break;
    }
  }

  return { session: current, transitions, truncated: false };
}

/** Pause a running session. Pausing an already paused or stopped session is a no-op. */
export function pause(session: TimerSession, now: number): TimerSession {
  if (session.state !== "running") return session;

  return {
    ...session,
    state: "paused",
    pausedRemainingMs: remainingMs(session, now),
    stageEndsAt: null,
  };
}

/** Resume a paused session. Resuming a running or stopped session is a no-op. */
export function resume(session: TimerSession, now: number): TimerSession {
  if (session.state !== "paused") return session;

  const remaining = Math.max(0, session.pausedRemainingMs ?? 0);
  const duration = stageDurationMs(session.stage, session.config);

  return {
    ...session,
    state: "running",
    awaitingContinue: false,
    pausedRemainingMs: null,
    // Keep elapsed time coherent by back-dating the stage start.
    stageStartedAt: now - Math.max(0, duration - remaining),
    stageEndsAt: now + remaining,
  };
}

/**
 * End the current stage immediately and move to the next one.
 *
 * Unlike a natural transition this anchors to `now`, because the user asked
 * for the next stage to start now.
 */
export function skip(
  session: TimerSession,
  now: number,
): { session: TimerSession; transition: Transition | null } {
  if (session.state === "stopped") {
    return { session, transition: null };
  }

  const next = nextStage(session.stage, session.completedFocusStages, session.config);

  const transition: Transition = {
    from: session.stage,
    to: next.stage,
    completedFocusStages: next.completedFocusStages,
    at: now,
  };

  return {
    session: {
      ...session,
      stage: next.stage,
      completedFocusStages: next.completedFocusStages,
      state: "running",
      awaitingContinue: false,
      pausedRemainingMs: null,
      stageStartedAt: now,
      stageEndsAt: now + stageDurationMs(next.stage, session.config),
    },
    transition,
  };
}

/** Add time to the current stage, whether it is running or paused. */
export function extend(session: TimerSession, deltaMs: number, now: number): TimerSession {
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) {
    throw new TimerError("The added time must be greater than zero.");
  }
  if (session.state === "stopped") {
    return session;
  }

  if (session.state === "paused") {
    return {
      ...session,
      pausedRemainingMs: Math.max(0, session.pausedRemainingMs ?? 0) + deltaMs,
    };
  }

  return {
    ...session,
    // A running session must have a deadline; fall back to now defensively.
    stageEndsAt: (session.stageEndsAt ?? now) + deltaMs,
  };
}

/**
 * Change the split for the remainder of the session.
 *
 * Only the configuration is replaced; the running stage keeps its existing
 * deadline, so the new durations apply from the next stage onwards. The saved
 * channel configuration is never touched.
 */
export function changeSplit(session: TimerSession, split: Split): TimerSession {
  return { ...session, config: applySplit(session.config, split) };
}

/** Change non-split settings for the remainder of the session. */
export function changeSessionSettings(
  session: TimerSession,
  changes: Partial<Pick<PomodoroConfig, "soundEnabled" | "soundVolume" | "cyclesBeforeLongBreak">>,
): TimerSession {
  const nextConfig: PomodoroConfig = { ...session.config };

  if (changes.soundEnabled !== undefined) nextConfig.soundEnabled = changes.soundEnabled;
  if (changes.soundVolume !== undefined) nextConfig.soundVolume = changes.soundVolume;
  if (changes.cyclesBeforeLongBreak !== undefined) {
    nextConfig.cyclesBeforeLongBreak = changes.cyclesBeforeLongBreak;
  }

  return { ...session, config: nextConfig };
}

/** Stop the session permanently, recording why. */
export function terminate(session: TimerSession, reason: string): TimerSession {
  return {
    ...session,
    state: "stopped",
    stageEndsAt: null,
    pausedRemainingMs: null,
    stopReason: reason,
  };
}

export function isRunning(session: TimerSession): boolean {
  return session.state === "running";
}

export function isPaused(session: TimerSession): boolean {
  return session.state === "paused";
}

export function isStopped(session: TimerSession): boolean {
  return session.state === "stopped";
}
