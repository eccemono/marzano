/**
 * Session history, as the lifecycle sees it.
 *
 * The supervisor must not grow a second set of bookkeeping rules, so all of the
 * "what gets recorded and when" lives here behind a few methods. The timing
 * rules that matter:
 *
 *   - A stage is recorded at the moment it **ends**, with the window it actually
 *     occupied. Credit is resolved then, against attendance as it was, because
 *     recomputing later would give a different answer once the presence data
 *     has moved on.
 *   - A skipped stage is recorded as skipped. It never earns focus credit - the
 *     point of a skip is that the work did not happen.
 *   - Presence windows are opened and closed by diffing the member set, not by
 *     trusting a single join event, so a missed event self-corrects.
 */

import type { Db } from "../db/database";
import {
  activeRunId,
  attendanceIntervals,
  closeAllAttendance,
  closeAttendance,
  detachRun,
  finishRun,
  getRun,
  leaderboardTotals,
  openAttendance,
  recordStage,
  runTotals,
  saveCredit,
  stageCounts as stageOutcomes,
  startRun,
} from "../db/history-repository";
import {
  type MemberTotals,
  creditForStage,
  mergeIntervals,
  periodBounds,
  stageKind,
} from "../domain/attendance";
import type { Logger } from "../logger";

export type StageEnding = "completed" | "skipped" | "interrupted";

/** What the summary needs, gathered at the moment the run closes. */
export interface RunReport {
  startedAt: number;
  endedAt: number;
  totals: MemberTotals[];
  outcomes: { stage: string; outcome: string }[];
}

export interface SessionHistoryOptions {
  db: Db;
  logger: Logger;
}

export class SessionHistory {
  private readonly db: Db;
  private readonly logger: Logger;
  /** Who we believe is present, per guild, so joins and leaves can be diffed. */
  private readonly present = new Map<string, Set<string>>();

  constructor(options: SessionHistoryOptions) {
    this.db = options.db;
    this.logger = options.logger;
  }

  /** Open a run for a newly started session. */
  begin(guildId: string, voiceChannelId: string, startedAt: number): number {
    this.present.delete(guildId);
    return startRun(this.db, { guildId, voiceChannelId, startedAt });
  }

  /**
   * Adopt the run a restart interrupted, or open a fresh one if there is none.
   *
   * This is what makes a session that spans a deploy count once rather than
   * twice in the leaderboard.
   */
  adopt(guildId: string, voiceChannelId: string, startedAt: number): number {
    const existing = activeRunId(this.db, guildId);

    if (existing !== null) {
      // Anything left open by the crash is closed at the restart boundary, so a
      // member does not accrue credit for the hours the process was down.
      closeAllAttendance(this.db, existing, startedAt);
      this.present.delete(guildId);
      return existing;
    }

    return this.begin(guildId, voiceChannelId, startedAt);
  }

  /**
   * Reconcile who is present, opening and closing windows to match.
   *
   * Returns nothing: presence is bookkeeping, never a control-flow signal. An
   * empty member set is recorded, not acted on - whether the session should end
   * is the supervisor's decision.
   */
  syncMembers(guildId: string, userIds: readonly string[], at: number): void {
    const runId = activeRunId(this.db, guildId);
    if (runId === null) return;

    const next = new Set(userIds);
    const previous = this.present.get(guildId) ?? new Set<string>();

    for (const userId of next) {
      if (previous.has(userId)) continue;
      openAttendance(this.db, { runId, guildId, userId, at });
    }

    for (const userId of previous) {
      if (next.has(userId)) continue;
      closeAttendance(this.db, { runId, userId, at });
    }

    this.present.set(guildId, next);
  }

  /**
   * Record a stage that has just ended, and resolve credit for it.
   *
   * `startedAt` is the stage's real start, which may be well before this call:
   * a wake can span several boundaries after a restart.
   */
  endStage(
    guildId: string,
    input: { stage: string; startedAt: number; endedAt: number; outcome: StageEnding },
  ): void {
    const runId = activeRunId(this.db, guildId);
    if (runId === null) return;

    const { stage, startedAt, endedAt, outcome } = input;
    recordStage(this.db, runId, guildId, { stage, outcome, startedAt, endedAt });

    // A skipped stage is history, not credit. Recording it without credit is
    // what lets the summary distinguish "did not get there" from "did the work".
    if (outcome !== "completed") return;
    if (endedAt <= startedAt) return;

    const segments = creditForStage(
      { stage, kind: stageKind(stage), startedAt, endedAt },
      mergeIntervals(attendanceIntervals(this.db, runId)),
    );

    saveCredit(this.db, runId, guildId, segments);

    this.logger.debug("stage credit recorded", {
      guildId,
      stage,
      outcome,
      members: segments.length,
    });
  }

  /** Close the run and return everything the summary needs. */
  finish(guildId: string, reason: string, at: number): RunReport | null {
    const runId = activeRunId(this.db, guildId);
    if (runId === null) return null;

    closeAllAttendance(this.db, runId, at);
    finishRun(this.db, runId, at, reason);

    const row = getRun(this.db, runId);
    const totals = runTotals(this.db, runId);
    const outcomes = stageOutcomes(this.db, runId);

    detachRun(this.db, guildId);
    this.present.delete(guildId);

    return {
      startedAt: row?.started_at ?? at,
      endedAt: row?.ended_at ?? at,
      totals,
      outcomes,
    };
  }

  /** Drop in-memory presence without touching history. Used on shutdown. */
  forget(guildId: string): void {
    this.present.delete(guildId);
  }

  /** The guild's monthly leaderboard, for the summary's footer. */
  leaderboard(guildId: string, now: number): MemberTotals[] {
    return leaderboardTotals(this.db, guildId, periodBounds("monthly", now));
  }
}
