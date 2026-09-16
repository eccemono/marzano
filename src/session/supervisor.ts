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
import type { SessionRendererPort } from "../discord/session-renderer";
import { buildSummaryEmbed } from "../discord/history-views";
import type { SessionHistory } from "./history";
import type { SessionVoice } from "../voice/manager";

import { type ScheduleFn, type TimerHandle, type VoiceAudience, systemSchedule } from "./ports";

/** How long the last participant can be absent before the session ends. */
export const DEFAULT_GRACE_MS = 60_000;

/** Bound on graceful shutdown, so a stuck connection cannot block a kill. */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

/** The optional voice-channel status, cleared when a session ends. */
export interface VoiceStatusPort {
  clear(session: TimerSession): Promise<void>;
}

export interface SupervisorOptions {
  db: Db;
  voice: SessionVoice;
  presenter: SessionRendererPort;
  audience: VoiceAudience;
  logger: Logger;
  now?: () => number;
  schedule?: ScheduleFn;
  graceMs?: number;
  voiceStatus?: VoiceStatusPort;
  /** Durable history. Optional so the lifecycle rules can be tested alone. */
  history?: SessionHistory;
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function idle(): WakeOutcome {
  return { transitions: 0, bellsPlayed: 0, bellsSkipped: 0, stopped: false };
}

export class SessionSupervisor {
  private readonly db: Db;
  private readonly voice: SessionVoice;
  private readonly presenter: SessionRendererPort;
  private readonly audience: VoiceAudience;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly schedule: ScheduleFn;
  private readonly graceMs: number;
  private readonly voiceStatus: VoiceStatusPort | undefined;
  private readonly history: SessionHistory | undefined;

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
    this.voiceStatus = options.voiceStatus;
    this.history = options.history;
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

    // The refresh loop belongs to the session, not to startup. Creating loops
    // only for the sessions that existed at boot is why a session started
    // afterwards had no loop at all and its countdown sat frozen on screen.
    this.presenter.watch(session.guildId);

    // Open the history run at the same moment the session starts, so no stage
    // can ever end before there is somewhere to record it.
    this.history?.begin(session.guildId, session.voiceChannelId, this.now());

    this.scheduleStageWake(session);
    // Fire and forget: the cue must never delay the interaction that started
    // it - but it must still not become an unhandled rejection.
    this.detach(session.guildId, "start cue", this.voice.announceStart(session));
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
    this.detach(guildId, "stage bell", this.voice.announceTransition(session));
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

    // Record every stage that just ended, with the window it actually occupied.
    // A wake after a restart can cross several boundaries at once, so the start
    // of each window is the previous boundary rather than "now".
    if (this.history && transitions.length > 0) {
      let cursor = session.stageStartedAt ?? transitions[0]?.at ?? this.now();

      for (const transition of transitions) {
        this.history.endStage(guildId, {
          stage: transition.from,
          startedAt: cursor,
          endedAt: transition.at,
          outcome: "completed",
        });
        cursor = transition.at;
      }
    }

    let bellsPlayed = 0;
    let bellsSkipped = 0;

    if (transitions.length > 0) {
      if (options.announce) {
        // Several boundaries at once still produce a single bell: a burst would
        // be noise, and the ring is a cue that the stage changed, not a count.
        bellsPlayed = 1;
        this.detach(guildId, "stage bell", this.voice.announceTransition(advanced));
      } else {
        bellsSkipped = transitions.length;
      }
    }

    this.scheduleStageWake(advanced);

    // A natural boundary has to repaint the message itself. Without this the
    // stored session advances while the embed still shows the stage that just
    // ended, and it only catches up when somebody presses a button.
    if (transitions.length > 0) {
      this.detach(guildId, "boundary render", this.renderAndTrack(advanced));
    }

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

    // Presence is recorded whatever the outcome, including "nobody here":
    // whether that ends the session is decided below, not by the bookkeeping.
    if (humans !== null) this.history?.syncMembers(guildId, humans, this.now());

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
        this.detach(guildId, "grace expiry", this.expireGrace(guildId));
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

    // Presence is recorded whatever the outcome, including "nobody here":
    // whether that ends the session is decided below, not by the bookkeeping.
    if (humans !== null) this.history?.syncMembers(guildId, humans, this.now());

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

    // Stop refreshing before the row disappears: a loop that ticked in between
    // would find no session and render nothing, and on a slow reply could even
    // repaint the live view over the terminal one.
    this.presenter.unwatch(guildId);

    await this.voice.leave(guildId);

    // Close the run and turn its history into the terminal view. The summary
    // replaces the live message rather than following it, so the channel keeps
    // one clear record of what happened instead of a dead timer sitting above a
    // summary of the same session.
    const report = this.history?.finish(guildId, reason, this.now()) ?? null;

    if (report) {
      await this.presenter.renderWithEmbed(
        stopped,
        buildSummaryEmbed({
          reason,
          startedAt: report.startedAt,
          endedAt: report.endedAt,
          outcomes: report.outcomes,
          totals: report.totals,
          monthlyLeaderboard: this.history?.leaderboard(guildId, this.now()) ?? [],
        }),
      );
    } else {
      await this.presenter.render(stopped);
    }

    // The status line belongs to the live session, so it goes when the session
    // does rather than being left to age on the channel.
    if (this.voiceStatus) {
      await this.voiceStatus.clear(stopped).catch((error: unknown) => {
        this.logger.warn("could not clear the voice channel status", {
          guildId,
          reason: describe(error),
        });
      });
    }

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

    this.presenter.unwatchAll();

    const now = this.now();
    for (const session of listActiveSessions(this.db)) {
      if (isStopped(session) || isPaused(session)) continue;

      const { session: advanced } = advance(session, now);
      if (advanced !== session) saveActiveSession(this.db, advanced);
    }

    // Leave cleanly, but never let a wedged connection outlast the kill timeout.
    await Promise.race([
      this.voice.leaveAll(),
      new Promise<void>((resolve) => {
        const handle = setTimeout(resolve, timeoutMs);
        if (typeof handle.unref === "function") handle.unref();
      }),
    ]);
  }

  /**
   * Record the current stage as skipped and move nothing.
   *
   * The caller moves the session; this exists so a skip leaves the same kind of
   * history trail a natural boundary does, without earning credit the member
   * did not do the work for.
   */
  noteSkipped(guildId: string): void {
    if (!this.history) return;

    const session = getActiveSession(this.db, guildId);
    if (!session || isStopped(session)) return;

    const at = this.now();
    this.history.endStage(guildId, {
      stage: session.stage,
      startedAt: session.stageStartedAt ?? at,
      endedAt: at,
      outcome: "skipped",
    });
  }

  /**
   * Rejoin, re-present, and reschedule a session that is still alive.
   */
  private async restore(guildId: string, session: ActiveSessionRecord): Promise<void> {
    // Adopt the run the restart interrupted, so a session spanning a deploy
    // counts once rather than twice.
    this.history?.adopt(guildId, session.voiceChannelId, this.now());

    await this.voice.join(session);

    this.presenter.watch(guildId);
    await this.renderAndTrack(session);

    if (!isPaused(session)) this.scheduleStageWake(session);

    this.logger.info("resumed session after restart", {
      guildId,
      stage: session.stage,
      state: session.state,
    });
  }

  /**
   * Render the status message and persist a replacement message id.
   *
   * If the status message was deleted, the presenter posts a new one. Every
   * later edit has to target that new id, so the id is written back here rather
   * than left to the caller to remember.
   */
  private async renderAndTrack(session: ActiveSessionRecord): Promise<void> {
    const rendered = await this.presenter.render(session);
    if (rendered.messageId !== session.statusMessageId) {
      saveActiveSession(this.db, { ...session, statusMessageId: rendered.messageId });
    }
  }

  /**
   * Run a floating promise without letting it become an unhandled rejection.
   *
   * A scheduled callback has no caller to return an error to, so a failure -
   * a database write, say - must be reported here or it takes the process down
   * with an unhandled rejection instead.
   */
  private detach(guildId: string, label: string, work: Promise<unknown>): void {
    void work.catch((error: unknown) => {
      this.logger.error(`${label} failed`, { guildId, reason: describe(error) });
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
        this.detach(
          session.guildId,
          "session wake",
          this.wake(session.guildId, { announce: true }),
        );
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
