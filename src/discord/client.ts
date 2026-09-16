import { Client, GatewayIntentBits } from "discord.js";

export const BOT_INTENTS = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] as const;

/**
 * Build the gateway client.
 *
 * Only two intents are requested, and neither is privileged:
 *
 *   Guilds           - guild and channel metadata, needed to resolve the
 *                      voice channel a command was used in
 *   GuildVoiceStates - voice presence, which is how we know who is in the
 *                      call and when the last person leaves
 *
 * Message Content is deliberately absent: Marzano never reads message text,
 * because every entry point is an interaction.
 */
export function createClient(): Client {
  return new Client({ intents: [...BOT_INTENTS] });
}
