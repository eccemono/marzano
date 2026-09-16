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
] as const;

export const POMODORO_COMMAND = {
  name: "pomodoro",
  description: "Run a shared Pomodoro cycle in this voice channel",
  options: [
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: "start",
      description: "Start a focus cycle in this voice channel",
      options: [SPLIT_OPTION],
    },
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: "status",
      description: "Show the stage, cycle and remaining time",
    },
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: "configure",
      description: "Change this channel's saved configuration",
      options: CONFIGURE_OPTIONS,
    },
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: "default",
      description: "Change the server defaults used by newly configured channels",
      options: DEFAULT_OPTIONS,
    },
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: "stop",
      description: "Stop the session in this voice channel",
    },
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: "leaderboard",
      description: "Show the most Pomodoro time in this server",
      options: [PERIOD_OPTION],
    },
  ],
} as const;

export const INFO_COMMAND = {
  name: "info",
  description: "Show Marzano's version, uptime and source repository",
} as const;

export const PERIODS = ["monthly", "yearly", "all-time"] as const;
export type LeaderboardPeriodChoice = (typeof PERIODS)[number];

export const APPLICATION_COMMANDS = [POMODORO_COMMAND, INFO_COMMAND] as const;

export const POMODORO_SUBCOMMANDS = [
  "start",
  "status",
  "configure",
  "default",
  "stop",
  "leaderboard",
] as const;
export type PomodoroSubcommand = (typeof POMODORO_SUBCOMMANDS)[number];
