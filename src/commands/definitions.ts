import { ApplicationCommandOptionType, ChannelType } from "discord.js";

/**
 * The slash-command surface, declared once as data.
 *
 * Registration sends exactly this payload, and the tests assert against it, so
 * the advertised interface cannot drift from the implemented one.
 *
 * There are deliberately no prefix commands and no Message Content intent:
 * everything arrives through interactions.
 */

const SPLIT_OPTION = {
  type: ApplicationCommandOptionType.String,
  name: "split",
  description: "Override the split for this session, for example 25 5 15",
  required: false,
} as const;

const PERIOD_OPTION = {
  type: ApplicationCommandOptionType.String,
  name: "period",
  description: "Which period to show",
  required: false,
  choices: [
    { name: "This month", value: "monthly" },
    { name: "This year", value: "yearly" },
    { name: "All time", value: "all-time" },
  ],
} as const;

/**
 * The advance-mode option, shared by both configuration surfaces.
 *
 * Declared once on purpose. It belongs to two option lists, and duplicating the
 * literal is how it came to be defined three times in `/configure` - which
 * Discord rejects outright, taking the whole command set down with it.
 */
const ADVANCE_MODE_OPTION = {
  type: ApplicationCommandOptionType.String,
  name: "auto",
  description: "How stages advance: auto, manual, or semi (auto break, manual next work)",
  required: false,
  choices: [
    { name: "auto - every stage advances by itself", value: "auto" },
    { name: "manual - wait for Continue every time", value: "manual" },
    { name: "semi - breaks start by themselves, work waits", value: "semi" },
  ],
} as const;

const CONFIGURE_OPTIONS = [
  {
    type: ApplicationCommandOptionType.String,
    name: "split",
    description: "Focus, short break and long break in minutes, for example 25 5 15",
    required: false,
  },
  {
    type: ApplicationCommandOptionType.Integer,
    name: "cycles",
    description: "Focus periods before a long break",
    required: false,
    min_value: 1,
    max_value: 12,
  },
  {
    type: ApplicationCommandOptionType.Boolean,
    name: "sound",
    description: "Whether to play sound cues in this channel",
    required: false,
  },
  {
    type: ApplicationCommandOptionType.Integer,
    name: "volume",
    description: "Sound volume from 0 to 100",
    required: false,
    min_value: 0,
    max_value: 100,
  },
  ADVANCE_MODE_OPTION,
  {
    type: ApplicationCommandOptionType.Channel,
    name: "copy_from",
    description: "Copy the saved configuration from another voice channel",
    required: false,
    channel_types: [ChannelType.GuildVoice],
  },
  {
    type: ApplicationCommandOptionType.Boolean,
    name: "reset",
    description: "Forget this channel's saved configuration",
    required: false,
  },
] as const;

const DEFAULT_OPTIONS = [
  {
    type: ApplicationCommandOptionType.String,
    name: "split",
    description: "Default focus, short break and long break in minutes",
    required: false,
  },
  {
    type: ApplicationCommandOptionType.Integer,
    name: "cycles",
    description: "Default focus periods before a long break",
    required: false,
    min_value: 1,
    max_value: 12,
  },
  {
    type: ApplicationCommandOptionType.Boolean,
    name: "sound",
    description: "Default sound setting for newly configured channels",
    required: false,
  },
  {
    type: ApplicationCommandOptionType.Integer,
    name: "volume",
    description: "Default volume from 0 to 100",
    required: false,
    min_value: 0,
    max_value: 100,
  },
  ADVANCE_MODE_OPTION,
] as const;

/**
 * The commands are top level rather than subcommands of one command.
 *
 * `/pomodoro` and `/start` are deliberately two names for the same action:
 * "start a session" is the thing people type most, and making them reach for a
 * subcommand first was friction for no benefit. `/start` exists because it is
 * what people instinctively try; both are registered, and both do exactly the
 * same thing.
 */
export const START_COMMANDS = ["pomodoro", "start"] as const;

/** `/pomodoro` and `/start`: start a session in the caller's voice channel. */
const startCommand = (name: string, description: string) =>
  ({
    name,
    description,
    options: [SPLIT_OPTION],
  }) as const;

export const POMODORO_COMMAND = startCommand(
  "pomodoro",
  "Start a Pomodoro session in your voice channel",
);

export const START_COMMAND = startCommand(
  "start",
  "Start a Pomodoro session in your voice channel (same as /pomodoro)",
);

export const STATUS_COMMAND = {
  name: "status",
  description: "Show the current stage, cycle and remaining time",
} as const;

export const CONFIGURE_COMMAND = {
  name: "configure",
  description: "Change this voice channel's saved configuration",
  options: CONFIGURE_OPTIONS,
} as const;

export const SETTINGS_COMMAND = {
  name: "settings",
  description: "Open Marzano's global settings for this server",
  options: DEFAULT_OPTIONS,
} as const;

export const STOP_COMMAND = {
  name: "stop",
  description: "Stop the session in this voice channel",
} as const;

export const LEADERBOARD_COMMAND = {
  name: "leaderboard",
  description: "Show the most Pomodoro time in this server",
  options: [PERIOD_OPTION],
} as const;

export const INFO_COMMAND = {
  name: "info",
  description: "Show Marzano's version, uptime and source repository",
} as const;

/**
 * TEMPORARY: audio diagnosis.
 *
 * This exists only while the silent-cue cause is being found, so an operator can
 * play a cue through each candidate audio path and report which one is audible.
 * It is registered like any other command but is removed once the working path is
 * folded into the real cue playback.
 */
export const TEST_COMMAND = {
  name: "test",
  description: "TEMPORARY: play a test cue through each audio path to find the silent one",
  options: [
    {
      type: ApplicationCommandOptionType.String,
      name: "strategy",
      description: "Which audio path to try (default: all of them)",
      required: false,
      choices: [
        { name: "all paths + connection report", value: "diag" },
        { name: "current (shipped opusscript path)", value: "current" },
        { name: "native (@discordjs/opus)", value: "native" },
        { name: "pcm (raw PCM pipeline)", value: "pcm" },
      ],
    },
  ],
} as const;

export const PERIODS = ["monthly", "yearly", "all-time"] as const;
export type LeaderboardPeriodChoice = (typeof PERIODS)[number];

export const APPLICATION_COMMANDS = [
  POMODORO_COMMAND,
  START_COMMAND,
  STATUS_COMMAND,
  CONFIGURE_COMMAND,
  SETTINGS_COMMAND,
  STOP_COMMAND,
  LEADERBOARD_COMMAND,
  INFO_COMMAND,
  TEST_COMMAND,
] as const;

/** Commands that begin a session, and are therefore interchangeable. */
export function isStartCommand(name: string): boolean {
  return (START_COMMANDS as readonly string[]).includes(name);
}
