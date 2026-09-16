import { GatewayIntentBits } from "discord.js";
import { describe, expect, it } from "vitest";

import { BOT_INTENTS } from "../src/discord/client";
import { mentionsUser } from "../src/discord/mention";

/**
 * Summoning by name is the only non-interaction entry point, so it carries the
 * strictest filtering in the bot.
 */
describe("mention detection", () => {
  const BOT = "1549548366864584744";

  function message(mentions: string[]) {
    return {
      mentions: { users: { has: (id: string) => mentions.includes(id) } },
    } as never;
  }

  it("recognises an explicit mention", () => {
    expect(mentionsUser(message([BOT]), BOT)).toBe(true);
  });

  it("ignores a message that merely names the bot", () => {
    // Discord only fills mentions for an actual <@id>, so talking *about*
    // Marzano in prose cannot start a timer.
    expect(mentionsUser(message([]), BOT)).toBe(false);
  });

  it("ignores a mention of somebody else", () => {
    expect(mentionsUser(message(["111111111111111111"]), BOT)).toBe(false);
  });
});

describe("mention requires no privileged intent", () => {
  it("enables GuildMessages so the event arrives", () => {
    expect([...BOT_INTENTS]).toContain(GatewayIntentBits.GuildMessages);
  });

  it("still does not request Message Content, so nothing said can be read", () => {
    // GuildMessages delivers the event and the mention metadata. Discord only
    // populates `message.content` when the privileged Message Content intent is
    // also enabled, so the bot can be summoned by name without being able to
    // read a single message. A `!prefix` command would require that privileged
    // intent - which is exactly why there isn't one.
    expect([...BOT_INTENTS]).not.toContain(GatewayIntentBits.MessageContent);
  });
});
