import "dotenv/config";

import { type Client, Events } from "discord.js";

import { registerCommands } from "./commands/register";
import { loadConfig } from "./config/env";
import { openMigratedDatabase } from "./db/bootstrap";
import { createClient } from "./discord/client";
import { handleInteraction } from "./discord/handlers";
import { createLogger } from "./logger";
import { BOT_NAME, REPOSITORY_URL, VERSION, assertSupportedNode } from "./runtime";

async function main(): Promise<void> {
  const bootstrap = createLogger();

  try {
    assertSupportedNode();

    const config = loadConfig();
    const logger = createLogger({ level: config.logLevel, bindings: { bot: BOT_NAME } });

    const { db, migration } = openMigratedDatabase(config.dataDir);
    logger.info("database ready", { dataDir: config.dataDir, schemaVersion: migration.to });

    const registration = await registerCommands({
      token: config.discordToken,
      clientId: config.clientId,
      devGuildId: config.devGuildId,
    });
    logger.info("slash commands registered", {
      scope: registration.scope,
      count: registration.count,
    });

    const client: Client = createClient();
    const startedAt = Date.now();

    const handlerDeps = {
      db,
      uptimeSeconds: () => Math.floor((Date.now() - startedAt) / 1_000),
      gatewayLatencyMs: () => client.ws.ping,
      guildCount: () => client.guilds.cache.size,
      applicationId: () => client.application?.id ?? config.clientId,
    };

    client.once(Events.ClientReady, (ready) => {
      logger.info("ready", {
        user: ready.user.username,
        guilds: ready.guilds.cache.size,
        version: VERSION,
        repository: REPOSITORY_URL,
      });
    });

    client.on(Events.InteractionCreate, (interaction) => {
      void handleInteraction(interaction, handlerDeps).catch((error: unknown) => {
        logger.error("interaction failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });

    await client.login(config.discordToken);
  } catch (error) {
    bootstrap.error(error instanceof Error ? error.message : "startup failed");
    process.exitCode = 1;
  }
}

void main();
