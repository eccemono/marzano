import "dotenv/config";

import { type Client, Events } from "discord.js";

import { registerCommands } from "./commands/register";
import { loadConfig } from "./config/env";
import { openMigratedDatabase } from "./db/bootstrap";
import { getActiveSession, saveActiveSession } from "./db/session-repository";
import { createClient } from "./discord/client";
import { handleInteraction } from "./discord/handlers";
import { createMessageGateway } from "./discord/message-gateway";
import { SessionPresenter } from "./discord/session-presenter";
import { createLogger, type Logger } from "./logger";
import { BOT_NAME, REPOSITORY_URL, VERSION, assertSupportedNode } from "./runtime";
import { createDiscordVoiceGateway } from "./voice/gateway";
import { SessionVoice } from "./voice/manager";
import { createSoundLibrary } from "./voice/sounds";

/**
 * One presenter per guild.
 *
 * The refresh loop is per-session, and because a guild holds at most one
 * session, a presenter per guild is enough. Supervision of these loops across
 * restarts belongs to the lifecycle task.
 */
function startRefreshLoops(
  client: Client,
  logger: Logger,
  db: ReturnType<typeof openMigratedDatabase>["db"],
  presenters: Map<string, SessionPresenter>,
): void {
  for (const guild of client.guilds.cache.values()) {
    const session = getActiveSession(db, guild.id);
    if (!session || session.state === "stopped") continue;

    const presenter = new SessionPresenter({
      gateway: createMessageGateway(client),
      logger: logger.child({ component: "session", guildId: guild.id }),
    });
    presenters.set(guild.id, presenter);

    presenter.startLoop(
      () => getActiveSession(db, guild.id),
      (rendered, result) => {
        if (result.messageId !== rendered.statusMessageId) {
          saveActiveSession(db, { ...rendered, statusMessageId: result.messageId });
        }
      },
    );

    logger.info("resumed status refresh", { guildId: guild.id });
  }
}

async function main(): Promise<void> {
  const bootstrap = createLogger();

  try {
    assertSupportedNode();

    const config = loadConfig();
    const logger = createLogger({ level: config.logLevel, bindings: { bot: BOT_NAME } });

    const { db, migration } = openMigratedDatabase(config.dataDir);
    logger.info("database ready", { dataDir: config.dataDir, schemaVersion: migration.to });

    // Prepare the cue sounds before logging in. Encoding is a few hundred
    // milliseconds; doing it here keeps the first session start responsive and
    // surfaces a broken asset at startup rather than mid-session.
    const sounds = createSoundLibrary({
      directory: config.soundsDir,
      logger: logger.child({ component: "sound" }),
    });
    const soundReport = sounds.preload();
    if (soundReport.unavailable.length > 0) {
      logger.warn("running without some cue sounds; the timer is unaffected", {
        directory: config.soundsDir,
        unavailable: soundReport.unavailable,
      });
    } else {
      logger.info("cue sounds ready", { available: soundReport.available });
    }

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
    const presenters = new Map<string, SessionPresenter>();

    const voice = new SessionVoice({
      gateway: createDiscordVoiceGateway({
        client,
        sounds,
        logger: logger.child({ component: "voice" }),
      }),
      logger: logger.child({ component: "voice" }),
    });

    // A single shared presenter handles session starts from commands; the
    // per-guild loops above are tracked separately.
    const commandPresenter = new SessionPresenter({
      gateway: createMessageGateway(client),
      logger: logger.child({ component: "session-command" }),
    });

    const handlerDeps = {
      db,
      presenter: commandPresenter,
      voice,
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

      startRefreshLoops(client, logger, db, presenters);
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
