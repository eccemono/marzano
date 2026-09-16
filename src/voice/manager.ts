/**
 * Session audio orchestration.
 *
 * The rules this encodes:
 *
 *   - The bot joins the session's voice channel and is muted and deafened while
 *     nothing is playing. It unmutes and undeafens only for the length of a cue,
 *     then goes quiet again.
 *   - A session start plays the cue and then the bell. Every later stage
 *     boundary plays the bell only - there are no spoken announcements, and no
 *     text-to-speech anywhere in the bot.
 *   - Audio is strictly decorative. Every failure path here ends in a log line
 *     and a `return`; nothing in this class can fail a session, and callers are
 *     expected to invoke it without awaiting so playback never delays the timer.
 */

import type { Logger } from "../logger";

import type { VoiceGateway } from "./gateway";
import { BELL, START_CUE, type SoundName } from "./sounds";

/** The subset of a session this layer needs. */
export interface VoiceSession {
  guildId: string;
  voiceChannelId: string;
  config: {
    soundEnabled: boolean;
    soundVolume: number;
  };
}

export interface SessionVoiceOptions {
  gateway: VoiceGateway;
  logger: Logger;
}

export class SessionVoice {
  private readonly gateway: VoiceGateway;
  private readonly logger: Logger;
  private joinedChannelId: string | null = null;

  constructor(options: SessionVoiceOptions) {
    this.gateway = options.gateway;
    this.logger = options.logger;
  }

  /** The channel currently joined, or null. */
  get channelId(): string | null {
    return this.joinedChannelId;
  }

  /**
   * Join the session's voice channel and go silent.
   *
   * Returns whether the bot ended up connected. A failure - a deleted channel,
   * a missing Connect permission, a full channel - is logged and reported, not
   * thrown, because audio is optional and the timer is not.
   */
  async join(session: VoiceSession): Promise<boolean> {
    if (this.joinedChannelId === session.voiceChannelId && this.gateway.connected) {
      await this.silence();
      return true;
    }

    try {
      await this.gateway.join(session.guildId, session.voiceChannelId);
      this.joinedChannelId = session.voiceChannelId;
    } catch (error) {
      this.joinedChannelId = null;
      this.logger.warn("could not join the voice channel; the session continues without audio", {
        guildId: session.guildId,
        channelId: session.voiceChannelId,
        reason: describe(error),
      });
      return false;
    }

    await this.silence();
    return true;
  }

  /** Cue and bell, played once when a session starts. */
  async announceStart(session: VoiceSession): Promise<void> {
    await this.announce(session, true);
  }

  /**
   * Bell only, played at a stage boundary.
   *
   * Deliberately never plays the start cue: a break starting should sound
   * different from a session starting.
   */
  async announceTransition(session: VoiceSession): Promise<void> {
    await this.announce(session, false);
  }

  /** Leave the voice channel and forget the connection. */
  async leave(): Promise<void> {
    try {
      this.gateway.leave();
    } catch (error) {
      this.logger.warn("failed to leave the voice channel", { reason: describe(error) });
    } finally {
      this.joinedChannelId = null;
    }
  }

  private async announce(session: VoiceSession, withCue: boolean): Promise<void> {
    if (!(await this.join(session))) return;

    const { soundEnabled, soundVolume } = session.config;
    if (!soundEnabled || soundVolume <= 0) {
      // Already silent from `join`; make sure of it and do nothing else.
      await this.silence();
      return;
    }

    await this.speak();

    if (withCue) {
      await this.play(session, START_CUE, soundVolume);
    }
    await this.play(session, BELL, soundVolume);

    await this.silence();
  }

  private async play(session: VoiceSession, sound: SoundName, volume: number): Promise<void> {
    try {
      const result = await this.gateway.play(sound, volume);
      if (!result.played) {
        this.logger.warn("cue sound could not be played; the timer is unaffected", {
          guildId: session.guildId,
          sound,
          reason: result.reason,
        });
      }
    } catch (error) {
      // The gateway contract says this does not reject; if a replacement
      // implementation does anyway, it still must not escape.
      this.logger.warn("cue sound raised unexpectedly; the timer is unaffected", {
        guildId: session.guildId,
        sound,
        reason: describe(error),
      });
    }
  }

  private async speak(): Promise<void> {
    try {
      await this.gateway.setSilenced(false);
    } catch (error) {
      this.logger.warn("could not unmute for playback", { reason: describe(error) });
    }
  }

  private async silence(): Promise<void> {
    try {
      await this.gateway.setSilenced(true);
    } catch (error) {
      this.logger.warn("could not mute after playback", { reason: describe(error) });
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
