import "dotenv/config";

import { type Client, Events } from "discord.js";

import { registerCommands } from "./commands/register";
import { loadConfig } from "./config/env";
import { openMigratedDatabase } from "./db/bootstrap";
import { listActiveSessions } from "./db/session-repository";
import { createClient } from "./discord/client";
import { handleInteraction } from "./discord/handlers";
import { handleMention } from "./discord/mention";
import { createHealthReporter } from "./health";
import { createMessageGateway } from "./discord/message-gateway";
import { SessionRenderer } from "./discord/session-renderer";
import { createLogger } from "./logger";
import { BOT_NAME, REPOSITORY_URL, VERSION, assertSupportedNode } from "./runtime";
import { createDiscordAudience } from "./session/audience";
import { SessionSupervisor } from "./session/supervisor";
import { SessionHistory } from "./session/history";
import { createDiscordVoiceGateway } from "./voice/gateway";
import { VoiceStatus, createDiscordVoiceStatus } from "./voice/channel-status";
import { SessionVoice } from "./voice/manager";
import { createSoundLibrary } from "./voice/sounds";

async function main(): Promise<void> {
  const bootstrap = createLogger();

  try {
    assertSupportedNode();

    const config = loadConfig();
    const logger = createLogger({ level: config.logLevel, bindings: { bot: BOT_NAME } });

    const { db, migration } = openMigratedDatabase(config.dataDir);
    logger.info("database ready", { dataDir: config.dataDir, schemaVersion: migration.to });

    // Prepare the cue sounds before logging in. Encoding takes a few hundred
    // milliseconds; doing it here keeps the first session responsive and
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

    const voice = new SessionVoice({
      gateway: createDiscordVoiceGateway({
        client,
        sounds,
        logger: logger.child({ component: "voice" }),
      }),
      logger: logger.child({ component: "voice" }),
    });

    // Optional: mirrors the stage into the voice channel's own status line.
    // Off unless VOICE_STATUS_ENABLED is set, because it needs a permission the
    // least-privilege invite does not grant.
    const voiceStatus = new VoiceStatus({
      gateway: createDiscordVoiceStatus(client, logger.child({ component: "voice-status" })),
      logger: logger.child({ component: "voice-status" }),
      enabled: config.voiceStatusEnabled,
    });

    // One presenter per guild. The supervisor starts and stops each guild's
    // refresh loop as sessions begin and end, so a session started at any time
    // keeps its countdown live.
    const presenter = new SessionRenderer({
      db,
      gateway: createMessageGateway(client),
      logger: logger.child({ component: "session" }),
      // The status update rides the refresh cadence instead of its own timer,
      // and writes only when its text has changed.
      onRendered: (session) => {
        void voiceStatus.sync(session, Date.now());
      },
    });

    const supervisor = new SessionSupervisor({
      db,
      voice,
      presenter,
      audience: createDiscordAudience(client),
      logger: logger.child({ component: "lifecycle" }),
      graceMs: config.graceMs,
      voiceStatus,
      history: new SessionHistory({
        db,
        logger: logger.child({ component: "history" }),
      }),
    });

    // The deploy script polls this file to decide whether a deploy succeeded,
    // so it must reflect the real Discord connection, not just "the process
    // started".
    let discordState: "connecting" | "ready" | "disconnected" = "connecting";
    let recovered = false;

    const health = createHealthReporter({
      directory: config.dataDir,
      logger: logger.child({ component: "health" }),
      commit: process.env.GIT_COMMIT ?? "unknown",
    });

    health.start(() => ({
      ready: discordState === "ready" && recovered,
      discord: discordState,
      commit: process.env.GIT_COMMIT ?? "unknown",
      guilds: client.guilds.cache.size,
      database: "ok",
      activeSessions: listActiveSessions(db).filter((session) => session.state !== "stopped")
        .length,
    }));

    let shuttingDown = false;

    async function shutdown(signal: string): Promise<void> {
      if (shuttingDown) return;
      shuttingDown = true;

      logger.info("shutting down", { signal, timeoutMs: config.shutdownTimeoutMs });
      try {
        await supervisor.shutdown(config.shutdownTimeoutMs);
      } catch (error) {
        logger.error("shutdown did not complete cleanly", {
          reason: error instanceof Error ? error.message : String(error),
        });
      } finally {
        health.stop();
        client.destroy();
        process.exit(0);
      }
    }

    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));

    client.once(Events.ClientReady, (ready) => {
      logger.info("ready", {
        user: ready.user.username,
        guilds: ready.guilds.cache.size,
        version: VERSION,
        repository: REPOSITORY_URL,
      });

      discordState = "ready";

      void (async () => {
        try {
          const report = await supervisor.recover();
          logger.info("recovery complete", { ...report });
        } catch (error) {
          logger.error("recovery failed; starting without resuming sessions", {
            reason: error instanceof Error ? error.message : String(error),
          });
        } finally {
          // Ready only once recovery has finished, so a deploy never reports
          // healthy while sessions are still being reconciled.
          recovered = true;
          health.beat();
        }
      })();
    });

    // Who is in a channel decides whether a session should keep running.
    client.on(Events.VoiceStateUpdate, (before, after) => {
      const guildId = after.guild.id;
      // Ignore changes that cannot affect presence in the session's channel.
      if (after.channelId === null && before.channelId === null) return;
      void supervisor.presenceChanged(guildId).catch((error: unknown) => {
        logger.warn("presence check failed", {
          guildId,
          reason: error instanceof Error ? error.message : String(error),
        });
      });
    });

    // Summoning by name. GuildMessages gives the event and the mention metadata
    // but not the message text, so this cannot read what anyone said.
    client.on(Events.MessageCreate, (message) => {
      void handleMention(message, {
        db,
        deps: {
          db,
          presenter,
          supervisor,
          uptimeSeconds: () => Math.floor((Date.now() - startedAt) / 1_000),
          gatewayLatencyMs: () => client.ws.ping,
          guildCount: () => client.guilds.cache.size,
          applicationId: () => client.application?.id ?? config.clientId,
        },
        botUserId: () => client.user?.id ?? null,
        logger: logger.child({ component: "mention" }),
      }).catch((error: unknown) => {
        logger.warn("mention handling failed", {
          reason: error instanceof Error ? error.message : String(error),
        });
      });
    });

    client.on(Events.ShardDisconnect, () => {
      discordState = "disconnected";
      health.beat();
    });

    client.on(Events.InteractionCreate, (interaction) => {
      void handleInteraction(interaction, {
        db,
        presenter,
        supervisor,
        uptimeSeconds: () => Math.floor((Date.now() - startedAt) / 1_000),
        gatewayLatencyMs: () => client.ws.ping,
        guildCount: () => client.guilds.cache.size,
        applicationId: () => client.application?.id ?? config.clientId,
      }).catch((error: unknown) => {
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
