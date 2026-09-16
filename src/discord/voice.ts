/**
 * Voice-presence rules.
 *
 * Marzano is anchored to the voice channel whose text chat the command was used
 * in. Requiring the caller to actually be sitting in that channel is what makes
 * the "anyone in the call can steer" rule safe: you cannot pause, skip or stop
 * a session you are not part of.
 */

export interface VoiceContext {
  /** The voice channel the caller is connected to, if any. */
  callerVoiceChannelId: string | null | undefined;
  /** The voice channel whose chat the command was invoked in. */
  commandVoiceChannelId: string | null | undefined;
}

/**
 * True when the caller is in the same voice channel the command was used in.
 *
 * A command used in a text channel (no associated voice channel) never
 * satisfies this, because there is no session context to attach to.
 */
export function isParticipant(context: VoiceContext): boolean {
  const { callerVoiceChannelId, commandVoiceChannelId } = context;

  if (!callerVoiceChannelId || !commandVoiceChannelId) return false;
  return callerVoiceChannelId === commandVoiceChannelId;
}

/** Human-readable reason for a failed presence check, safe to show ephemerally. */
export function participantRequirementMessage(): string {
  return "You need to be in this voice channel to do that.";
}
