/**
 * Attendance and leaderboard credit.
 *
 * Pure functions over plain intervals, so the arithmetic that decides who gets
 * credit for what can be tested exhaustively without a database or a clock.
 *
 * Two rules drive everything here:
 *
 *   1. Credit is the **overlap** between a member's presence and a stage that
 *      was actually running. Somebody who joins halfway through a focus period
 *      is credited for the half they were there for.
 *   2. Focus and break credit are computed and stored **separately**. They are
 *      summed for ranking, but keeping them apart is what lets the summary and
 *      the leaderboard answer different questions later without having to
 *      re-derive history.
 */

export type StageKind = "focus" | "break";

/** A window during which one member was present in the voice channel. */
export interface Interval {
  userId: string;
  startedAt: number;
  endedAt: number;
}

/** A window during which a stage was actually running. */
export interface StageWindow {
  stage: string;
  kind: StageKind;
  startedAt: number;
  endedAt: number;
}

export interface CreditSegment {
  userId: string;
  stage: string;
  kind: StageKind;
  startedAt: number;
  endedAt: number;
  durationMs: number;
}

/** Whether a stage counts as focus or as a break. */
export function stageKind(stage: string): StageKind {
  return stage === "focus" ? "focus" : "break";
}

/** The overlap of two half-open intervals, or 0 when they do not touch. */
export function overlapMs(
  left: { startedAt: number; endedAt: number },
  right: { startedAt: number; endedAt: number },
): number {
  const start = Math.max(left.startedAt, right.startedAt);
  const end = Math.min(left.endedAt, right.endedAt);
  return Math.max(0, end - start);
}

/**
 * Credit every member for their overlap with a single stage window.
 *
 * Members with no overlap produce no segment at all, rather than a zero-length
 * row - the absence is the honest representation of "was not there", and it
 * keeps the table from filling with noise.
 */
export function creditForStage(
  window: StageWindow,
  intervals: readonly Interval[],
): CreditSegment[] {
  if (window.endedAt <= window.startedAt) return [];

  const segments: CreditSegment[] = [];

  for (const interval of intervals) {
    const durationMs = overlapMs(interval, window);
    if (durationMs <= 0) continue;

    const startedAt = Math.max(window.startedAt, interval.startedAt);
    const endedAt = Math.min(window.endedAt, interval.endedAt);

    segments.push({
      userId: interval.userId,
      stage: window.stage,
      kind: window.kind,
      startedAt,
      endedAt,
      durationMs,
    });
  }

  return segments;
}

/**
 * Fold intervals into one non-overlapping timeline per member.
 *
 * A member can appear to leave and rejoin across a restart or a failed lookup,
 * which produces adjacent or overlapping intervals. Merging them means credit
 * is counted once for time they were demonstrably present, instead of twice
 * because the bookkeeping was noisy.
 */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const byUser = new Map<string, Interval[]>();

  for (const interval of intervals) {
    if (interval.endedAt <= interval.startedAt) continue;
    const existing = byUser.get(interval.userId);
    if (existing) existing.push(interval);
    else byUser.set(interval.userId, [interval]);
  }

  const merged: Interval[] = [];

  for (const [userId, userIntervals] of byUser) {
    const ordered = [...userIntervals].sort((left, right) => left.startedAt - right.startedAt);
    let current = ordered[0];

    if (!current) continue;

    for (const next of ordered.slice(1)) {
      if (next.startedAt <= current.endedAt) {
        current = {
          userId,
          startedAt: current.startedAt,
          endedAt: Math.max(current.endedAt, next.endedAt),
        };
        continue;
      }
      merged.push(current);
      current = next;
    }

    merged.push(current);
  }

  return merged.sort((left, right) => left.startedAt - right.startedAt);
}

export interface MemberTotals {
  userId: string;
  focusMs: number;
  breakMs: number;
  /** focus + break; what the leaderboard ranks by. */
  totalMs: number;
  /** Distinct attendance across the whole run, present or not while a stage ran. */
  attendedMs: number;
}

/**
 * Totals per member, with focus and break kept apart.
 *
 * `totalMs` is deliberately the sum rather than anything cleverer: breaks run
 * whether or not anyone is working, so ranking by focus alone and ranking by the
 * sum are genuinely different choices, and this module should not quietly pick
 * one. The caller decides, and both numbers are available.
 */
export function totalsByMember(
  segments: readonly CreditSegment[],
  attended: readonly Interval[] = [],
): MemberTotals[] {
  const totals = new Map<string, MemberTotals>();

  function entry(userId: string): MemberTotals {
    const existing = totals.get(userId);
    if (existing) return existing;
    const created: MemberTotals = { userId, focusMs: 0, breakMs: 0, totalMs: 0, attendedMs: 0 };
    totals.set(userId, created);
    return created;
  }

  for (const segment of segments) {
    const record = entry(segment.userId);
    if (segment.kind === "focus") record.focusMs += segment.durationMs;
    else record.breakMs += segment.durationMs;
    record.totalMs += segment.durationMs;
  }

  // A member who was present but never overlapped a stage still attended.
  for (const interval of mergeIntervals(attended)) {
    const record = entry(interval.userId);
    record.attendedMs += interval.endedAt - interval.startedAt;
  }

  return [...totals.values()].sort((left, right) => {
    if (right.totalMs !== left.totalMs) return right.totalMs - left.totalMs;
    // Deterministic tie-break, so a shared total does not reshuffle per query.
    return left.userId.localeCompare(right.userId);
  });
}

export type LeaderboardPeriod = "monthly" | "yearly" | "all-time";

export interface PeriodBounds {
  /** Inclusive. */
  from: number;
  /** Exclusive. */
  to: number;
}

/**
 * UTC calendar bounds for a leaderboard period.
 *
 * UTC rather than local time on purpose: the server may be anywhere, members
 * are in several time zones, and a boundary that moves with the host's locale
 * would give two people different answers for the same month.
 */
export function periodBounds(period: LeaderboardPeriod, now: number): PeriodBounds | null {
  if (period === "all-time") return null;

  const date = new Date(now);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();

  if (period === "yearly") {
    return { from: Date.UTC(year, 0, 1), to: Date.UTC(year + 1, 0, 1) };
  }

  return { from: Date.UTC(year, month, 1), to: Date.UTC(year, month + 1, 1) };
}

/** `3h 20m`, for totals that are usually hours rather than minutes. */
export function formatCredit(milliseconds: number): string {
  const totalMinutes = Math.floor(Math.max(0, milliseconds) / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  return `${minutes}m`;
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/**
 * The natural name of a leaderboard period, e.g. "September 2026".
 *
 * The calendar boundary is still UTC; only the *presentation* changes, from a
 * machine range like "2026-09-01 to 2026-09-30" to the name people use.
 */
export function periodLabel(period: LeaderboardPeriod, now: number): string {
  if (period === "all-time") return "All time";
  const date = new Date(now);
  if (period === "yearly") return String(date.getUTCFullYear());
  return `${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/**
 * Total minutes as the leaderboard shows it: a single number, no hour/minute
 * split and no focus/break breakdown. The user asked for minutes, so minutes it
 * is - the split is still stored and visible in the summary, just not ranked by.
 */
export function formatMinutes(milliseconds: number): string {
  return `${Math.max(0, Math.round(milliseconds / 60_000))} min`;
}
