import type { MemberTotals } from "../domain/attendance";
import { formatCredit, periodBounds, type LeaderboardPeriod } from "../domain/attendance";
import type { SessionEmbed } from "./session-view";

/**
 * The session summary and the leaderboard.
 *
 * Members are rendered as mentions (`<@id>`) rather than stored names. Discord
 * resolves those to whatever the person is called *right now*, which means the
 * history never holds a stale name and we never persist a display name at all.
 */

export interface SummaryInput {
  /** Why the session ended, in the words the supervisor recorded. */
  reason: string;
  startedAt: number;
  endedAt: number;
  /** Stage outcomes in order, so counts can be derived. */
  outcomes: readonly { stage: string; outcome: string }[];
  totals: readonly MemberTotals[];
}

const STAGE_NAMES: Record<string, string> = {
  focus: "Focus periods",
  short_break: "Short breaks",
  long_break: "Long breaks",
};

function countOutcomes(outcomes: readonly { stage: string; outcome: string }[]) {
  const completed: Record<string, number> = {};
  const skipped: Record<string, number> = {};

  for (const entry of outcomes) {
    const bucket = entry.outcome === "completed" ? completed : skipped;
    bucket[entry.stage] = (bucket[entry.stage] ?? 0) + 1;
  }

  return { completed, skipped };
}

export function buildSummaryEmbed(input: SummaryInput): SessionEmbed {
  const { completed, skipped } = countOutcomes(input.outcomes);

  const lines = Object.keys(STAGE_NAMES).map((stage) => {
    const done = completed[stage] ?? 0;
    const cut = skipped[stage] ?? 0;
    const suffix = cut > 0 ? ` (${cut} skipped)` : "";
    return `**${STAGE_NAMES[stage]}:** ${done}${suffix}`;
  });

  const attendance =
    input.totals.length === 0
      ? ["Nobody was in the channel long enough to register."]
      : input.totals.map((total) => {
          const parts = [`**focus** ${formatCredit(total.focusMs)}`];
          // Break credit is only worth showing when there is some, so a normal
          // working session's line stays readable.
          if (total.breakMs > 0) parts.push(`**break** ${formatCredit(total.breakMs)}`);
          return `<@${total.userId}> - ${parts.join(", ")}`;
        });

  return {
    title: "\u{1F345} Session summary",
    description: `Ended because ${input.reason}.`,
    fields: [
      {
        name: "Duration",
        value: formatCredit(input.endedAt - input.startedAt),
        inline: true,
      },
      { name: "Who turned up", value: input.totals.length.toString(), inline: true },
      { name: "Stages", value: lines.join("\n"), inline: false },
      { name: "Attendance", value: attendance.join("\n"), inline: false },
    ],
  };
}

export interface LeaderboardInput {
  period: LeaderboardPeriod;
  totals: readonly MemberTotals[];
  now: number;
}

export const PERIOD_LABELS: Record<LeaderboardPeriod, string> = {
  monthly: "This month",
  yearly: "This year",
  "all-time": "All time",
};

export function buildLeaderboardEmbed(input: LeaderboardInput): SessionEmbed {
  const { period, totals, now } = input;

  const bounds = periodBounds(period, now);
  const window =
    bounds === null
      ? "Everything ever recorded here."
      : `${new Date(bounds.from).toISOString().slice(0, 10)} to ${new Date(bounds.to - 1)
          .toISOString()
          .slice(0, 10)} (UTC)`;

  const ranked = totals.filter((total) => total.totalMs > 0).slice(0, 10);

  const lines = ranked.map((total, index) => {
    const medal = ["\u{1F947}", "\u{1F948}", "\u{1F949}"][index] ?? `${index + 1}.`;
    // Focus and break are shown apart and the rank uses the sum, so a
    // break-heavy total is visible rather than hidden inside one number.
    return `${medal} <@${total.userId}> - **${formatCredit(total.totalMs)}** (focus ${formatCredit(total.focusMs)}, break ${formatCredit(total.breakMs)})`;
  });

  return {
    title: `\u{1F3C6} Pomodoro leaderboard - ${PERIOD_LABELS[period]}`,
    description: lines.length > 0 ? lines.join("\n") : "No credited Pomodoro time yet.",
    fields: [{ name: "Period", value: window, inline: false }],
  };
}
