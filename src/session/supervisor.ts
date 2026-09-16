/**
 * The session supervisor.
 *
 * Owns everything about a session's *lifetime*: when it wakes, how it survives
 * a restart, when it should give up, and when the bot should leave.
 *
 * The single most important ordering rule lives here:
 *
 *   **an advanced session is persisted before the next wake-up is scheduled.**
 *
 * If the process dies between those two steps, the worst case is a session that
 * is behind schedule and catches up on the next boot. The reverse order would
 * allow a boundary to be applied twice, or lost entirely, which is much harder
 * to reason about and impossible to observe after the fact.
 */

import type { Logger } from "../logger";
import type { Db } from "../db/database";
import {
  type ActiveSessionRecord,
  deleteActiveSession,
  getActiveSession,
  listActiveSessions,
  saveActiveSession,
} from "../db/session-repository";
import { advance, isPaused, isStopped, terminate, type TimerSession } from "../domain/timer";
import type { SessionPresenter } from "../discord/session-presenter";
import type { SessionVoice } from "../voice/manager";

import { type ScheduleFn, type TimerHandle, type VoiceAudience, systemSchedule } from "./ports";

/** How long the last participant can be absent before the session ends. */
export const DEFAULT_GRACE_MS = 60_000;

/** Bound on graceful shutdown, so a stuck connection cannot block a kill. */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

export interface SupervisorOptions {
  db: Db;
  voice: SessionVoice;
  presenter: SessionPresenter;
  audience: VoiceAudience;
  logger: Logger;
  now?: () => number;
  schedule?: ScheduleFn;
  graceMs?: number;
}

export interface WakeOutcome {
  /** Boundaries crossed during this wake. */
  transitions: number;
  bellsPlayed: number;
  /** Boundaries crossed while offline, whose bells are deliberately not replayed. */
  bellsSkipped: number;
  stopped: boolean;
}

export interface RecoveryReport {
  /** Sessions that were resumed with participants still present. */
  resumed: number;
  resumedPaused: number;
  /** Boundaries crossed while the process was down. */
  transitionsReplayed: number;
  bellsSkipped: number;
  /** Sessions that could not be resumed and were stopped with a reason. */
  unrecoverable: number;
}

function idle(): WakeOutcome {
  return { transitions: 0, bellsPlayed: 0, bellsSkipped: 0, stopped: false };
}

export class SessionSupervisor {
  private readonly db: Db;
  private readonly voice: SessionVoice;
  private readonly presenter: SessionPresenter;
  private readonly audience: VoiceAudience;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly schedule: ScheduleFn;
  private readonly graceMs: number;

  private readonly stageTimers = new Map<string, TimerHandle>();
  private readonly graceTimers = new Map<string, TimerHandle>();
  private shuttingDown = false;

  constructor(options: SupervisorOptions) {
    this.db = options.db;
    this.voice = options.voice;
    this.presenter = options.presenter;
    this.audience = options.audience;
    this.logger = options.logger;
    this.now = options.now ?? (() => Date.now());
    this.schedule = options.schedule ?? systemSchedule;
    this.graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  }

  /** Whether a stage wake is currently scheduled for a guild. */
  isScheduled(guildId: string): boolean {
    return this.stageTimers.has(guildId);
  }

  /** Whether a grace period is currently counting down for a guild. */
  isGracePending(guildId: string): boolean {
    return this.graceTimers.has(guildId);
  }

  /**
   * Adopt a brand new session: persist it, schedule its first wake, and play
   * the opening cue.
   */
  async begin(session: TimerSession): Promise<void> {
    saveActiveSession(this.db, session);
    this.scheduleStageWake(session);
    // Fire and forget: the cue must never delay the interaction that started it.
    void this.voice.announceStart(session);
  }

  /**
   * Play the stage-change bell for the current session.
   *
   * Exposed so callers that change the stage themselves (the skip button) do
   * not need their own handle on the voice layer.
   */
  announceTransition(guildId: string): void {
    const session = getActiveSession(this.db, guildId);
    if (!session || isStopped(session)) return;
    void this.voice.announceTransition(session);
  }

  /**
   * Re-arm the stage wake after something outside the supervisor changed the
   * session - a skip, an extend, or a split change all move the deadline.
   */
  reschedule(guildId: string): void {
    const session = getActiveSession(this.db, guildId);
    if (!session) {
      this.clearStageTimer(guildId);
      return;
    }
    this.scheduleStageWake(session);
  }

  /**
   * Advance the session across every boundary that has already elapsed.
   *
   * `announce` is false during restart recovery, where the bells for boundaries
   * crossed while offline are deliberately not replayed.
   */
  async wake(guildId: string, options: { announce: boolean }): Promise<WakeOutcome> {
    const session = getActiveSession(this.db, guildId);
    if (!session) return idle();

    if (isStopped(session)) {
      this.clearTimers(guildId);
      return { ...idle(), stopped: true };
    }

    // A paused session has no deadline to cross; waking it would be wrong.
    if (isPaused(session)) return idle();

    const { session: advanced, transitions, truncated } = advance(session, this.now());

    if (truncated) {
      // The replay bound was hit; keep what we have and catch up on the next
      // wake rather than spinning here.
      this.logger.warn("session fell more than the replay bound behind; catching up", { guildId });
    }

    // Persist BEFORE scheduling. See the ordering note at the top of this file.
    saveActiveSession(this.db, advanced);

    let bellsPlayed = 0;
    let bellsSkipped = 0;

    if (transitions.length > 0) {
      if (options.announce) {
        // Several boundaries at once still produce a single bell: a burst would
        // be noise, and the ring is a cue that the stage changed, not a count.
        bellsPlayed = 1;
        void this.voice.announceTransition(advanced);
      } else {
        bellsSkipped = transitions.length;
      }
    }

    this.scheduleStageWake(advanced);

    return {
      transitions: transitions.length,
      bellsPlayed,
      bellsSkipped,
      stopped: isStopped(advanced),
    };
  }

  /**
   * Reconcile sessions left behind by a restart.
   *
   * Bells are not replayed for boundaries that elapsed while the process was
   * down, and the bot only rejoins when human participants are actually there -
   * otherwise it would sit alone in a channel it has no reason to occupy.
   */
  async recover(): Promise<RecoveryReport> {
    const report: RecoveryReport = {
      resumed: 0,
      resumedPaused: 0,
      transitionsReplayed: 0,
      bellsSkipped: 0,
      unrecoverable: 0,
    };

    for (const session of listActiveSessions(this.db)) {
      const { guildId, voiceChannelId } = session;

      // A stopped row is residue; clear it so the guild can start again.
      if (isStopped(session)) {
        deleteActiveSession(this.db, guildId);
        continue;
      }

      if (!(await this.audience.channelExists(guildId, voiceChannelId))) {
        await this.stop(guildId, "the voice channel no longer exists");
        report.unrecoverable += 1;
        continue;
      }

      const humans = await this.audience.humanMembers(guildId, voiceChannelId);
      if (humans !== null && humans.length === 0) {
        await this.stop(guildId, "nobody was in the voice channel when the bot restarted");
        report.unrecoverable += 1;
        continue;
      }

      if (isPaused(session)) {
        // A paused session stores its exact remainder, so there is nothing to
        // replay; only the presentation and the presence need restoring.
        await this.restore(guildId, session);
        report.resumed += 1;
        report.resumedPaused += 1;
        continue;
      }

      const outcome = await this.wake(guildId, { announce: false });
      report.transitionsReplayed += outcome.transitions;
      report.bellsSkipped += outcome.bellsSkipped;

      if (outcome.bellsSkipped > 0) {
        this.logger.info("skipped bells for boundaries that elapsed while offline", {
          guildId,
          skipped: outcome.bellsSkipped,
        });
      }

      const current = getActiveSession(this.db, guildId);
      if (!current || isStopped(current)) continue;

      await this.restore(guildId, current);
      report.resumed += 1;
    }

    return report;
  }

  /**
   * React to a change in who is sitting in a voice channel.
   *
   * The last human leaving starts a grace period; someone arriving before it
   * expires cancels it.
   */
  async presenceChanged(guildId: string): Promise<void> {
    const session = getActiveSession(this.db, guildId);
    if (!session || isStopped(session)) {
      this.clearGraceTimer(guildId);
      return;
    }

    const humans = await this.audience.humanMembers(guildId, session.voiceChannelId);

    if (humans === null) {
      // Inconclusive. Never end a session on a failed lookup.
      this.logger.warn(
        "could not determine who is in the voice channel; leaving the grace period alone",
        {
          guildId,
        },
      );
      return;
    }

    if (humans.length > 0) {
      if (this.graceTimers.has(guildId)) {
        this.clearGraceTimer(guildId);
        this.logger.info("someone returned; grace period cancelled", { guildId });
      }
      return;
    }

    if (this.graceTimers.has(guildId)) return; // already counting down

    this.logger.info("voice channel is empty; starting the grace period", {
      guildId,
      graceMs: this.graceMs,
    });

    this.graceTimers.set(
      guildId,
      this.schedule(this.graceMs, () => {
        void this.expireGrace(guildId);
      }),
    );
  }

  private async expireGrace(guildId: string): Promise<void> {
    this.graceTimers.delete(guildId);

    const session = getActiveSession(this.db, guildId);
    if (!session || isStopped(session)) return;

    // Re-check rather than trusting the state at the time the timer was set:
    // the channel may have refilled, and a stale timer must not end a live session.
    const humans = await this.audience.humanMembers(guildId, session.voiceChannelId);

    if (humans === null) {
      this.logger.warn("grace expired but presence could not be confirmed; session left running", {
        guildId,
      });
      return;
    }

    if (humans.length > 0) {
      this.logger.info("grace period expired but someone is present; session left running", {
        guildId,
      });
      return;
    }

    await this.stop(guildId, "everyone left the voice channel");
  }

  /** Stop a session, recording why, and release the guild. */
  async stop(guildId: string, reason: string): Promise<void> {
    const session = getActiveSession(this.db, guildId);
    if (!session) return;

    const stopped = terminate(session, reason);
    saveActiveSession(this.db, stopped);

    this.clearTimers(guildId);

    await this.voice.leave();

    // Show the terminal state, then drop the row so the guild can start again.
    await this.presenter.render(stopped);
    deleteActiveSession(this.db, guildId);

    this.logger.info("session stopped", { guildId, reason });
  }

  /**
   * Persist anything already elapsed and leave Discord, within a bound.
   *
   * Every transition is normally persisted as it happens, so this is a
   * belt-and-braces pass to guarantee no boundary is lost to a shutdown that
   * lands mid-stage.
   */
  async shutdown(timeoutMs: number = DEFAULT_SHUTDOWN_TIMEOUT_MS): Promise<void> {
    // A second signal - SIGINT after SIGTERM, or a repeated Ctrl-C - must not
    // start a second teardown on top of the first.
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    for (const handle of this.stageTimers.values()) handle.cancel();
    this.stageTimers.clear();

    for (const handle of this.graceTimers.values()) handle.cancel();
    this.graceTimers.clear();

    const now = this.now();
    for (const session of listActiveSessions(this.db)) {
      if (isStopped(session) || isPaused(session)) continue;

      const { session: advanced } = advance(session, now);
      if (advanced !== session) saveActiveSession(this.db, advanced);
    }

    // Leave cleanly, but never let a wedged connection outlast the kill timeout.
    await Promise.race([
      this.voice.leave(),
      new Promise<void>((resolve) => {
        const handle = setTimeout(resolve, timeoutMs);
        if (typeof handle.unref === "function") handle.unref();
      }),
    ]);
  }

  /** Rejoin, re-present, and reschedule a session that is still alive. */
  private async restore(guildId: string, session: ActiveSessionRecord): Promise<void> {
    await this.voice.join(session);

    const rendered = await this.presenter.render(session);
    if (rendered.messageId !== session.statusMessageId) {
      saveActiveSession(this.db, { ...session, statusMessageId: rendered.messageId });
    }

    if (!isPaused(session)) this.scheduleStageWake(session);

    this.logger.info("resumed session after restart", {
      guildId,
      stage: session.stage,
      state: session.state,
    });
  }

  private scheduleStageWake(session: ActiveSessionRecord): void {
    this.clearStageTimer(session.guildId);

    // Paused sessions have no deadline; they resume on an explicit action.
    if (isStopped(session) || isPaused(session)) return;

    const now = this.now();
    const delayMs = Math.max(0, (session.stageEndsAt ?? now) - now);

    this.stageTimers.set(
      session.guildId,
      this.schedule(delayMs, () => {
        void this.wake(session.guildId, { announce: true });
      }),
    );
  }

  private clearStageTimer(guildId: string): void {
    const handle = this.stageTimers.get(guildId);
    if (handle) {
      handle.cancel();
      this.stageTimers.delete(guildId);
    }
  }

  private clearGraceTimer(guildId: string): void {
    const handle = this.graceTimers.get(guildId);
    if (handle) {
      handle.cancel();
      this.graceTimers.delete(guildId);
    }
  }

  private clearTimers(guildId: string): void {
    this.clearStageTimer(guildId);
    this.clearGraceTimer(guildId);
  }
}
