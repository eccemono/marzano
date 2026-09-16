import { DiscordAPIError, type Client } from "discord.js";

import {
  type SessionMessageGateway,
  type SessionPayload,
  SessionMessageMissingError,
} from "./session-presenter";

/**
 * The real message gateway.
 *
 * The only job here beyond calling the API is translating Discord's
 * "Unknown Message" error into {@link SessionMessageMissingError}, which is
 * what tells the presenter to post a replacement instead of backing off.
 */

const UNKNOWN_MESSAGE = 10_008;
const UNKNOWN_CHANNEL = 10_003;

function isMissingTarget(error: unknown): boolean {
  if (error instanceof DiscordAPIError) {
    return error.code === UNKNOWN_MESSAGE || error.code === UNKNOWN_CHANNEL;
  }
  return false;
}

async function resolveTextChannel(client: Client, channelId: string) {
  const channel = await client.channels.fetch(channelId);
  if (!channel?.isTextBased() || channel.isDMBased()) {
    throw new Error(`channel ${channelId} cannot hold a status message`);
  }
  return channel;
}

export function createMessageGateway(client: Client): SessionMessageGateway {
  return {
    async post(channelId: string, payload: SessionPayload): Promise<string> {
      const channel = await resolveTextChannel(client, channelId);
      const message = await channel.send({
        embeds: payload.embeds,
        components: payload.components,
      });
      return message.id;
    },

    async edit(channelId: string, messageId: string, payload: SessionPayload): Promise<void> {
      const channel = await resolveTextChannel(client, channelId);

      try {
        const message = await channel.messages.fetch(messageId);
        await message.edit({ embeds: payload.embeds, components: payload.components });
      } catch (error) {
        if (isMissingTarget(error)) {
          throw new SessionMessageMissingError(
            `status message ${messageId} in channel ${channelId} no longer exists`,
          );
        }
        throw error;
      }
    },
  };
}
