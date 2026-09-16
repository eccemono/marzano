/**
 * The voice boundary.
 *
 * Everything that touches `@discordjs/voice` lives behind {@link VoiceGateway}
 * so that join/leave and playback orchestration can be tested without a real
 * connection - the tests drive a fake and assert the sequence of calls.
 *
 * Three deliberate properties of the real implementation:
 *
 *   1. Marzano only ever changes *its own* voice state. It never asks for
 *      permission to move, mute or disconnect anyone else, so it needs no
 *      privileged intent and no elevated permission beyond Connect and Speak.
 *   2. Playback is pre-encoded Opus, so FFmpeg is not on the audio path at all.
 *   3. Connections are tracked *per guild*. The bot can hold one session per
 *      guild across many guilds, and one guild must never be able to tear down,
 *      replace or silence another guild's connection.
 */

import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type AudioPlayer,
  type VoiceConnection,
} from "@discordjs/voice";
import type { Client } from "discord.js";

import type { Logger } from "../logger";

import { pcmStreamFromSamples } from "./pcm";
import type { SoundLibrary, SoundName } from "./sounds";

export type PlaybackResult = { played: true } | { played: false; reason: string };

export interface VoiceGateway {
  /** Join a voice channel and wait until the connection is usable. */
  join(guildId: string, channelId: string): Promise<void>;
  /** Destroy one guild's connection. Never throws. */
  leave(guildId: string): void;
  /** Tear down every connection. Never throws. */
  leaveAll(): void;
  /** Whether this guild currently has a usable connection. */
  isConnected(guildId: string): boolean;
  /**
   * Play a cue sound at a volume (0-100).
   *
   * Resolves when playback finishes, fails or times out - it never rejects, so
   * a caller can await it without risking its own control flow.
   */
  play(guildId: string, sound: SoundName, volumePercent: number): Promise<PlaybackResult>;
  /** Mute and deafen the bot (`true`), or undo both (`false`). */
  setSilenced(guildId: string, silenced: boolean): Promise<void>;
}

const READY_TIMEOUT_MS = 15_000;
const PLAY_TIMEOUT_MS = 20_000;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface GuildVoice {
  connection: VoiceConnection;
  player: AudioPlayer;
  channelId: string;
}

export interface DiscordVoiceGatewayOptions {
  client: Client;
  sounds: SoundLibrary;
  logger: Logger;
}

export function createDiscordVoiceGateway(options: DiscordVoiceGatewayOptions): VoiceGateway {
  const { client, sounds, logger } = options;

  const voices = new Map<string, GuildVoice>();
  /**
   * The self-deafen state last pushed for a guild.
   *
   * Setting it means a `rejoin`, so it is only worth doing when the value
   * actually changes - and it must be forgotten whenever the connection is
   * rebuilt, because a fresh connection always starts undeafened.
   */
  const silenced = new Map<string, boolean>();

  function createPlayer(guildId: string): AudioPlayer {
    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });

    // An unhandled 'error' on an EventEmitter throws, which would take the
    // whole process down over a cue sound. Swallow it into the log instead.
    player.on("error", (error: Error) => {
      logger.warn("audio player error", { guildId, reason: error.message });
    });

    return player;
  }

  function destroy(guildId: string): void {
    const entry = voices.get(guildId);
    if (!entry) return;

    try {
      entry.player.stop(true);
    } catch {
      // Stopping an already-idle player is not an error worth reporting.
    }
    try {
      entry.connection.destroy();
    } catch (error) {
      logger.warn("failed to destroy voice connection", { guildId, reason: describe(error) });
    }

    voices.delete(guildId);
    silenced.delete(guildId);
  }

  /**
   * Build a fresh connection for a guild, replacing any existing one.
   *
   * Extracted so the disconnect handler can call it too: a connection that
   * cannot be recovered has to be rebuilt, and there was previously no way to
   * reach the join path from inside that handler.
   */
  async function connect(guildId: string, channelId: string): Promise<void> {
    destroy(guildId);

    const guild = await client.guilds.fetch(guildId);
    const player = createPlayer(guildId);

    const created = joinVoiceChannel({
      channelId,
      guildId,
      adapterCreator: guild.voiceAdapterCreator,
      // Fully open at join: the bot has no microphone to hear anything with, so
      // the deafen that follows is a *cue* for everyone else, not a privacy
      // measure - see setSilenced.
      selfDeaf: false,
      selfMute: false,
    });

    voices.set(guildId, { connection: created, player, channelId });

    created.subscribe(player);

    created.on(VoiceConnectionStatus.Disconnected, () => {
      void (async () => {
        try {
          // A move between channels shows up as Signalling/Connecting. If
          // neither arrives the connection is genuinely dead.
          await Promise.race([
            entersState(created, VoiceConnectionStatus.Signalling, 5_000),
            entersState(created, VoiceConnectionStatus.Connecting, 5_000),
          ]);
          logger.info("voice connection is reconnecting", { guildId });
        } catch {
          // @discordjs/voice's guidance is to rebuild here. Only logging - what
          // this used to do - left a dead entry in the map, so every later
          // `join` short-circuited on it and the rest of the session ran silent
          // with no way back.
          logger.warn("voice connection dropped; rebuilding it", { guildId });
          try {
            await connect(guildId, channelId);
            logger.info("voice connection rebuilt", { guildId });
          } catch (error) {
            logger.warn("voice connection could not be rebuilt", {
              guildId,
              reason: describe(error),
            });
          }
        }
      })();
    });

    try {
      await entersState(created, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
    } catch (error) {
      // Never leave a dead connection in the map: a later join would then
      // short-circuit on it and the session would have no audio at all.
      destroy(guildId);
      throw error;
    }

    logger.info("joined voice channel", { guildId, channelId });
  }

  return {
    async join(guildId: string, channelId: string): Promise<void> {
      const existing = voices.get(guildId);
      if (
        existing &&
        existing.channelId === channelId &&
        existing.connection.state.status === VoiceConnectionStatus.Ready
      ) {
        return;
      }

      await connect(guildId, channelId);
    },

    leave(guildId: string): void {
      destroy(guildId);
    },

    leaveAll(): void {
      for (const guildId of [...voices.keys()]) destroy(guildId);
    },

    isConnected(guildId: string): boolean {
      const entry = voices.get(guildId);
      return entry !== undefined && entry.connection.state.status === VoiceConnectionStatus.Ready;
    },

    async play(guildId: string, sound: SoundName, volumePercent: number): Promise<PlaybackResult> {
      const entry = voices.get(guildId);

      if (!entry || entry.connection.state.status !== VoiceConnectionStatus.Ready) {
        return { played: false, reason: "not connected to a voice channel" };
      }

      let samples: Float64Array | null;
      try {
        samples = sounds.samples(sound, volumePercent);
      } catch (error) {
        return { played: false, reason: describe(error) };
      }

      if (!samples || samples.length === 0) {
        return { played: false, reason: "no audio available" };
      }

      try {
        // Raw PCM, deliberately, rather than packets we encoded ourselves.
        //
        // Handing the player a pre-encoded Opus stream flushed a two-second bell
        // in about 125ms: the packets arrive as fast as the stream is read, so
        // there is nothing to pace against and Discord's client never gets a
        // sustained signal. Raw PCM goes through the pipeline's own encoder,
        // which paces it to the length of the audio - measured at 2104ms for the
        // same bell.
        entry.player.play(
          createAudioResource(pcmStreamFromSamples(samples), { inputType: StreamType.Raw }),
        );
        await entersState(entry.player, AudioPlayerStatus.Idle, PLAY_TIMEOUT_MS);
        return { played: true };
      } catch (error) {
        try {
          entry.player.stop(true);
        } catch {
          // Best effort; the reason below is the useful signal.
        }
        return { played: false, reason: describe(error) };
      }
    },

    async setSilenced(guildId: string, silenced_: boolean): Promise<void> {
      const entry = voices.get(guildId);
      if (!entry) return;
      if (entry.connection.state.status === VoiceConnectionStatus.Destroyed) return;

      // A rejoin is not free, so skip it when nothing would change. This also
      // keeps the common case - a work period following another work period -
      // from touching the connection at all.
      if (silenced.get(guildId) === silenced_) return;

      try {
        // A *self* deafen, not a server deafen. The member-edit API on VoiceState
        // is moderation: it needs MUTE_MEMBERS and leaves the connection's own
        // flags untouched.
        //
        // `rejoin` re-sends the voice state payload with the new flags. It is the
        // only mechanism available here (this discord.js version has no
        // setSelfDeaf, and no public raw-gateway send), which is why it is called
        // as rarely as possible. `selfMute` must stay false forever: turning it on
        // is what silences the bot's own cues, and "silent between bells" comes
        // from not playing, not from suppressing transmission.
        entry.connection.rejoin({
          channelId: entry.channelId,
          selfMute: false,
          selfDeaf: silenced_,
        });
        silenced.set(guildId, silenced_);
      } catch (error) {
        logger.warn("failed to change the bot's own voice state", {
          guildId,
          silenced: silenced_,
          reason: describe(error),
        });
      }
    },
  };
}
