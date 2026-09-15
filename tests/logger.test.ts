import { describe, expect, it } from "vitest";

import { createLogger, redactString, redactValue } from "../src/logger";
import { FAKE_DISCORD_TOKEN, FAKE_GITHUB_PAT, FAKE_OPENAI_KEY } from "./fixtures/credentials";

function capture(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => void lines.push(line) };
}

describe("redactString", () => {
  it("redacts a discord bot token embedded in free text", () => {
    expect(redactString(`login with token=${FAKE_DISCORD_TOKEN} now`)).toBe(
      "login with token=[redacted] now",
    );
  });

  it("redacts a github personal access token", () => {
    expect(redactString(FAKE_GITHUB_PAT)).toBe("[redacted]");
  });

  it("redacts a provider api key", () => {
    expect(redactString(FAKE_OPENAI_KEY)).toBe("[redacted]");
  });

  it("leaves ordinary text untouched", () => {
    expect(redactString("focus cycle completed")).toBe("focus cycle completed");
  });
});

describe("redactValue", () => {
  it("blanks values whose key looks sensitive", () => {
    expect(redactValue({ discordToken: FAKE_DISCORD_TOKEN })).toEqual({
      discordToken: "[redacted]",
    });
  });

  it("redacts secrets nested inside objects and arrays", () => {
    const result = redactValue({ nested: { list: [`prefix ${FAKE_DISCORD_TOKEN}`] } });
    expect(JSON.stringify(result)).not.toContain(FAKE_DISCORD_TOKEN);
  });

  it("preserves non-sensitive structure", () => {
    expect(redactValue({ guildId: "123", stage: "focus" })).toEqual({
      guildId: "123",
      stage: "focus",
    });
  });

  it("bounds recursion depth", () => {
    let nested: Record<string, unknown> = { value: "leaf" };
    for (let index = 0; index < 20; index += 1) {
      nested = { child: nested };
    }
    expect(JSON.stringify(redactValue(nested))).toContain("[truncated]");
  });
});

describe("createLogger", () => {
  it("emits one JSON line per call and never leaks a token", () => {
    const { lines, write } = capture();
    const logger = createLogger({
      level: "debug",
      bindings: { bot: "Marzano" },
      sink: write,
    });

    logger.info("startup", { discordToken: FAKE_DISCORD_TOKEN, guildId: "42" });

    expect(lines).toHaveLength(1);
    const line = lines[0] ?? "";
    expect(line).not.toContain(FAKE_DISCORD_TOKEN);

    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.level).toBe("info");
    expect(parsed.msg).toBe("startup");
    expect(parsed.fields).toMatchObject({
      bot: "Marzano",
      guildId: "42",
      discordToken: "[redacted]",
    });
  });

  it("suppresses records below the configured level", () => {
    const { lines, write } = capture();
    const logger = createLogger({ level: "warn", sink: write });

    logger.debug("noise");
    logger.info("noise");
    logger.warn("kept");

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ level: "warn", msg: "kept" });
  });

  it("carries child bindings into every record", () => {
    const { lines, write } = capture();
    const logger = createLogger({ level: "info", sink: write }).child({ guildId: "99" });

    logger.info("tick");

    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      msg: "tick",
      fields: { guildId: "99" },
    });
  });
});
