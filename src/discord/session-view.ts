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
  footer: { text: string };
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

/** Progress bar such as `[#####-----]`. */
export function progressBar(elapsed: number, duration: number, width = 10): string {
  if (duration <= 0) return `[${"-".repeat(width)}]`;

  const ratio = Math.min(1, Math.max(0, elapsed / duration));
  const filled = Math.round(ratio * width);

  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
}

export function cyclePosition(session: TimerSession): string {
  const total = session.config.cyclesBeforeLongBreak;
  const completedInCycle = session.completedFocusStages % total;
  // A long break lands on the multiple, so show it as the completed cycle.
  const position =
    session.stage === "long_break" && completedInCycle === 0 ? total : completedInCycle;

  return `${position} of ${total}`;
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

  return {
    title: `${STAGE_ICONS[session.stage]} ${STAGE_LABELS[session.stage]}${stateLabel}`,
    description: paused
      ? `Paused with ${formatDuration(remaining)} left in this stage.`
      : `${progressBar(elapsed, duration)} ${formatDuration(remaining)} remaining`,
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
    footer: { text: paused ? "Paused - resume when you are ready" : "Refreshes automatically" },
  };
}
