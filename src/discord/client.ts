import { Client, GatewayIntentBits } from "discord.js";

export const BOT_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.GuildMessages,
] as const;

/**
 * Build the gateway client.
 *
 * Three intents are requested, and **none of them is privileged**:
 *
 *   Guilds           - guild and channel metadata, needed to resolve the
 *                      voice channel a command was used in
 *   GuildVoiceStates - voice presence, which is how we know who is in the
 *                      call and when the last person leaves
 *   GuildMessages    - message *events*, so an explicit @Marzano mention can
 *                      start a session
 *
 * Message Content is deliberately absent, and remains absent. GuildMessages
 * delivers the event and the mention metadata; it does **not** expose what was
 * said. Discord only fills in `message.content` if the privileged Message
 * Content intent is also enabled, so Marzano can be summoned by name without
 * ever being able to read a message. A prefix like `!pomodoro` would need that
 * privileged intent, which is exactly why there isn't one.
 */
export function createClient(): Client {
  return new Client({ intents: [...BOT_INTENTS] });
}
