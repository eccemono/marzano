import type { TimerSession } from "../domain/timer";
import { elapsedMs, isPaused, remainingMs, stageDurationMs } from "../domain/timer";

/**
 * The session status message.
 *
 * The embed is built from the session plus the current time, as a plain object,
 * so every stage and state can be asserted in tests without a Discord client.
 *
 * The rendered time is always derived from the session's deadlines. Nothing
 * here accumulates, so re-rendering is idempotent and a missed refresh simply
 * shows a slightly stale number rather than a wrong one.
 *
 * The countdown is a Discord relative timestamp rather than a number we
 * recompute. Discord renders `<t:...:R>` in each client and keeps it current on
 * its own, so the countdown stays smooth without the bot editing the message
 * every few seconds - fewer API calls, no rate limits, and nothing to drift.
 */

export interface SessionEmbedField {
  name: string;
  value: string;
  inline: boolean;
}

export interface SessionEmbed {
  title: string;
  description: string;
  fields: SessionEmbedField[];
}

export const STAGE_LABELS: Record<TimerSession["stage"], string> = {
  focus: "Focus",
  short_break: "Short break",
  long_break: "Long break",
};

export const STAGE_ICONS: Record<TimerSession["stage"], string> = {
  focus: "\u{1F345}",
  short_break: "\u{2615}",
  long_break: "\u{1F37D}\u{FE0F}",
};

/** `24m 30s`, or `1h 05m` past an hour. */
export function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  }
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** Progress bar such as `[ooooo-----]`. */
export function progressBar(elapsed: number, duration: number, width = 10): string {
  if (duration <= 0) return `[${"-".repeat(width)}]`;

  const ratio = Math.min(1, Math.max(0, elapsed / duration));
  const filled = Math.round(ratio * width);

  return `[${"o".repeat(filled)}${"-".repeat(width - filled)}]`;
}

/**
 * Discord's client-rendered countdown for a deadline.
 *
 * `R` is the relative style: each client shows "in 24 minutes" and keeps it
 * updated itself.
 */
export function relativeTimestamp(instant: number): string {
  return `<t:${Math.floor(instant / 1_000)}:R>`;
}

/**
 * Where the session sits within the run, as an expanding window.
 *
 * The counter does not reset with every long break. The first long break window
 * is 1-4, the next is 5-8, the next 9-12, and so on - so a long session reads as
 * continuous progress instead of restarting at 1 every hour.
 *
 * A break belongs to the focus period it follows, so a long break after four
 * focus stages shows as 4/4 rather than jumping ahead.
 */
export function cyclePosition(session: TimerSession): string {
  const size = session.config.cyclesBeforeLongBreak;
  const ordinal =
    session.stage === "focus" ? session.completedFocusStages + 1 : session.completedFocusStages;

  // Before the first focus stage completes there is nothing to count yet.
  const position = Math.max(1, ordinal);
  const window = Math.ceil(position / size);
  const windowEnd = window * size;

  return `${position}/${windowEnd}`;
}

/**
 * A short line for the voice channel's own status field.
 *
 * Deliberately terse: Discord truncates this hard, and it is a glance-level cue
 * rather than a second copy of the embed. Returns null when there is nothing
 * worth showing.
 */
export function channelStatusText(session: TimerSession, now: number): string | null {
  if (session.state === "stopped") return null;

  const label = STAGE_LABELS[session.stage];

  if (isPaused(session)) {
    return `${label} - paused`;
  }

  const remaining = remainingMs(session, now);
  const minutes = Math.max(1, Math.ceil(remaining / 60_000));

  return `${label} - ${minutes}m left`;
}

export interface SessionEmbedInput {
  session: TimerSession;
  now: number;
}

export function buildSessionEmbed(input: SessionEmbedInput): SessionEmbed {
  const { session, now } = input;

  const duration = stageDurationMs(session.stage, session.config);
  const remaining = remainingMs(session, now);
  const elapsed = elapsedMs(session, now);

  const paused = isPaused(session);
  const stateLabel = paused ? " (paused)" : "";

  const split = `${session.config.focusMinutes}/${session.config.shortBreakMinutes}/${session.config.longBreakMinutes}`;

  // A paused session has no deadline - it resumes on an explicit action - so it
  // gets a fixed duration instead of a timestamp that would keep ticking.
  const deadline = session.stageEndsAt;
  const countdown =
    paused || deadline === null
      ? `Paused with ${formatDuration(remaining)} left in this stage.`
      : `${progressBar(elapsed, duration)} Ends ${relativeTimestamp(deadline)}`;

  return {
    title: `${STAGE_ICONS[session.stage]} ${STAGE_LABELS[session.stage]}${stateLabel}`,
    description: countdown,
    fields: [
      { name: "Cycle", value: cyclePosition(session), inline: true },
      { name: "Split", value: split, inline: true },
      {
        name: "Sound",
        value: session.config.soundEnabled ? `on (${session.config.soundVolume}%)` : "off",
        inline: true,
      },
      { name: "Voice channel", value: `<#${session.voiceChannelId}>`, inline: false },
    ],
  };
}
