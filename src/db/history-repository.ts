/**
 * Reading and writing session history.
 *
 * Everything here is append-mostly: runs, stages, presence windows and resolved
 * credit are written once and read later. That is deliberate - the leaderboard
 * has to agree with the summary months afterwards, which is only possible if
 * credit was resolved against the stage that was running at the time rather
 * than recomputed from live state that no longer exists.
 */

import type { Db } from "./database";
import {
  type CreditSegment,
  type Interval,
  type LeaderboardPeriod,
  type MemberTotals,
  type PeriodBounds,
  totalsByMember,
} from "../domain/attendance";

export interface StageOutcome {
  stage: string;
  outcome: "completed" | "skipped" | "interrupted";
  startedAt: number;
  endedAt: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Open a run for a session and remember it as the guild's live run. */
export function startRun(
  db: Db,
  input: { guildId: string; voiceChannelId: string; startedAt: number },
): number {
  const result = db
    .prepare(
      "INSERT INTO session_runs (guild_id, voice_channel_id, started_at, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(input.guildId, input.voiceChannelId, input.startedAt, nowIso());

  const runId = Number(result.lastInsertRowid);
  db.prepare(
    "INSERT INTO active_run (guild_id, run_id) VALUES (?, ?) ON CONFLICT (guild_id) DO UPDATE SET run_id = excluded.run_id",
  ).run(input.guildId, runId);

  return runId;
}

/** The run a guild's live session belongs to, if any. */
export function activeRunId(db: Db, guildId: string): number | null {
  const row = db.prepare("SELECT run_id FROM active_run WHERE guild_id = ?").get(guildId) as
    | { run_id: number }
    | undefined;

  return row?.run_id ?? null;
}

/** Adopt an existing run, so a restart continues it rather than opening a new one. */
export function attachRun(db: Db, guildId: string, runId: number): void {
  db.prepare(
    "INSERT INTO active_run (guild_id, run_id) VALUES (?, ?) ON CONFLICT (guild_id) DO UPDATE SET run_id = excluded.run_id",
  ).run(guildId, runId);
}

/** Forget the live run for a guild. Does not delete history. */
export function detachRun(db: Db, guildId: string): void {
  db.prepare("DELETE FROM active_run WHERE guild_id = ?").run(guildId);
}

/** Close a run, recording why it ended. */
export function finishRun(db: Db, runId: number, endedAt: number, stopReason: string): void {
  db.prepare("UPDATE session_runs SET ended_at = ?, stop_reason = ? WHERE id = ?").run(
    endedAt,
    stopReason,
    runId,
  );
}

export function recordStage(db: Db, runId: number, guildId: string, outcome: StageOutcome): void {
  db.prepare(
    `INSERT INTO stage_outcomes (run_id, guild_id, stage, started_at, ended_at, outcome)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(runId, guildId, outcome.stage, outcome.startedAt, outcome.endedAt, outcome.outcome);
}

/** Open a presence window for a member, if one is not already open. */
export function openAttendance(
  db: Db,
  input: { runId: number; guildId: string; userId: string; at: number },
): void {
  const open = db
    .prepare(
      "SELECT id FROM attendance WHERE run_id = ? AND user_id = ? AND left_at IS NULL LIMIT 1",
    )
    .get(input.runId, input.userId);

  if (open) return;

  db.prepare(
    "INSERT INTO attendance (run_id, guild_id, user_id, joined_at) VALUES (?, ?, ?, ?)",
  ).run(input.runId, input.guildId, input.userId, input.at);
}

/** Close a member's open presence window. */
export function closeAttendance(
  db: Db,
  input: { runId: number; userId: string; at: number },
): void {
  db.prepare(
    "UPDATE attendance SET left_at = ? WHERE run_id = ? AND user_id = ? AND left_at IS NULL",
  ).run(input.at, input.runId, input.userId);
}

/**
 * Close every open window for a run.
 *
 * Called on stop and on restart. Without this a crash would leave windows open
 * forever and a member would accrue credit for every hour since.
 */
export function closeAllAttendance(db: Db, runId: number, at: number): void {
  db.prepare("UPDATE attendance SET left_at = ? WHERE run_id = ? AND left_at IS NULL").run(
    at,
    runId,
  );
}

export function attendanceIntervals(db: Db, runId: number): Interval[] {
  const rows = db
    .prepare("SELECT user_id, joined_at, left_at FROM attendance WHERE run_id = ?")
    .all(runId) as { user_id: string; joined_at: number; left_at: number | null }[];

  return rows.map((row) => ({
    userId: row.user_id,
    startedAt: row.joined_at,
    // A window still open at read time counts up to the caller's "now".
    endedAt: row.left_at ?? Number.MAX_SAFE_INTEGER,
  }));
}

export function saveCredit(
  db: Db,
  runId: number,
  guildId: string,
  segments: readonly CreditSegment[],
): void {
  if (segments.length === 0) return;

  const insert = db.prepare(
    `INSERT INTO credit_segments (run_id, guild_id, user_id, stage, kind, started_at, ended_at, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const write = db.transaction(() => {
    for (const segment of segments) {
      insert.run(
        runId,
        guildId,
        segment.userId,
        segment.stage,
        segment.kind,
        segment.startedAt,
        segment.endedAt,
        segment.durationMs,
      );
    }
  });

  write();
}

function segmentsFor(db: Db, where: string, params: unknown[]): CreditSegment[] {
  const rows = db
    .prepare(
      `SELECT user_id, stage, kind, started_at, ended_at, duration_ms FROM credit_segments ${where}`,
    )
    .all(...params) as {
    user_id: string;
    stage: string;
    kind: "focus" | "break";
    started_at: number;
    ended_at: number;
    duration_ms: number;
  }[];

  return rows.map((row) => ({
    userId: row.user_id,
    stage: row.stage,
    kind: row.kind,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.duration_ms,
  }));
}

/** Totals for one run, focus and break apart, ranked by the sum. */
export function runTotals(db: Db, runId: number): MemberTotals[] {
  return totalsByMember(
    segmentsFor(db, "WHERE run_id = ?", [runId]),
    attendanceIntervals(db, runId),
  );
}

/**
 * Totals across many runs for a period, ranked by focus + break.
 *
 * `bounds` is null for all-time. The index on (guild_id, ended_at, user_id)
 * carries this, so it stays a range scan rather than a full table scan as the
 * history grows.
 */
export function leaderboardTotals(
  db: Db,
  guildId: string,
  bounds: PeriodBounds | null,
): MemberTotals[] {
  if (bounds === null) {
    return totalsByMember(segmentsFor(db, "WHERE guild_id = ?", [guildId]));
  }

  return totalsByMember(
    segmentsFor(db, "WHERE guild_id = ? AND ended_at >= ? AND ended_at < ?", [
      guildId,
      bounds.from,
      bounds.to,
    ]),
  );
}

/** Every stage outcome for a run, in order. */
export function stageCounts(
  db: Db,
  runId: number,
): { stage: string; outcome: StageOutcome["outcome"] }[] {
  return db
    .prepare("SELECT stage, outcome FROM stage_outcomes WHERE run_id = ? ORDER BY started_at ASC")
    .all(runId) as { stage: string; outcome: StageOutcome["outcome"] }[];
}

export interface RunSummaryRow {
  id: number;
  started_at: number;
  ended_at: number | null;
  stop_reason: string | null;
}

export function getRun(db: Db, runId: number): RunSummaryRow | null {
  const row = db
    .prepare("SELECT id, started_at, ended_at, stop_reason FROM session_runs WHERE id = ?")
    .get(runId) as RunSummaryRow | undefined;

  return row ?? null;
}

export type { LeaderboardPeriod };
