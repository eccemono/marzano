/**
 * The voice channel's own status field.
 *
 * Discord lets a bot put a short line under a voice channel's name, which is a
 * genuinely useful glance-level cue: "Focus - 12m left" is visible from the
 * channel list without opening the session message.
 *
 * Two properties matter here:
 *
 *   1. It is **opt-in**. This needs the Set Voice Channel Status permission,
 *      which the bot's least-privilege invite deliberately does not include, so
 *      it stays off unless an operator asks for it.
 *   2. It must **never** affect the timer. A missing permission, a 403 or any
 *      other API failure degrades to a single log line and switches the feature
 *      off for that guild rather than retrying into a rate limit.
 *
 * The text only changes on a minute boundary, so writing only when the text
 * actually differs is the rate limiting: at most one request per minute per
 * guild, and usually far fewer.
 */

import { DiscordAPIError, type Client } from "discord.js";

import type { Logger } from "../logger";
import type { TimerSession } from "../domain/timer";

import { channelStatusText } from "../discord/session-view";

export interface VoiceStatusGateway {
  /** Write the status line, or clear it when `text` is null. */
  set(channelId: string, text: string | null): Promise<void>;
}

/** Discord's "Missing Permissions" and "Unknown Channel". */
const MISSING_PERMISSIONS = 50_013;
const UNKNOWN_CHANNEL = 10_003;

export function createDiscordVoiceStatus(client: Client, logger: Logger): VoiceStatusGateway {
  return {
    async set(channelId: string, text: string | null): Promise<void> {
      await client.rest.put(`/channels/${channelId}/voice-status`, {
        body: { status: text ?? "" },
      } as never);

      logger.debug("voice channel status updated", { channelId, set: text !== null });
    },
  };
}

export interface VoiceStatusOptions {
  gateway: VoiceStatusGateway;
  logger: Logger;
  /** Whether the operator has opted in. */
  enabled: boolean;
}

export class VoiceStatus {
  private readonly gateway: VoiceStatusGateway;
  private readonly logger: Logger;
  private readonly enabled: boolean;

  /** The last text written per guild, so an unchanged minute costs nothing. */
  private readonly written = new Map<string, string | null>();
  /** Guilds where the API refused, so we stop asking. */
  private readonly disabled = new Set<string>();

  constructor(options: VoiceStatusOptions) {
    this.gateway = options.gateway;
    this.logger = options.logger;
    this.enabled = options.enabled;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Write the current stage and time left, if it has changed. */
  async sync(session: TimerSession, now: number): Promise<void> {
    if (!this.enabled || this.disabled.has(session.guildId)) return;

    const text = channelStatusText(session, now);
    const previous = this.written.get(session.guildId) ?? null;

    if (text === previous) return;

    await this.write(session.guildId, session.voiceChannelId, text);
  }

  /** Clear the status line. Called when a session ends. */
  async clear(session: TimerSession): Promise<void> {
    if (!this.enabled || this.disabled.has(session.guildId)) return;
    if (!this.written.has(session.guildId)) return;

    await this.write(session.guildId, session.voiceChannelId, null);
  }

  private async write(guildId: string, channelId: string, text: string | null): Promise<void> {
    try {
      await this.gateway.set(channelId, text);
      this.written.set(guildId, text);
    } catch (error) {
      // Losing the optional status must not disturb the timer, and it must not
      // be retried on every stage change either.
      const refused =
        error instanceof DiscordAPIError &&
        (error.code === MISSING_PERMISSIONS || error.code === UNKNOWN_CHANNEL);

      if (refused) {
        this.disabled.add(guildId);
        this.logger.warn(
          "voice channel status is unavailable; turning it off for this server. The timer is unaffected.",
          { guildId, channelId, code: error.code },
        );
      } else {
        this.logger.warn("could not update the voice channel status", {
          guildId,
          channelId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
