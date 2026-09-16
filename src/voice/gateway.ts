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

import { Readable } from "node:stream";

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

/** One Opus packet per chunk, which is what `StreamType.Opus` expects. */
function framesToStream(frames: readonly Buffer[]): Readable {
  const stream = new Readable({ read() {} });
  for (const frame of frames) stream.push(Buffer.from(frame));
  stream.push(null);
  return stream;
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

      // A connection to somewhere else in the same guild is stale; drop it
      // before creating the new one so the guild never holds two.
      destroy(guildId);

      const guild = await client.guilds.fetch(guildId);
      const player = createPlayer(guildId);

      const created = joinVoiceChannel({
        channelId,
        guildId,
        adapterCreator: guild.voiceAdapterCreator,
        // Fully open: neither deafened nor muted. A bot has no microphone to
        // hear anything with, so deafening it serves no purpose - and any
        // self-state toggle around playback is exactly what has been breaking
        // audio. "Silent between bells" comes from simply not playing, not from
        // suppressing transmission.
        selfDeaf: false,
        selfMute: false,
      });

      voices.set(guildId, { connection: created, player, channelId });

      created.subscribe(player);

      // A dropped connection is recovered in place; if it cannot be, playback
      // simply fails and is logged. The session itself is never terminated by
      // an audio problem.
      created.on(VoiceConnectionStatus.Disconnected, () => {
        void (async () => {
          try {
            await Promise.race([
              entersState(created, VoiceConnectionStatus.Signalling, 5_000),
              entersState(created, VoiceConnectionStatus.Connecting, 5_000),
            ]);
            logger.info("voice connection is reconnecting", { guildId });
          } catch {
            logger.warn("voice connection dropped and could not be recovered", { guildId });
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

      let frames: readonly Buffer[] | null;
      try {
        frames = sounds.frames(sound, volumePercent);
      } catch (error) {
        return { played: false, reason: describe(error) };
      }

      if (!frames || frames.length === 0) {
        return { played: false, reason: "no audio frames available" };
      }

      try {
        entry.player.play(
          createAudioResource(framesToStream(frames), { inputType: StreamType.Opus }),
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

    async setSilenced(guildId: string, silenced: boolean): Promise<void> {
      const entry = voices.get(guildId);
      if (!entry) return;
      if (entry.connection.state.status === VoiceConnectionStatus.Destroyed) return;

      try {
        // This must be a *self* mute, not a server mute. The member-edit API on
        // VoiceState is moderation: it needs MUTE_MEMBERS permission and leaves
        // the self-mute flag this connection was created with untouched. That is
        // why the bot used to stay silent through its own cues.
        //
        // `rejoin` re-sends the voice state payload with the new self flags. On
        // a Ready connection it does not renegotiate, so this is a single
        // lightweight gateway update rather than a reconnect.
        entry.connection.rejoin({
          channelId: entry.channelId,
          // selfMute must stay false forever: turning it on is what silences the
          // bot's own cues. "Silent between bells" comes from not playing
          // anything, not from suppressing transmission.
          selfMute: false,
          selfDeaf: silenced,
        });
      } catch (error) {
        logger.warn("failed to change the bot's own voice state", {
          guildId,
          silenced,
          reason: describe(error),
        });
      }
    },
  };
}
