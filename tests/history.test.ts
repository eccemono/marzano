import { describe, expect, it } from "vitest";

import { openInMemoryDatabase } from "../src/db/database";
import { migrate } from "../src/db/migrations";
import {
  activeRunId,
  attendanceIntervals,
  leaderboardTotals,
  openAttendance,
  runTotals,
  saveCredit,
  startRun,
} from "../src/db/history-repository";
import {
  creditForStage,
  formatCredit,
  mergeIntervals,
  overlapMs,
  periodBounds,
  stageKind,
  totalsByMember,
} from "../src/domain/attendance";
import { SessionHistory } from "../src/session/history";
import { buildLeaderboardEmbed, buildSummaryEmbed } from "../src/discord/history-views";
import { silentLogger } from "./helpers/harness";

const GUILD = "111111111111111111";
const CHANNEL = "222222222222222222";
const ALICE = "333333333333333333";
const BOB = "444444444444444444";

const T0 = 1_760_000_000_000;
const MINUTE = 60_000;
const HOUR = 3_600_000;

describe("credit arithmetic", () => {
  it("classifies focus apart from both kinds of break", () => {
    expect(stageKind("focus")).toBe("focus");
    expect(stageKind("short_break")).toBe("break");
    expect(stageKind("long_break")).toBe("break");
  });

  it("measures only the overlap", () => {
    expect(overlapMs({ startedAt: 0, endedAt: 100 }, { startedAt: 50, endedAt: 150 })).toBe(50);
    expect(overlapMs({ startedAt: 0, endedAt: 100 }, { startedAt: 200, endedAt: 300 })).toBe(0);
  });

  it("credits a member only for the part they were present for", () => {
    // Joined ten minutes into a twenty-five minute focus period.
    const segments = creditForStage(
      { stage: "focus", kind: "focus", startedAt: T0, endedAt: T0 + 25 * MINUTE },
      [{ userId: ALICE, startedAt: T0 + 10 * MINUTE, endedAt: T0 + 25 * MINUTE }],
    );

    expect(segments).toHaveLength(1);
    expect(segments[0]?.durationMs).toBe(15 * MINUTE);
    expect(segments[0]?.kind).toBe("focus");
  });

  it("produces no segment for somebody who was not there", () => {
    const segments = creditForStage(
      { stage: "focus", kind: "focus", startedAt: T0, endedAt: T0 + 25 * MINUTE },
      [{ userId: BOB, startedAt: T0 + 40 * MINUTE, endedAt: T0 + 50 * MINUTE }],
    );

    expect(segments).toEqual([]);
  });

  it("merges overlapping presence so time is never credited twice", () => {
    // A restart can leave adjacent windows for the same member.
    const merged = mergeIntervals([
      { userId: ALICE, startedAt: T0, endedAt: T0 + 10 * MINUTE },
      { userId: ALICE, startedAt: T0 + 5 * MINUTE, endedAt: T0 + 20 * MINUTE },
    ]);

    expect(merged).toEqual([{ userId: ALICE, startedAt: T0, endedAt: T0 + 20 * MINUTE }]);
  });

  it("keeps focus and break credit in separate totals and sums them for ranking", () => {
    const totals = totalsByMember([
      {
        userId: ALICE,
        stage: "focus",
        kind: "focus",
        startedAt: 0,
        endedAt: 0,
        durationMs: 25 * MINUTE,
      },
      {
        userId: ALICE,
        stage: "short_break",
        kind: "break",
        startedAt: 0,
        endedAt: 0,
        durationMs: 5 * MINUTE,
      },
    ]);

    expect(totals[0]?.focusMs).toBe(25 * MINUTE);
    expect(totals[0]?.breakMs).toBe(5 * MINUTE);
    expect(totals[0]?.totalMs).toBe(30 * MINUTE);
  });

  it("ranks by focus plus break", () => {
    const totals = totalsByMember([
      {
        userId: ALICE,
        stage: "focus",
        kind: "focus",
        startedAt: 0,
        endedAt: 0,
        durationMs: 20 * MINUTE,
      },
      {
        userId: BOB,
        stage: "focus",
        kind: "focus",
        startedAt: 0,
        endedAt: 0,
        durationMs: 15 * MINUTE,
      },
      {
        userId: BOB,
        stage: "short_break",
        kind: "break",
        startedAt: 0,
        endedAt: 0,
        durationMs: 10 * MINUTE,
      },
    ]);

    expect(totals.map((entry) => entry.userId)).toEqual([BOB, ALICE]);
  });

  it("breaks ties deterministically", () => {
    const tie = [
      {
        userId: BOB,
        stage: "focus",
        kind: "focus" as const,
        startedAt: 0,
        endedAt: 0,
        durationMs: 600,
      },
      {
        userId: ALICE,
        stage: "focus",
        kind: "focus" as const,
        startedAt: 0,
        endedAt: 0,
        durationMs: 600,
      },
    ];

    // Same input, same order, every time.
    expect(totalsByMember(tie).map((entry) => entry.userId)).toEqual(
      totalsByMember([...tie].reverse()).map((entry) => entry.userId),
    );
  });

  it("still counts a member who attended but overlapped no stage", () => {
    const totals = totalsByMember([], [{ userId: BOB, startedAt: T0, endedAt: T0 + 5 * MINUTE }]);

    expect(totals[0]?.attendedMs).toBe(5 * MINUTE);
    expect(totals[0]?.totalMs).toBe(0);
  });
});

describe("leaderboard periods", () => {
  it("uses UTC calendar boundaries", () => {
    // 2026-09-16, so the month runs 1 Sep - 30 Sep and the year 1 Jan - 31 Dec.
    const now = Date.UTC(2026, 8, 16, 12);
    const month = periodBounds("monthly", now);
    const year = periodBounds("yearly", now);

    expect(new Date(month?.from ?? 0).toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(new Date(month?.to ?? 0).toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(new Date(year?.from ?? 0).toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("has no bounds for all-time", () => {
    expect(periodBounds("all-time", T0)).toBeNull();
  });

  it("formats totals in hours and minutes", () => {
    expect(formatCredit(3 * HOUR + 20 * MINUTE)).toBe("3h 20m");
    expect(formatCredit(45 * MINUTE)).toBe("45m");
  });
});

describe("history persistence", () => {
  function fresh() {
    const db = openInMemoryDatabase();
    migrate(db);
    return db;
  }

  it("records a completed stage and credits the members present", () => {
    const db = fresh();
    const history = new SessionHistory({ db, logger: silentLogger() });

    history.begin(GUILD, CHANNEL, T0);
    history.syncMembers(GUILD, [ALICE, BOB], T0 + 10 * MINUTE);
    history.endStage(GUILD, {
      stage: "focus",
      startedAt: T0,
      endedAt: T0 + 25 * MINUTE,
      outcome: "completed",
    });

    const totals = runTotals(db, 1);

    // Both joined ten minutes in, so both get fifteen minutes - not twenty-five.
    expect(totals.map((entry) => [entry.userId, entry.focusMs])).toEqual([
      [ALICE, 15 * MINUTE],
      [BOB, 15 * MINUTE],
    ]);
  });

  it("records a skipped stage without crediting it", () => {
    const db = fresh();
    const history = new SessionHistory({ db, logger: silentLogger() });

    history.begin(GUILD, CHANNEL, T0);
    history.syncMembers(GUILD, [ALICE], T0);
    history.endStage(GUILD, {
      stage: "focus",
      startedAt: T0,
      endedAt: T0 + 5 * MINUTE,
      outcome: "skipped",
    });

    // The stage is in the history...
    const stages = db
      .prepare("SELECT stage, outcome FROM stage_outcomes WHERE run_id = 1")
      .all() as { outcome: string }[];
    expect(stages).toEqual([{ stage: "focus", outcome: "skipped" }]);

    // ...but nobody is credited for work they did not do.
    expect(runTotals(db, 1).every((entry) => entry.focusMs === 0)).toBe(true);
  });

  it("credits focus and break separately across a full cycle", () => {
    const db = fresh();
    const history = new SessionHistory({ db, logger: silentLogger() });

    history.begin(GUILD, CHANNEL, T0);
    history.syncMembers(GUILD, [ALICE], T0);

    history.endStage(GUILD, {
      stage: "focus",
      startedAt: T0,
      endedAt: T0 + 25 * MINUTE,
      outcome: "completed",
    });
    history.endStage(GUILD, {
      stage: "short_break",
      startedAt: T0 + 25 * MINUTE,
      endedAt: T0 + 30 * MINUTE,
      outcome: "completed",
    });

    const totals = runTotals(db, 1)[0];

    expect(totals?.focusMs).toBe(25 * MINUTE);
    expect(totals?.breakMs).toBe(5 * MINUTE);
    expect(totals?.totalMs).toBe(30 * MINUTE);
  });

  it("closes presence windows so nobody accrues credit for time after a crash", () => {
    const db = fresh();
    const history = new SessionHistory({ db, logger: silentLogger() });

    history.begin(GUILD, CHANNEL, T0);
    history.syncMembers(GUILD, [ALICE], T0);

    // The process dies mid-stage and comes back an hour later.
    const restart = T0 + HOUR;
    history.adopt(GUILD, CHANNEL, restart);

    // The old window is closed at the restart boundary, not left open.
    const intervals = attendanceIntervals(db, 1);
    expect(intervals[0]?.endedAt).toBe(restart);

    // And it is the same run, so the session counts once rather than twice.
    expect(activeRunId(db, GUILD)).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM session_runs").get()).toEqual({ n: 1 });
  });

  it("stops crediting once a member leaves", () => {
    const db = fresh();
    const history = new SessionHistory({ db, logger: silentLogger() });

    history.begin(GUILD, CHANNEL, T0);
    history.syncMembers(GUILD, [ALICE], T0);
    history.syncMembers(GUILD, [], T0 + 10 * MINUTE);

    history.endStage(GUILD, {
      stage: "focus",
      startedAt: T0,
      endedAt: T0 + 25 * MINUTE,
      outcome: "completed",
    });

    expect(runTotals(db, 1)[0]?.focusMs).toBe(10 * MINUTE);
  });

  it("reports the run when it finishes and detaches it", () => {
    const db = fresh();
    const history = new SessionHistory({ db, logger: silentLogger() });

    history.begin(GUILD, CHANNEL, T0);
    history.syncMembers(GUILD, [ALICE], T0);
    history.endStage(GUILD, {
      stage: "focus",
      startedAt: T0,
      endedAt: T0 + 25 * MINUTE,
      outcome: "completed",
    });

    const report = history.finish(GUILD, "stopped by a participant", T0 + 26 * MINUTE);

    expect(report?.totals[0]?.focusMs).toBe(25 * MINUTE);
    expect(report?.outcomes).toEqual([{ stage: "focus", outcome: "completed" }]);
    expect(activeRunId(db, GUILD)).toBeNull();
  });

  it("aggregates a guild's credit across runs for a period", () => {
    const db = fresh();
    const runOne = startRun(db, { guildId: GUILD, voiceChannelId: CHANNEL, startedAt: T0 });
    const runTwo = startRun(db, { guildId: GUILD, voiceChannelId: CHANNEL, startedAt: T0 + HOUR });

    openAttendance(db, { runId: runOne, guildId: GUILD, userId: ALICE, at: T0 });
    saveCredit(db, runOne, GUILD, [
      {
        userId: ALICE,
        stage: "focus",
        kind: "focus",
        startedAt: T0,
        endedAt: T0,
        durationMs: 25 * MINUTE,
      },
    ]);
    saveCredit(db, runTwo, GUILD, [
      {
        userId: ALICE,
        stage: "focus",
        kind: "focus",
        startedAt: T0,
        endedAt: T0,
        durationMs: 25 * MINUTE,
      },
    ]);

    const allTime = leaderboardTotals(db, GUILD, null);
    const month = leaderboardTotals(db, GUILD, periodBounds("monthly", T0 + HOUR));

    expect(allTime[0]?.totalMs).toBe(50 * MINUTE);
    expect(month[0]?.totalMs).toBe(50 * MINUTE);
  });

  it("excludes time outside the requested period", () => {
    const db = fresh();
    const runId = startRun(db, { guildId: GUILD, voiceChannelId: CHANNEL, startedAt: T0 });

    saveCredit(db, runId, GUILD, [
      {
        userId: ALICE,
        stage: "focus",
        kind: "focus",
        startedAt: T0,
        endedAt: T0,
        durationMs: 25 * MINUTE,
      },
    ]);

    // Ask about a month that has not happened yet.
    const nextMonth = periodBounds("monthly", T0 + 40 * 24 * HOUR);

    expect(leaderboardTotals(db, GUILD, nextMonth)).toEqual([]);
  });
});

describe("summary and leaderboard views", () => {
  const totals = [
    {
      userId: ALICE,
      focusMs: 50 * MINUTE,
      breakMs: 10 * MINUTE,
      totalMs: 60 * MINUTE,
      attendedMs: 60 * MINUTE,
    },
    {
      userId: BOB,
      focusMs: 25 * MINUTE,
      breakMs: 0,
      totalMs: 25 * MINUTE,
      attendedMs: 25 * MINUTE,
    },
  ];

  it("summarises what actually happened, with skipped stages called out", () => {
    const embed = buildSummaryEmbed({
      reason: "everyone left the voice channel",
      startedAt: T0,
      endedAt: T0 + HOUR,
      outcomes: [
        { stage: "focus", outcome: "completed" },
        { stage: "focus", outcome: "skipped" },
        { stage: "short_break", outcome: "completed" },
      ],
      totals,
    });

    expect(embed.description).toContain("everyone left the voice channel");
    expect(embed.fields.find((field) => field.name === "Stages")?.value).toContain("1 skipped");
    expect(embed.fields.find((field) => field.name === "Who turned up")?.value).toBe("2");
  });

  it("shows focus and break apart in the summary", () => {
    const embed = buildSummaryEmbed({
      reason: "stopped",
      startedAt: T0,
      endedAt: T0 + HOUR,
      outcomes: [],
      totals,
    });

    const attendance = embed.fields.find((field) => field.name === "Attendance")?.value ?? "";

    expect(attendance).toContain("focus** 50m");
    expect(attendance).toContain("break** 10m");
  });

  it("marks the top three in the leaderboard and ranks by the combined total", () => {
    const embed = buildLeaderboardEmbed({ period: "monthly", totals, now: T0 });

    expect(embed.title).toContain("This month");
    expect(embed.description.indexOf(ALICE)).toBeLessThan(embed.description.indexOf(BOB));
    expect(embed.description).toContain("\u{1F947}");
  });

  it("says so when there is nothing to rank", () => {
    const embed = buildLeaderboardEmbed({ period: "all-time", totals: [], now: T0 });

    expect(embed.description).toContain("No credited Pomodoro time yet");
  });

  it("names the period it is showing", () => {
    const embed = buildLeaderboardEmbed({ period: "monthly", totals, now: Date.UTC(2026, 8, 16) });

    expect(embed.fields[0]?.value).toContain("2026-09-01");
  });
});
