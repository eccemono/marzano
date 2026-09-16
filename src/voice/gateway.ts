/**
 * The voice boundary.
 *
 * Everything that touches `@discordjs/voice` lives behind {@link VoiceGateway}
 * so that join/leave and playback orchestration can be tested without a real
 * connection - the tests drive a fake and assert the sequence of calls.
 *
 * Two deliberate properties of the real implementation:
 *
 *   1. Marzano only ever changes *its own* voice state. It never asks for
 *      permission to move, mute or disconnect anyone else, so it needs no
 *      privileged intent and no elevated permission beyond Connect and Speak.
 *   2. Playback is pre-encoded Opus, so FFmpeg is not on the audio path at all.
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
  /** Destroy the connection. Never throws. */
  leave(): void;
  readonly connected: boolean;
  /**
   * Play a cue sound at a volume (0-100).
   *
   * Resolves when playback finishes, fails or times out - it never rejects, so
   * a caller can await it without risking its own control flow.
   */
  play(sound: SoundName, volumePercent: number): Promise<PlaybackResult>;
  /** Mute and deafen the bot (`true`), or undo both (`false`). */
  setSilenced(silenced: boolean): Promise<void>;
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

export interface DiscordVoiceGatewayOptions {
  client: Client;
  sounds: SoundLibrary;
  logger: Logger;
}

export function createDiscordVoiceGateway(options: DiscordVoiceGatewayOptions): VoiceGateway {
  const { client, sounds, logger } = options;

  let connection: VoiceConnection | null = null;
  let player: AudioPlayer | null = null;
  let currentGuildId: string | null = null;

  function ensurePlayer(): AudioPlayer {
    if (player) return player;

    player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });

    // An unhandled 'error' on an EventEmitter throws, which would take the
    // whole process down over a cue sound. Swallow it into the log instead.
    player.on("error", (error: Error) => {
      logger.warn("audio player error", { reason: error.message });
    });

    return player;
  }

  return {
    async join(guildId: string, channelId: string): Promise<void> {
      if (
        connection &&
        currentGuildId === guildId &&
        connection.state.status === VoiceConnectionStatus.Ready
      ) {
        return;
      }

      const guild = await client.guilds.fetch(guildId);
      const active = ensurePlayer();

      const created = joinVoiceChannel({
        channelId,
        guildId,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: true,
        selfMute: true,
      });

      connection = created;
      currentGuildId = guildId;

      created.subscribe(active);

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
            logger.info("voice connection is reconnecting");
          } catch {
            logger.warn("voice connection dropped and could not be recovered");
          }
        })();
      });

      await entersState(created, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
      logger.info("joined voice channel", { guildId, channelId });
    },

    leave(): void {
      try {
        player?.stop(true);
      } catch {
        // Stopping a already-idle player is not an error worth reporting.
      }
      try {
        connection?.destroy();
      } catch (error) {
        logger.warn("failed to destroy voice connection", { reason: describe(error) });
      }
      connection = null;
      player = null;
      currentGuildId = null;
    },

    get connected(): boolean {
      return connection !== null && connection.state.status === VoiceConnectionStatus.Ready;
    },

    async play(sound: SoundName, volumePercent: number): Promise<PlaybackResult> {
      const active = player;
      const current = connection;

      if (!active || !current || current.state.status !== VoiceConnectionStatus.Ready) {
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
        active.play(createAudioResource(framesToStream(frames), { inputType: StreamType.Opus }));
        await entersState(active, AudioPlayerStatus.Idle, PLAY_TIMEOUT_MS);
        return { played: true };
      } catch (error) {
        try {
          active.stop(true);
        } catch {
          // Best effort; the reason below is the useful signal.
        }
        return { played: false, reason: describe(error) };
      }
    },

    async setSilenced(silenced: boolean): Promise<void> {
      if (!currentGuildId) return;

      try {
        const guild = await client.guilds.fetch(currentGuildId);
        const me = guild.members.me;
        if (!me?.voice) return;

        // Only our own state is ever modified.
        await me.voice.setMute(silenced);
        await me.voice.setDeaf(silenced);
      } catch (error) {
        logger.warn("failed to change the bot's own voice state", {
          silenced,
          reason: describe(error),
        });
      }
    },
  };
}
