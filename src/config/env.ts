import { LOG_LEVELS, type LogLevel, isLogLevel } from "../logger";

/**
 * Environment loading and validation.
 *
 * Errors deliberately name only the offending variable and never echo its
 * value, so a malformed token cannot leak into a log or a crash report.
 */

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface AppConfig {
  discordToken: string;
  clientId: string;
  logLevel: LogLevel;
  dataDir: string;
  /** Directory holding the generated cue sounds (`start.wav`, `bell.wav`). */
  soundsDir: string;
  /** Kept so the FFmpeg path can be supplied; the audio path no longer needs it. */
  ffmpegPath: string;
  /** Bound on graceful shutdown, in milliseconds. */
  shutdownTimeoutMs: number;
  /** How long the last participant can be absent before a session ends. */
  graceMs: number;
  /** When set, slash commands register in this guild only (instant updates). */
  devGuildId: string | null;
  /**
   * Whether to mirror the stage into the voice channel's own status line.
   *
   * Off by default: it needs the Set Voice Channel Status permission, which the
   * bot's least-privilege invite does not grant.
   */
  voiceStatusEnabled: boolean;
}

/** Discord snowflakes are 17-20 digit decimal strings. */
const SNOWFLAKE = /^\d{17,20}$/;

const DEFAULT_DATA_DIR = "./data";
const DEFAULT_SOUNDS_DIR = "./assets/sounds";
const DEFAULT_FFMPEG_PATH = "ffmpeg";
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const DEFAULT_GRACE_MS = 60_000;
const DEFAULT_LOG_LEVEL: LogLevel = "info";

function requiredValue(env: NodeJS.ProcessEnv, key: string): string {
  const raw = env[key];
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value.length === 0) {
    throw new ConfigError(
      `Missing required environment variable ${key}. Set it in .env (see .env.example) or in the process environment.`,
    );
  }
  return value;
}

/**
 * Validate the log level strictly.
 *
 * A typo such as `LOG_LEVEL=verbose` is an operator mistake that would
 * otherwise be silently swallowed, so it fails loudly at the config gate.
 */
function readLogLevel(env: NodeJS.ProcessEnv): LogLevel {
  const raw = (env.LOG_LEVEL ?? "").trim().toLowerCase();
  if (raw.length === 0) return DEFAULT_LOG_LEVEL;
  if (!isLogLevel(raw)) {
    throw new ConfigError(`LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")} (received "${raw}").`);
  }
  return raw;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const discordToken = requiredValue(env, "DISCORD_TOKEN");
  const clientId = requiredValue(env, "CLIENT_ID");

  if (!SNOWFLAKE.test(clientId)) {
    throw new ConfigError(
      "CLIENT_ID must be a Discord snowflake (17-20 digits). Use the Application ID, not the bot token.",
    );
  }

  const shutdownRaw = (env.SHUTDOWN_TIMEOUT_MS ?? "").trim();
  const shutdownTimeoutMs =
    shutdownRaw.length > 0 ? Number(shutdownRaw) : DEFAULT_SHUTDOWN_TIMEOUT_MS;
  if (!Number.isFinite(shutdownTimeoutMs) || shutdownTimeoutMs <= 0) {
    throw new ConfigError(
      "SHUTDOWN_TIMEOUT_MS must be a positive number of milliseconds when set.",
    );
  }

  const graceRaw = (env.GRACE_MS ?? "").trim();
  const graceMs = graceRaw.length > 0 ? Number(graceRaw) : DEFAULT_GRACE_MS;
  if (!Number.isFinite(graceMs) || graceMs < 0) {
    throw new ConfigError("GRACE_MS must be zero or a positive number of milliseconds when set.");
  }

  const devGuildId = (env.DEV_GUILD_ID ?? "").trim();
  if (devGuildId.length > 0 && !SNOWFLAKE.test(devGuildId)) {
    throw new ConfigError("DEV_GUILD_ID must be a Discord snowflake when set.");
  }

  // Strict on purpose: a typo like VOICE_STATUS_ENABLED=ture silently reading
  // as "off" is the kind of thing that costs an hour of confused debugging.
  const voiceStatusRaw = (env.VOICE_STATUS_ENABLED ?? "").trim().toLowerCase();
  if (
    voiceStatusRaw.length > 0 &&
    !["true", "false", "1", "0", "yes", "no"].includes(voiceStatusRaw)
  ) {
    throw new ConfigError('VOICE_STATUS_ENABLED must be a boolean ("true" or "false") when set.');
  }
  const voiceStatusEnabled = ["true", "1", "yes"].includes(voiceStatusRaw);

  return {
    discordToken,
    clientId,
    logLevel: readLogLevel(env),
    dataDir: (env.DATA_DIR ?? "").trim() || DEFAULT_DATA_DIR,
    soundsDir: (env.SOUNDS_DIR ?? "").trim() || DEFAULT_SOUNDS_DIR,
    ffmpegPath: (env.FFMPEG_PATH ?? "").trim() || DEFAULT_FFMPEG_PATH,
    shutdownTimeoutMs,
    graceMs,
    devGuildId: devGuildId.length > 0 ? devGuildId : null,
    voiceStatusEnabled,
  };
}
