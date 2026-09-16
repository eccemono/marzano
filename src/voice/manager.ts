/**
 * Session audio orchestration.
 *
 * The rules this encodes:
 *
 *   - The bot joins the session's voice channel and is muted and deafened while
 *     nothing is playing. It unmutes and undeafens only for the length of a cue,
 *     then goes quiet again.
 *   - A session start plays the join cue. Every later stage boundary plays the
 *     cue for the stage that just began - different for work and for a break.
 *     There are no spoken announcements, and no text-to-speech anywhere in the
 *     bot.
 *   - Audio is strictly decorative. Every failure path here ends in a log line
 *     and a `return`; nothing in this class can fail a session, and callers are
 *     expected to invoke it without awaiting so playback never delays the timer.
 *   - Voice state is tracked per guild, so a session in one guild can never
 *     leave, silence or replace a session in another.
 */

import type { SessionStage } from "../domain/timer";
import type { Logger } from "../logger";

import type { PlaybackStrategy } from "./diagnostics";
import type { TestPlaybackReport, VoiceGateway } from "./gateway";
import { BREAK_CUE, JOIN_CUE, WORK_CUE, type SoundName } from "./sounds";

/** The subset of a session this layer needs. */
export interface VoiceSession {
  guildId: string;
  voiceChannelId: string;
  /** The stage the session is *now* in, which picks the boundary cue. */
  stage: SessionStage;
  config: {
    soundEnabled: boolean;
    soundVolume: number;
  };
}

export interface SessionVoiceOptions {
  gateway: VoiceGateway;
  logger: Logger;
  /**
   * Beat between a work cue and the self-deafen.
   *
   * Tests pass 0 so playback assertions do not wait on real time.
   */
  deafenCushionMs?: number;
}

/**
 * A beat between a work cue and the self-deafen.
 *
 * Deafening is the non-verbal "heads down, earphones on" signal for everyone
 * else in the channel, so it lands after the cue has been heard rather than
 * talking over it.
 */
export const DEAFEN_CUSHION_MS = 3_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const handle = setTimeout(resolve, ms);
    // Never hold the process open purely for a cushion.
    if (typeof handle.unref === "function") handle.unref();
  });
}

export class SessionVoice {
  private readonly gateway: VoiceGateway;
  private readonly logger: Logger;
  private readonly deafenCushionMs: number;
  private readonly joined = new Map<string, string>();

  constructor(options: SessionVoiceOptions) {
    this.gateway = options.gateway;
    this.logger = options.logger;
    this.deafenCushionMs = options.deafenCushionMs ?? DEAFEN_CUSHION_MS;
  }

  /** The channel currently joined in a guild, or null. */
  channelId(guildId: string): string | null {
    return this.joined.get(guildId) ?? null;
  }

  /**
   * Join the session's voice channel and go silent.
   *
   * Returns whether the bot ended up connected. A failure - a deleted channel,
   * a missing Connect permission, a full channel - is logged and reported, not
   * thrown, because audio is optional and the timer is not.
   */
  async join(session: VoiceSession): Promise<boolean> {
    const { guildId, voiceChannelId } = session;

    if (this.joined.get(guildId) === voiceChannelId && this.gateway.isConnected(guildId)) {
      return true;
    }

    try {
      await this.gateway.join(guildId, voiceChannelId);
      this.joined.set(guildId, voiceChannelId);
    } catch (error) {
      this.joined.delete(guildId);
      this.logger.warn("could not join the voice channel; the session continues without audio", {
        guildId,
        channelId: voiceChannelId,
        reason: describe(error),
      });
      return false;
    }

    return true;
  }

  /** The join cue, played once when the bot joins a session's channel. */
  async announceStart(session: VoiceSession): Promise<void> {
    await this.announce(session, JOIN_CUE);
    // The first work period is about to begin, so take the same cue as any
    // other work period does.
    await this.deafenForWork(session.guildId);
  }

  /**
   * The boundary cue for the stage that has just begun.
   *
   * A work period and a break deliberately sound different - one means "start",
   * the other "stop and rest" - so they are tellable apart without looking. The
   * bot also deafens itself for a work period and undeafens for a break, which
   * is a cue the others in the channel can see rather than hear.
   */
  async announceTransition(session: VoiceSession): Promise<void> {
    const working = session.stage === "focus";
    await this.announce(session, working ? WORK_CUE : BREAK_CUE);

    if (working) await this.deafenForWork(session.guildId);
    else await this.setDeafened(session.guildId, false);
  }

  /** Deafen after the cushion, so the cue is not talking over the cue. */
  private async deafenForWork(guildId: string): Promise<void> {
    if (this.deafenCushionMs > 0) await sleep(this.deafenCushionMs);
    await this.setDeafened(guildId, true);
  }

  private async setDeafened(guildId: string, deafened: boolean): Promise<void> {
    try {
      await this.gateway.setSilenced(guildId, deafened);
    } catch (error) {
      // Audio state is a nicety: a refused voice-state change must not fail a
      // session, and the gateway contract says this does not reject anyway.
      this.logger.warn("could not change the bot's own deafen state", {
        guildId,
        deafened,
        reason: describe(error),
      });
    }
  }

  /**
   * TEMPORARY: join and play a cue through one selectable audio path.
   *
   * Used only by `/test` while the silent-cue cause is being found; it is
   * removed along with that command.
   */
  async playTest(session: VoiceSession, strategy: PlaybackStrategy): Promise<TestPlaybackReport> {
    if (!(await this.join(session))) {
      return {
        played: false,
        reason: "could not join the voice channel",
        elapsedMs: 0,
        states: [],
        frames: 0,
        bytes: 0,
      };
    }

    if (!this.gateway.testPlayback) {
      return {
        played: false,
        reason: "this voice gateway has no diagnostic playback",
        elapsedMs: 0,
        states: [],
        frames: 0,
        bytes: 0,
      };
    }

    return this.gateway.testPlayback(session.guildId, strategy);
  }

  /** Whether this guild currently has a usable connection. */
  isConnected(guildId: string): boolean {
    return this.gateway.isConnected(guildId);
  }

  /** Leave one guild's voice channel and forget the connection. */
  async leave(guildId: string): Promise<void> {
    try {
      this.gateway.leave(guildId);
    } catch (error) {
      this.logger.warn("failed to leave the voice channel", { guildId, reason: describe(error) });
    } finally {
      this.joined.delete(guildId);
    }
  }

  /** Leave every voice channel. Used on shutdown. */
  async leaveAll(): Promise<void> {
    try {
      this.gateway.leaveAll();
    } catch (error) {
      this.logger.warn("failed to leave the voice channels", { reason: describe(error) });
    } finally {
      this.joined.clear();
    }
  }

  private async announce(session: VoiceSession, sound: SoundName): Promise<void> {
    if (!(await this.join(session))) return;

    const { soundEnabled, soundVolume } = session.config;
    if (!soundEnabled || soundVolume <= 0) return;

    await this.play(session, sound, soundVolume);
  }

  private async play(session: VoiceSession, sound: SoundName, volume: number): Promise<void> {
    try {
      const result = await this.gateway.play(session.guildId, sound, volume);
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
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
