import { GatewayIntentBits } from "discord.js";
import { describe, expect, it } from "vitest";

import { BOT_INTENTS } from "../src/discord/client";
import { createLogger, redactString } from "../src/logger";
import { FAKE_DISCORD_TOKEN } from "./fixtures/credentials";
import { GUILD, MINUTE, newSession, setup } from "./helpers/harness";

/**
 * Log safety.
 *
 * Two separate guarantees are checked here, and they are worth keeping distinct:
 *
 *   1. Marzano never *receives* message content, because it does not request
 *      the Message Content intent. There is nothing to leak.
 *   2. Nothing that is written to the logs can contain a credential, because
 *      every value passes through redaction on the way out.
 *
 * The first is structural, the second is enforced at runtime. Together they
 * mean an operator can hand these logs to a third party without a second
 * thought.
 */

function capture() {
  const lines: string[] = [];
  return {
    lines,
    logger: createLogger({ level: "debug", sink: (line) => void lines.push(line) }),
  };
}

describe("intents", () => {
  it("never requests Message Content, so message content cannot be received", () => {
    expect(BOT_INTENTS).not.toContain(GatewayIntentBits.MessageContent);
  });

  it("requests only the two non-privileged intents it needs", () => {
    expect([...BOT_INTENTS].sort()).toEqual(
      [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates].sort(),
    );
  });
});

describe("redaction", () => {
  it("redacts a credential supplied as a field value", () => {
    const { lines, logger } = capture();

    logger.info("startup", { config: { discordToken: FAKE_DISCORD_TOKEN } });

    const output = lines.join("\n");
    expect(output).not.toContain(FAKE_DISCORD_TOKEN);
    expect(output).toContain("[redacted]");
  });

  it("redacts a credential appearing inside free text", () => {
    expect(redactString(`connecting with ${FAKE_DISCORD_TOKEN}`)).not.toContain(FAKE_DISCORD_TOKEN);
  });

  it("redacts a credential nested inside an array", () => {
    const { lines, logger } = capture();

    logger.warn("retrying", { attempts: [FAKE_DISCORD_TOKEN, "plain"] });

    expect(lines.join("\n")).not.toContain(FAKE_DISCORD_TOKEN);
  });
});

describe("a full session lifecycle", () => {
  it("emits no credential anywhere in its logs", async () => {
    const { lines, logger } = capture();
    const { supervisor, timers } = setup({ logger });

    logger.info("boot", { token: FAKE_DISCORD_TOKEN, guilds: 1 });
    await supervisor.begin(newSession());
    await timers.advanceBy(25 * MINUTE);
    await timers.advanceBy(5 * MINUTE);
    await supervisor.presenceChanged(GUILD);
    await supervisor.stop(GUILD, "stopped by a participant");
    await supervisor.shutdown();

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain(FAKE_DISCORD_TOKEN);
  });

  it("writes structured lines that are individually parseable", async () => {
    const { lines, logger } = capture();
    const { supervisor, timers } = setup({ logger });

    await supervisor.begin(newSession());
    await timers.advanceBy(25 * MINUTE);

    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("records why a session ended, so an operator can see it", async () => {
    const { lines, logger } = capture();
    const { supervisor } = setup({ logger });

    await supervisor.begin(newSession());
    await supervisor.stop(GUILD, "everyone left the voice channel");

    expect(lines.join("\n")).toContain("everyone left the voice channel");
  });
});
