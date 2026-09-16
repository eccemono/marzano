import { type ChatInputCommandInteraction, type Interaction, MessageFlags } from "discord.js";

import { getChannelConfig } from "../db/config-repository";
import type { Db } from "../db/database";
import { getActiveSession, saveActiveSession } from "../db/session-repository";
import { BUILT_IN_DEFAULTS, resolveConfig } from "../domain/config";
import { SplitError, parseSplit } from "../domain/split";
import {
  type TimerSession,
  changeSplit,
  isStopped,
  remainingMs,
  startSession,
} from "../domain/timer";
import { SPLIT_INPUT_ID, SPLIT_MODAL_ID, buildSplitModal } from "./modals";
import { canConfigureChannel, canConfigureGuild } from "./permissions";
import { handleSessionButton } from "./session-buttons";
import { SESSION_SPLIT_MODAL_ID, authorizeControl } from "./session-controls";
import { buildLeaderboardEmbed } from "./history-views";
import { leaderboardTotals } from "../db/history-repository";
import { periodBounds, type LeaderboardPeriod } from "../domain/attendance";
import type { SessionRendererPort } from "./session-renderer";
import type { SessionSupervisor } from "../session/supervisor";
import { LICENSE, REPOSITORY_URL, VERSION } from "../runtime";

import {
  CONFIGURE_COMMAND,
  DEFAULT_COMMAND,
  INFO_COMMAND,
  LEADERBOARD_COMMAND,
  PERIODS,
  STATUS_COMMAND,
  STOP_COMMAND,
  isStartCommand,
} from "../commands/definitions";
import { buildInfoEmbed, type InfoPayload } from "../commands/info";
import { decideStart } from "../commands/start-decision";
import { WizardError, applyChannelWizard, applyGuildDefaultsWizard } from "../commands/wizard";

/**
 * The Discord-facing glue.
 *
 * This layer is deliberately thin: it extracts values from an interaction,
 * hands them to a pure decision function or a wizard, and translates the
 * result into a reply. Everything worth testing lives behind it.
 */

export interface HandlerDeps {
  db: Db;
  presenter: SessionRendererPort;
  supervisor: SessionSupervisor;
  uptimeSeconds(): number;
  gatewayLatencyMs(): number;
  guildCount(): number;
  applicationId(): string;
}

function ephemeral(content: string): { content: string; flags: number } {
  return { content, flags: MessageFlags.Ephemeral as number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function callerVoiceChannelId(interaction: { member?: unknown }): string | null {
  const member: unknown = interaction.member;
  if (!isRecord(member) || !isRecord(member.voice)) return null;
  const channelId = member.voice.channelId;
  return typeof channelId === "string" ? channelId : null;
}

export function parseSplitModalId(customId: string): string | null {
  const prefix = `${SPLIT_MODAL_ID}:`;
  if (!customId.startsWith(prefix)) return null;
  const channelId = customId.slice(prefix.length);
  return channelId.length > 0 ? channelId : null;
}

async function handleInfo(
  interaction: ChatInputCommandInteraction,
  deps: HandlerDeps,
): Promise<void> {
  const payload: InfoPayload = {
    botName: "Marzano",
    version: VERSION,
    repositoryUrl: REPOSITORY_URL,
    license: LICENSE,
    applicationId: deps.applicationId(),
    nodeVersion: process.versions.node,
    uptimeSeconds: deps.uptimeSeconds(),
    gatewayLatencyMs: deps.gatewayLatencyMs(),
    guildCount: deps.guildCount(),
  };

  await interaction.reply({ embeds: [buildInfoEmbed(payload)] });
}

/**
 * Resolve a start request into either a started session, a refusal or an
 * instruction to set the channel up first.
 *
 * Shared by the slash commands and the mention handler so the two can never
 * disagree about precedence, permissions or the one-session-per-guild rule.
 */
export type StartOutcome =
  | { kind: "reject"; message: string }
  | { kind: "open-setup"; reason: "unconfigured" | "invalid-split" | "override" }
  | {
      kind: "started";
      channelId: string;
      config: ReturnType<typeof resolveConfig>;
      session: TimerSession;
    };

export interface StartRequest {
  guildId: string;
  textChannelId: string;
  voiceChannelId: string;
  splitInput: string | null;
}

export async function startFrom(deps: HandlerDeps, request: StartRequest): Promise<StartOutcome> {
  const { guildId, textChannelId, voiceChannelId } = request;

  const stored = getChannelConfig(deps.db, guildId, voiceChannelId);
  const active = getActiveSession(deps.db, guildId);

  const decision = decideStart({
    callerVoiceChannelId: voiceChannelId,
    commandVoiceChannelId: textChannelId,
    hasStoredConfig: stored !== null,
    splitInput: request.splitInput,
    activeSessionVoiceChannelId:
      active && active.state !== "stopped" ? active.voiceChannelId : null,
  });

  if (decision.kind === "reject") return { kind: "reject", message: decision.message };
  if (decision.kind === "open-setup") return { kind: "open-setup", reason: decision.reason };

  const config = resolveConfig(decision.split ?? undefined, stored?.config ?? undefined);

  const session = startSession({
    guildId,
    voiceChannelId,
    textChannelId,
    config,
    now: Date.now(),
  });
  saveActiveSession(deps.db, session);

  // Post the canonical status message and remember its id, so later refreshes
  // edit this one instead of posting duplicates. The supervisor then adopts the
  // session: it persists, schedules the first stage wake, and plays the cue.
  const rendered = await deps.presenter.render(session);
  const started = { ...session, statusMessageId: rendered.messageId };
  await deps.supervisor.begin(started);

  return { kind: "started", channelId: voiceChannelId, config, session: started };
}

/** A one-line description of the split that a session is running. */
export function describeSplit(config: ReturnType<typeof resolveConfig>): string {
  return `focus ${config.focusMinutes}m, short break ${config.shortBreakMinutes}m, long break ${config.longBreakMinutes}m`;
}

async function handleStart(
  interaction: ChatInputCommandInteraction,
  deps: HandlerDeps,
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply(ephemeral("Marzano only works inside a server."));
    return;
  }

  const outcome = await startFrom(deps, {
    guildId,
    textChannelId: interaction.channelId,
    voiceChannelId: interaction.channelId,
    splitInput: interaction.options.getString("split"),
  });

  if (outcome.kind === "reject") {
    await interaction.reply(ephemeral(outcome.message));
    return;
  }

  if (outcome.kind === "open-setup") {
    const modal = buildSplitModal({
      title: outcome.reason === "unconfigured" ? "Set up this channel" : "Check the split",
    }).setCustomId(`${SPLIT_MODAL_ID}:${interaction.channelId}`);
    await interaction.showModal(modal);
    return;
  }

  await interaction.reply(
    ephemeral(`Session started - ${describeSplit(outcome.config)}. Controls are in the channel.`),
  );
}

async function handleStatus(
  interaction: ChatInputCommandInteraction,
  deps: HandlerDeps,
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply(ephemeral("Marzano only works inside a server."));
    return;
  }

  const session = getActiveSession(deps.db, guildId);
  if (!session || session.state === "stopped") {
    await interaction.reply(ephemeral("No session is running in this server."));
    return;
  }

  const minutes = Math.ceil(remainingMs(session, Date.now()) / 60_000);
  const label = session.stage.replace("_", " ");

  await interaction.reply(
    ephemeral(
      `Current stage: ${label} in <#${session.voiceChannelId}>. About ${minutes} minute(s) remaining.`,
    ),
  );
}

async function handleConfigure(
  interaction: ChatInputCommandInteraction,
  deps: HandlerDeps,
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply(ephemeral("Marzano only works inside a server."));
    return;
  }

  const permissions = interaction.memberPermissions?.bitfield ?? 0n;
  if (!canConfigureChannel(permissions)) {
    await interaction.reply(
      ephemeral("You need Manage Channels or Manage Server to change this channel's settings."),
    );
    return;
  }

  const copyFrom = interaction.options.getChannel("copy_from");

  try {
    const result = applyChannelWizard(
      deps.db,
      guildId,
      interaction.channelId,
      {
        split: interaction.options.getString("split"),
        cycles: interaction.options.getInteger("cycles"),
        sound: interaction.options.getBoolean("sound"),
        volume: interaction.options.getInteger("volume"),
        copyFromChannelId: copyFrom?.id ?? null,
        reset: interaction.options.getBoolean("reset") ?? false,
      },
      interaction.user.id,
    );

    if (result.action === "reset") {
      await interaction.reply(ephemeral("This channel's saved configuration was cleared."));
      return;
    }

    const config = result.config ?? BUILT_IN_DEFAULTS;
    await interaction.reply(
      ephemeral(
        `Saved: focus ${config.focusMinutes}m, short break ${config.shortBreakMinutes}m, long break ${config.longBreakMinutes}m, long break every ${config.cyclesBeforeLongBreak} focus periods, sound ${config.soundEnabled ? "on" : "off"} at ${config.soundVolume}%.`,
      ),
    );
  } catch (error) {
    if (error instanceof SplitError || error instanceof WizardError) {
      await interaction.reply(ephemeral(error.message));
      return;
    }
    throw error;
  }
}

async function handleDefault(
  interaction: ChatInputCommandInteraction,
  deps: HandlerDeps,
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply(ephemeral("Marzano only works inside a server."));
    return;
  }

  const permissions = interaction.memberPermissions?.bitfield ?? 0n;
  if (!canConfigureGuild(permissions)) {
    await interaction.reply(ephemeral("You need Manage Server to change server defaults."));
    return;
  }

  try {
    const result = applyGuildDefaultsWizard(deps.db, guildId, {
      split: interaction.options.getString("split"),
      cycles: interaction.options.getInteger("cycles"),
      sound: interaction.options.getBoolean("sound"),
      volume: interaction.options.getInteger("volume"),
    });

    const config = result.config ?? BUILT_IN_DEFAULTS;
    await interaction.reply(
      ephemeral(
        `Server defaults updated. Newly configured channels will start from focus ${config.focusMinutes}m, short break ${config.shortBreakMinutes}m, long break ${config.longBreakMinutes}m.`,
      ),
    );
  } catch (error) {
    if (error instanceof SplitError || error instanceof WizardError) {
      await interaction.reply(ephemeral(error.message));
      return;
    }
    throw error;
  }
}

async function handleStop(
  interaction: ChatInputCommandInteraction,
  deps: HandlerDeps,
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply(ephemeral("Marzano only works inside a server."));
    return;
  }

  const session = getActiveSession(deps.db, guildId);
  if (!session || session.state === "stopped") {
    await interaction.reply(ephemeral("No session is running in this server."));
    return;
  }

  const permissions = interaction.memberPermissions?.bitfield ?? 0n;
  const inChannel = callerVoiceChannelId(interaction) === session.voiceChannelId;
  if (!inChannel && !canConfigureChannel(permissions)) {
    await interaction.reply(ephemeral("You need to be in the session's voice channel to stop it."));
    return;
  }

  // Stop through the supervisor. Writing the row directly left the stage timer
  // armed and the bot sitting in the voice channel: the session looked stopped
  // in the database while it was still running in Discord.
  await deps.supervisor.stop(guildId, `stopped by ${interaction.user.id}`);

  await interaction.reply(ephemeral(`Stopped the session in <#${session.voiceChannelId}>.`));
}

async function handleLeaderboard(
  interaction: ChatInputCommandInteraction,
  deps: HandlerDeps,
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply(ephemeral("Marzano only works inside a server."));
    return;
  }

  const requested = interaction.options.getString("period") ?? "monthly";
  const period: LeaderboardPeriod = (PERIODS as readonly string[]).includes(requested)
    ? (requested as LeaderboardPeriod)
    : "monthly";

  const now = Date.now();

  // Public rather than ephemeral: a leaderboard is worth showing the channel,
  // which is the whole point of having one.
  await interaction.reply({
    embeds: [
      buildLeaderboardEmbed({
        period,
        totals: leaderboardTotals(deps.db, guildId, periodBounds(period, now)),
        now,
      }),
    ],
  });
}

/**
 * Change the split for the running session only.
 *
 * The running stage keeps its existing deadline; the new durations apply from
 * the next stage. The channel's saved configuration is deliberately untouched,
 * so a mid-session experiment does not become permanent.
 */
async function handleSessionSplitModal(interaction: Interaction, deps: HandlerDeps): Promise<void> {
  if (!interaction.isModalSubmit()) return;

  const guildId = interaction.guildId ?? null;
  if (!guildId) {
    await interaction.reply(ephemeral("Marzano only works inside a server."));
    return;
  }

  const session = getActiveSession(deps.db, guildId);
  if (!session || isStopped(session)) {
    await interaction.reply(ephemeral("No session is running in this server."));
    return;
  }

  const decision = authorizeControl({
    action: "change_split",
    callerVoiceChannelId: callerVoiceChannelId(interaction),
    sessionVoiceChannelId: session.voiceChannelId,
    permissions: interaction.memberPermissions?.bitfield ?? 0n,
  });

  if (!decision.allowed) {
    await interaction.reply(ephemeral(decision.reason ?? "You cannot do that."));
    return;
  }

  try {
    const split = parseSplit(interaction.fields.getTextInputValue(SPLIT_INPUT_ID));
    const updated = changeSplit(session, split);
    saveActiveSession(deps.db, updated);

    const rendered = await deps.presenter.render(updated);
    if (rendered.messageId !== updated.statusMessageId) {
      saveActiveSession(deps.db, { ...updated, statusMessageId: rendered.messageId });
    }

    // The split change applies from the next stage, but re-arming keeps the
    // supervisor's view of the deadline authoritative.
    deps.supervisor.reschedule(guildId);

    await interaction.reply(
      ephemeral(
        `Split changed for this session: focus ${split.focusMinutes}m, short break ${split.shortBreakMinutes}m, long break ${split.longBreakMinutes}m. The current stage keeps its remaining time.`,
      ),
    );
  } catch (error) {
    if (error instanceof SplitError) {
      await interaction.reply(ephemeral(error.message));
      return;
    }
    throw error;
  }
}

async function handleModalSubmit(interaction: Interaction, deps: HandlerDeps): Promise<void> {
  if (!interaction.isModalSubmit()) return;

  // Changing the split of a running session is a session-scoped action and
  // never writes to the channel's saved configuration.
  if (interaction.customId === SESSION_SPLIT_MODAL_ID) {
    await handleSessionSplitModal(interaction, deps);
    return;
  }

  const channelId = parseSplitModalId(interaction.customId);
  if (!channelId) return;

  const guildId = interaction.guildId;
  if (!guildId) return;

  const splitText = interaction.fields.getTextInputValue(SPLIT_INPUT_ID);

  try {
    const result = applyChannelWizard(
      deps.db,
      guildId,
      channelId,
      { split: splitText },
      interaction.user.id,
    );
    const config = result.config ?? BUILT_IN_DEFAULTS;

    await interaction.reply(
      ephemeral(
        `Saved the split for this channel: focus ${config.focusMinutes}m, short break ${config.shortBreakMinutes}m, long break ${config.longBreakMinutes}m. Run \`/pomodoro start\` when you are ready.`,
      ),
    );
  } catch (error) {
    if (error instanceof SplitError || error instanceof WizardError) {
      await interaction.reply(ephemeral(error.message));
      return;
    }
    throw error;
  }
}

export async function handleInteraction(
  interaction: Interaction,
  deps: HandlerDeps,
): Promise<void> {
  if (interaction.isButton()) {
    await handleSessionButton(interaction, {
      db: deps.db,
      presenter: deps.presenter,
      supervisor: deps.supervisor,
      voiceChannelIdOf: callerVoiceChannelId,
    });
    return;
  }

  if (interaction.isModalSubmit()) {
    await handleModalSubmit(interaction, deps);
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const command = interaction.commandName;

  if (command === INFO_COMMAND.name) {
    await handleInfo(interaction, deps);
    return;
  }

  // /pomodoro and /start are the same command under two names.
  if (isStartCommand(command)) {
    await handleStart(interaction, deps);
    return;
  }

  if (command === STATUS_COMMAND.name) {
    await handleStatus(interaction, deps);
    return;
  }

  if (command === CONFIGURE_COMMAND.name) {
    await handleConfigure(interaction, deps);
    return;
  }

  if (command === DEFAULT_COMMAND.name) {
    await handleDefault(interaction, deps);
    return;
  }

  if (command === STOP_COMMAND.name) {
    await handleStop(interaction, deps);
    return;
  }

  if (command === LEADERBOARD_COMMAND.name) {
    await handleLeaderboard(interaction, deps);
    return;
  }
}
