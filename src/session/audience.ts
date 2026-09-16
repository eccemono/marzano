import type { Client } from "discord.js";

import type { VoiceAudience } from "./ports";

/**
 * The Discord-backed audience lookup.
 *
 * The important detail is the difference between the two failure answers.
 * `channelExists` returning false is a definite "it is gone", which justifies
 * stopping a session. `humanMembers` returning null means "I could not tell",
 * which never does - a momentary API failure must not silently end someone's
 * focus session.
 */
export function createDiscordAudience(client: Client): VoiceAudience {
  return {
    async channelExists(guildId: string, channelId: string): Promise<boolean> {
      try {
        const guild = await client.guilds.fetch(guildId);
        const channel = await guild.channels.fetch(channelId);
        return channel !== null;
      } catch {
        return false;
      }
    },

    async humanMembers(guildId: string, channelId: string): Promise<string[] | null> {
      try {
        const guild = await client.guilds.fetch(guildId);
        const channel = await guild.channels.fetch(channelId);

        if (!channel?.isVoiceBased()) return null;

        return channel.members.filter((member) => !member.user.bot).map((member) => member.id);
      } catch {
        // Inconclusive, deliberately distinct from "empty".
        return null;
      }
    },
  };
}
