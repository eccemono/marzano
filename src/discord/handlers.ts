import {
  type ChatInputCommandInteraction,
  type Interaction,
  type ModalSubmitInteraction,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";

import { getChannelConfig, getGuildDefaults } from "../db/config-repository";
import type { Db } from "../db/database";
import { getActiveSession, saveActiveSession } from "../db/session-repository";
import {
  BUILT_IN_DEFAULTS,
  type PomodoroConfig,
  isAdvanceMode,
  resolveConfig,
} from "../domain/config";
import { SplitError, parseSplit } from "../domain/split";
import {
  type TimerSession,
  changeSplit,
  isStopped,
  remainingMs,
  startSession,
} from "../domain/timer";
import {
  CONFIG_INPUT_IDS,
  CONFIGURE_MODAL_ID,
  SETTINGS_MODAL_ID,
  SPLIT_INPUT_ID,
  SPLIT_MODAL_ID,
  buildConfigModal,
  buildSplitModal,
  parseAdvanceMode,
  parseOnOff,
} from "./modals";
import { canConfigureChannel, canConfigureGuild } from "./permissions";
import { handleSessionButton } from "./session-buttons";
import { SESSION_SPLIT_MODAL_ID, authorizeControl } from "./session-controls";
import { buildLeaderboardEmbed } from "./history-views";
import { leaderboardTotals } from "../db/history-repository";
import { periodBounds, type LeaderboardPeriod } from "../domain/attendance";
import type { SessionRendererPort } from "./session-renderer";
import type { SessionSupervisor } from "../session/supervisor";
import type { SessionVoice } from "../voice/manager";
import { WORK_CUE, type SoundLibrary } from "../voice/sounds";
import {
  PLAYBACK_STRATEGIES,
  STRATEGY_HELP,
  type PlaybackStrategy,
  type TestStrategy,
} from "../voice/diagnostics";
import { LICENSE, REPOSITORY_URL, VERSION } from "../runtime";

import {
  CONFIGURE_COMMAND,
  SETTINGS_COMMAND,
  INFO_COMMAND,
  LEADERBOARD_COMMAND,
  PERIODS,
  STATUS_COMMAND,
  STOP_COMMAND,
  TEST_COMMAND,
  isStartCommand,
} from "../commands/definitions";
import { buildInfoEmbed, type InfoPayload } from "../commands/info";
import { decideStart } from "../commands/start-decision";
import {
  WizardError,
  type WizardInput,
  applyChannelWizard,
  applyGuildDefaultsWizard,
} from "../commands/wizard";

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
  /**
   * TEMPORARY: voice access for the `/test` audio diagnostic.
   *
   * Optional so nothing else has to know about the command; the handler reports
   * that diagnostics are unavailable rather than failing.
   */
  voice?: SessionVoice;
  sounds?: SoundLibrary;
}

function ephemeral(content: string): { content: string; flags: number } {
  return { content, flags: MessageFlags.Ephemeral as number };
}

/** One line describing a resolved configuration, used by every save path. */
function describeConfig(config: PomodoroConfig): string {
  return (
    `focus ${config.focusMinutes}m, short break ${config.shortBreakMinutes}m, long break ` +
    `${config.longBreakMinutes}m, long break every ${config.cyclesBeforeLongBreak} focus ` +
    `periods, sound ${config.soundEnabled ? "on" : "off"} at ${config.soundVolume}%, ` +
    `advance mode ${config.advanceMode}`
  );
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

/**
 * The fast half of starting: precedence, permissions and configuration.
 *
 * Separated from the work that follows because an interaction must be answered
 * within three seconds, while posting the status message and joining a voice
 * channel have no such budget. Deciding first lets the handler answer - or open
 * the setup modal, which is only possible as an interaction's first response -
 * before it does anything slow.
 */
export type StartPlan =
  | { kind: "reject"; message: string }
  | { kind: "open-setup"; reason: "unconfigured" | "invalid-split" }
  | { kind: "ready"; config: ReturnType<typeof resolveConfig> };

export function planStart(deps: HandlerDeps, request: StartRequest): StartPlan {
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

  return {
    kind: "ready",
    config: resolveConfig(decision.split ?? undefined, stored?.config ?? undefined),
  };
}

/**
 * The slow half: create the session, post its status message and adopt it.
 *
 * The supervisor then takes over - it persists, schedules the first stage wake
 * and plays the cue - so no caller has to know the order those must happen in.
 */
export async function beginStart(
  deps: HandlerDeps,
  request: StartRequest,
  config: ReturnType<typeof resolveConfig>,
): Promise<Extract<StartOutcome, { kind: "started" }>> {
  const session = startSession({
    guildId: request.guildId,
    voiceChannelId: request.voiceChannelId,
    textChannelId: request.textChannelId,
    config,
    now: Date.now(),
  });
  saveActiveSession(deps.db, session);

  // Post the canonical status message and remember its id, so later refreshes
  // edit this one instead of posting duplicates.
  const rendered = await deps.presenter.render(session);
  const started = { ...session, statusMessageId: rendered.messageId };
  await deps.supervisor.begin(started);

  return { kind: "started", channelId: request.voiceChannelId, config, session: started };
}

/** Decision plus work, for callers with no interaction deadline to respect. */
export async function startFrom(deps: HandlerDeps, request: StartRequest): Promise<StartOutcome> {
  const plan = planStart(deps, request);

  if (plan.kind === "reject") return { kind: "reject", message: plan.message };
  if (plan.kind === "open-setup") return { kind: "open-setup", reason: plan.reason };

  return beginStart(deps, request, plan.config);
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

  const request: StartRequest = {
    guildId,
    textChannelId: interaction.channelId,
    voiceChannelId: interaction.channelId,
    splitInput: interaction.options.getString("split"),
  };

  // Decide before answering: the refusal and the setup modal are both responses
  // that cannot be sent after a deferral, and neither needs any slow work.
  const plan = planStart(deps, request);

  if (plan.kind === "reject") {
    await interaction.reply(ephemeral(plan.message));
    return;
  }

  if (plan.kind === "open-setup") {
    const modal = buildSplitModal({
      title: plan.reason === "unconfigured" ? "Set up this channel" : "Check the split",
    }).setCustomId(`${SPLIT_MODAL_ID}:${interaction.channelId}`);
    await interaction.showModal(modal);
    return;
  }

  // Then acknowledge silently and get out of the way. The posted status message
  // is the thing the user asked for, so there is nothing left to say - and
  // replying only once the render and the voice join had finished is what risked
  // falling past the three-second deadline.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await beginStart(deps, request, plan.config);
  await interaction.deleteReply().catch(() => {
    // Already gone; nothing to clean up.
  });
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

  const split = interaction.options.getString("split");
  const cycles = interaction.options.getInteger("cycles");
  const sound = interaction.options.getBoolean("sound");
  const volume = interaction.options.getInteger("volume");
  // Constrained by the option's choices; anything else resolves to "not set".
  const autoRaw = interaction.options.getString("auto");
  const advanceMode = isAdvanceMode(autoRaw) ? autoRaw : null;
  const copyFrom = interaction.options.getChannel("copy_from");
  const reset = interaction.options.getBoolean("reset") ?? false;

  // Run with no options at all: open the menu rather than complaining.
  if (
    split === null &&
    cycles === null &&
    sound === null &&
    volume === null &&
    advanceMode === null &&
    copyFrom === null &&
    !reset
  ) {
    const stored = getChannelConfig(deps.db, guildId, interaction.channelId);
    await interaction.showModal(
      buildConfigModal({
        customId: CONFIGURE_MODAL_ID,
        title: "Configure this channel",
        initial: stored?.config ?? null,
      }),
    );
    return;
  }

  try {
    const result = applyChannelWizard(
      deps.db,
      guildId,
      interaction.channelId,
      { split, cycles, sound, volume, advanceMode, copyFromChannelId: copyFrom?.id ?? null, reset },
      interaction.user.id,
    );

    if (result.action === "reset") {
      await interaction.reply(ephemeral("This channel's saved configuration was cleared."));
      return;
    }

    await interaction.reply(
      ephemeral(`Saved: ${describeConfig(result.config ?? BUILT_IN_DEFAULTS)}.`),
    );
  } catch (error) {
    if (error instanceof SplitError || error instanceof WizardError) {
      await interaction.reply(ephemeral(error.message));
      return;
    }
    throw error;
  }
}

async function handleSettings(
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
    await interaction.reply(ephemeral("You need Manage Server to change the global settings."));
    return;
  }

  const split = interaction.options.getString("split");
  const cycles = interaction.options.getInteger("cycles");
  const sound = interaction.options.getBoolean("sound");
  const volume = interaction.options.getInteger("volume");
  // Constrained by the option's choices; anything else resolves to "not set".
  const autoRaw = interaction.options.getString("auto");
  const advanceMode = isAdvanceMode(autoRaw) ? autoRaw : null;

  if (
    split === null &&
    cycles === null &&
    sound === null &&
    volume === null &&
    advanceMode === null
  ) {
    const stored = getGuildDefaults(deps.db, guildId);
    await interaction.showModal(
      buildConfigModal({
        customId: SETTINGS_MODAL_ID,
        title: "Marzano settings",
        initial: stored ?? null,
      }),
    );
    return;
  }

  try {
    const result = applyGuildDefaultsWizard(deps.db, guildId, {
      split,
      cycles,
      sound,
      volume,
      advanceMode,
    });

    const config = result.config ?? BUILT_IN_DEFAULTS;
    await interaction.reply(ephemeral(`Global settings updated: ${describeConfig(config)}.`));
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

  // Acknowledge before the slow teardown. Stop through the supervisor: writing
  // the row directly left the stage timer armed and the bot sitting in the voice
  // channel - the session looked stopped in the database while it still ran in
  // Discord. That teardown can exceed the three-second interaction budget, so the
  // click is answered first.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await deps.supervisor.stop(guildId, `stopped by ${interaction.user.id}`);
  await interaction.editReply(`Stopped the session in <#${session.voiceChannelId}>.`);
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
 * TEMPORARY: report what the voice path is actually doing.
 *
 * Encoding and the cue assets have both been verified independently, so the
 * remaining question is which playback path is audible. Each strategy is timed:
 * a cue that really plays takes about as long as the audio lasts, while one the
 * pipeline swallows immediately reports a few milliseconds.
 */
function botPermissions(
  interaction: ChatInputCommandInteraction,
  deps: HandlerDeps,
  channelId: string,
): string {
  const channel = interaction.guild?.channels.cache.get(channelId);
  if (!channel) return "unknown (channel not cached)";

  const permissions = channel.permissionsFor(deps.applicationId());
  if (!permissions) return "unknown (no permission object)";

  return `Connect=${permissions.has(PermissionFlagsBits.Connect)} Speak=${permissions.has(
    PermissionFlagsBits.Speak,
  )}`;
}

async function handleTest(
  interaction: ChatInputCommandInteraction,
  deps: HandlerDeps,
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply(ephemeral("Marzano only works inside a server."));
    return;
  }

  if (!deps.voice) {
    await interaction.reply(ephemeral("Voice diagnostics are not wired up in this build."));
    return;
  }

  const voiceChannelId = callerVoiceChannelId(interaction);
  if (!voiceChannelId) {
    await interaction.reply(ephemeral("Join a voice channel first, then run /test again."));
    return;
  }

  const requested = interaction.options.getString("strategy") ?? "diag";
  const strategy: TestStrategy = (["diag", ...PLAYBACK_STRATEGIES] as string[]).includes(requested)
    ? (requested as TestStrategy)
    : "diag";

  // Several seconds of audio: defer so the interaction is answered in time.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const lines: string[] = [];
  lines.push(`channel: <#${voiceChannelId}>`);
  lines.push(`bot perms: ${botPermissions(interaction, deps, voiceChannelId)}`);
  lines.push(`voice connection: ${deps.voice.isConnected(guildId) ? "ready" : "none"}`);

  const bellFrames = deps.sounds?.frames(WORK_CUE, 80)?.length;
  lines.push(`work cue frames at 80%: ${bellFrames ?? "unavailable"}`);

  const strategies: readonly PlaybackStrategy[] =
    strategy === "diag" ? PLAYBACK_STRATEGIES : [strategy];

  const session = {
    guildId,
    voiceChannelId,
    stage: "focus" as const,
    config: { soundEnabled: true, soundVolume: 100 },
  };

  for (const candidate of strategies) {
    lines.push(`— ${candidate}: ${STRATEGY_HELP[candidate]}`);
    const report = await deps.voice.playTest(session, candidate);
    lines.push(
      [
        `  played=${report.played}`,
        `elapsed=${report.elapsedMs}ms`,
        `frames=${report.frames}`,
        `bytes=${report.bytes}`,
        `states=${report.states.join(" -> ") || "none"}`,
        report.reason ? `reason=${report.reason}` : "",
      ]
        .filter(Boolean)
        .join("  "),
    );
  }

  lines.push(`connection after: ${deps.voice.isConnected(guildId) ? "ready" : "none"}`);

  await interaction.editReply(lines.join("\n"));
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

/** Read the shared config-modal fields into a wizard input, skipping empties. */
function configInputFromModal(interaction: ModalSubmitInteraction): WizardInput {
  const field = (id: string): string => interaction.fields.getTextInputValue(id) ?? "";

  const input: WizardInput = {};

  const splitText = field(CONFIG_INPUT_IDS.split).trim();
  if (splitText) input.split = splitText;

  const cycles = field(CONFIG_INPUT_IDS.cycles).trim();
  if (cycles) input.cycles = Number(cycles);

  const sound = parseOnOff(field(CONFIG_INPUT_IDS.sound));
  if (sound !== null) input.sound = sound;

  const volume = field(CONFIG_INPUT_IDS.volume).trim();
  if (volume) input.volume = Number(volume);

  const autoText = field(CONFIG_INPUT_IDS.auto).trim();
  if (autoText) {
    const mode = parseAdvanceMode(autoText);
    // An unrecognised value is rejected rather than silently dropped: a typo
    // that quietly changed nothing would be worse than an error message.
    if (mode === null) {
      throw new WizardError(`Advance mode must be auto, manual or semi; received "${autoText}".`);
    }
    input.advanceMode = mode;
  }

  return input;
}

/** Apply a full configuration modal to the channel or the guild. */
async function handleConfigModalSubmit(
  interaction: ModalSubmitInteraction,
  deps: HandlerDeps,
  scope: "channel" | "guild",
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) return;

  const channelId = interaction.channelId;
  if (!channelId) {
    await interaction.reply(ephemeral("This command only works in a server channel."));
    return;
  }

  try {
    const input = configInputFromModal(interaction);

    if (scope === "guild") {
      const result = applyGuildDefaultsWizard(deps.db, guildId, input);
      await interaction.reply(
        ephemeral(
          `Global settings updated: ${describeConfig(result.config ?? BUILT_IN_DEFAULTS)}.`,
        ),
      );
      return;
    }

    const result = applyChannelWizard(deps.db, guildId, channelId, input, interaction.user.id);

    if (result.action === "reset") {
      await interaction.reply(ephemeral("This channel's saved configuration was cleared."));
      return;
    }

    await interaction.reply(
      ephemeral(`Saved: ${describeConfig(result.config ?? BUILT_IN_DEFAULTS)}.`),
    );
  } catch (error) {
    if (error instanceof SplitError || error instanceof WizardError) {
      await interaction.reply(ephemeral(error.message));
      return;
    }
    throw error;
  }
}

async function handleModalSubmit(interaction: Interaction, deps: HandlerDeps): Promise<void> {
  if (!interaction.isModalSubmit()) return;

  if (interaction.customId === CONFIGURE_MODAL_ID) {
    await handleConfigModalSubmit(interaction, deps, "channel");
    return;
  }

  if (interaction.customId === SETTINGS_MODAL_ID) {
    await handleConfigModalSubmit(interaction, deps, "guild");
    return;
  }

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

  if (command === SETTINGS_COMMAND.name) {
    await handleSettings(interaction, deps);
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

  // TEMPORARY: audio diagnosis, removed once cue playback is known-good.
  if (command === TEST_COMMAND.name) {
    await handleTest(interaction, deps);
    return;
  }
}
