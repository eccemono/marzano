import { REST, Routes } from "discord.js";

import { APPLICATION_COMMANDS } from "./definitions";

/**
 * Slash-command registration.
 *
 * Discord's PUT replaces the whole command set, which makes registration
 * inherently idempotent: running it repeatedly converges on the declared
 * definitions rather than accumulating duplicates.
 *
 * Global registration can take up to an hour to propagate; setting
 * `DEV_GUILD_ID` registers in one guild for instant updates during
 * development.
 */

export interface RegisterOptions {
  token: string;
  clientId: string;
  devGuildId?: string | null;
}

export interface RegisterResult {
  scope: "guild" | "global";
  count: number;
}

/** The exact body sent to Discord, without client-side metadata. */
export function commandPayload(): unknown[] {
  return APPLICATION_COMMANDS.map((command) => JSON.parse(JSON.stringify(command)) as unknown);
}

export async function registerCommands(options: RegisterOptions): Promise<RegisterResult> {
  const scope = options.devGuildId ? "guild" : "global";

  const route = options.devGuildId
    ? Routes.applicationGuildCommands(options.clientId, options.devGuildId)
    : Routes.applicationCommands(options.clientId);

  const rest = new REST({ version: "10" }).setToken(options.token);
  await rest.put(route, { body: commandPayload() });

  return { scope, count: APPLICATION_COMMANDS.length };
}
