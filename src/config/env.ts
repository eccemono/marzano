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
  ffmpegPath: string;
  /** When set, slash commands register in this guild only (instant updates). */
  devGuildId: string | null;
}

/** Discord snowflakes are 17-20 digit decimal strings. */
const SNOWFLAKE = /^\d{17,20}$/;

const DEFAULT_DATA_DIR = "./data";
const DEFAULT_FFMPEG_PATH = "ffmpeg";
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

  const devGuildId = (env.DEV_GUILD_ID ?? "").trim();
  if (devGuildId.length > 0 && !SNOWFLAKE.test(devGuildId)) {
    throw new ConfigError("DEV_GUILD_ID must be a Discord snowflake when set.");
  }

  return {
    discordToken,
    clientId,
    logLevel: readLogLevel(env),
    dataDir: (env.DATA_DIR ?? "").trim() || DEFAULT_DATA_DIR,
    ffmpegPath: (env.FFMPEG_PATH ?? "").trim() || DEFAULT_FFMPEG_PATH,
    devGuildId: devGuildId.length > 0 ? devGuildId : null,
  };
}
