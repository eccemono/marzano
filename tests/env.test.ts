import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "../src/config/env";
import { FAKE_CLIENT_ID, FAKE_DISCORD_TOKEN } from "./fixtures/credentials";

function validEnv(): NodeJS.ProcessEnv {
  return { DISCORD_TOKEN: FAKE_DISCORD_TOKEN, CLIENT_ID: FAKE_CLIENT_ID };
}

describe("loadConfig", () => {
  it("applies documented defaults", () => {
    const config = loadConfig(validEnv());

    expect(config.discordToken).toBe(FAKE_DISCORD_TOKEN);
    expect(config.clientId).toBe(FAKE_CLIENT_ID);
    expect(config.logLevel).toBe("info");
    expect(config.dataDir).toBe("./data");
    expect(config.ffmpegPath).toBe("ffmpeg");
    expect(config.devGuildId).toBeNull();
  });

  it("trims surrounding whitespace", () => {
    expect(loadConfig({ ...validEnv(), DATA_DIR: "  /srv/marzano  " }).dataDir).toBe(
      "/srv/marzano",
    );
  });

  it("accepts an explicit log level case-insensitively", () => {
    expect(loadConfig({ ...validEnv(), LOG_LEVEL: "DEBUG" }).logLevel).toBe("debug");
  });

  it("rejects an unknown log level", () => {
    expect(() => loadConfig({ ...validEnv(), LOG_LEVEL: "loud" })).toThrow(ConfigError);
  });

  it("rejects a missing token without echoing anything secret", () => {
    const env = validEnv();
    delete env.DISCORD_TOKEN;

    let caught: unknown;
    try {
      loadConfig(env);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConfigError);
    const message = (caught as Error).message;
    expect(message).toContain("DISCORD_TOKEN");
    expect(message).not.toContain(FAKE_DISCORD_TOKEN);
  });

  it("rejects a whitespace-only token", () => {
    expect(() => loadConfig({ ...validEnv(), DISCORD_TOKEN: "   " })).toThrow(ConfigError);
  });

  it("rejects a missing client id", () => {
    const env = validEnv();
    delete env.CLIENT_ID;

    expect(() => loadConfig(env)).toThrow(/CLIENT_ID/);
  });

  it("rejects a client id that is not a snowflake", () => {
    expect(() => loadConfig({ ...validEnv(), CLIENT_ID: "not-a-snowflake" })).toThrow(/snowflake/);
  });

  it("accepts a snowflake dev guild id and rejects a malformed one", () => {
    expect(loadConfig({ ...validEnv(), DEV_GUILD_ID: FAKE_CLIENT_ID }).devGuildId).toBe(
      FAKE_CLIENT_ID,
    );
    expect(() => loadConfig({ ...validEnv(), DEV_GUILD_ID: "nope" })).toThrow(/DEV_GUILD_ID/);
  });
});
