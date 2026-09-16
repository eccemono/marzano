import { type Split, SplitError, parseSplit } from "../domain/split";

/**
 * The decision behind `/pomodoro start`.
 *
 * Kept separate from the handler so every branch - not in the channel, already
 * running elsewhere, no saved configuration, malformed split - is testable
 * without a Discord connection, and so the handler stays a thin translation
 * layer between an interaction and this decision.
 */

export type StartDecision =
  | { kind: "start"; split: Split | null }
  | { kind: "open-setup"; reason: "unconfigured" | "invalid-split"; message: string }
  | { kind: "reject"; reason: "not-in-channel" | "already-running"; message: string };

export interface StartInput {
  callerVoiceChannelId: string | null | undefined;
  commandVoiceChannelId: string | null | undefined;
  /** Whether this voice channel has a saved configuration. */
  hasStoredConfig: boolean;
  /** Raw split text supplied with the command, if any. */
  splitInput: string | null | undefined;
  /** The voice channel holding the guild's active session, if any. */
  activeSessionVoiceChannelId: string | null | undefined;
}

export function decideStart(input: StartInput): StartDecision {
  const caller = input.callerVoiceChannelId ?? null;
  const target = input.commandVoiceChannelId ?? null;

  if (!caller || !target || caller !== target) {
    return {
      kind: "reject",
      reason: "not-in-channel",
      message: "You need to be in this voice channel to start a session here.",
    };
  }

  // Discord allows a bot one voice connection per guild, so a session
  // elsewhere in the guild has to be surfaced rather than silently ignored.
  const active = input.activeSessionVoiceChannelId ?? null;
  if (active !== null) {
    return {
      kind: "reject",
      reason: "already-running",
      message:
        active === target
          ? "A session is already running in this channel."
          : `A session is already running in <#${active}>. Stop it there first.`,
    };
  }

  const rawSplit = (input.splitInput ?? "").trim();

  if (rawSplit.length > 0) {
    try {
      return { kind: "start", split: parseSplit(rawSplit) };
    } catch (error) {
      if (error instanceof SplitError) {
        // A malformed split opens the setup modal, pre-filled context and all,
        // rather than dead-ending the user with an error.
        return { kind: "open-setup", reason: "invalid-split", message: error.message };
      }
      throw error;
    }
  }

  if (!input.hasStoredConfig) {
    return {
      kind: "open-setup",
      reason: "unconfigured",
      message: "This voice channel has no saved split yet. Set one up to start.",
    };
  }

  return { kind: "start", split: null };
}
