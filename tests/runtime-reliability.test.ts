/**
 * Regression tests for the faults reported from the production deploy.
 *
 * Each case here failed, in behaviour, on the live bot:
 *
 *   1. A session started after boot never refreshed. The refresh loop was
 *      created once at startup, for whichever sessions existed then, so a new
 *      one had no loop and its countdown sat frozen until a button was pressed.
 *   2. A stage ending on its own advanced the database but did not repaint the
 *      message, so the embed kept showing the stage that had already finished.
 *   3. Refreshes fetched the message before editing it, which needs Read
 *      Message History - a permission this bot deliberately does not request.
 *   4. The bot never unmuted for its own cues: the unmute went through the
 *      server-mute API instead of the connection's own self-mute state.
 *
 * These are behavioural tests, not unit trivia: they assert the thing the user
 * could observe.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { DiscordAPIError, type Client } from "discord.js";
import { describe, expect, it } from "vitest";

import { getActiveSession } from "../src/db/session-repository";
import { handleInteraction } from "../src/discord/handlers";
import { createMessageGateway } from "../src/discord/message-gateway";
import { type SessionPayload, SessionMessageMissingError } from "../src/discord/session-presenter";
import { CHANNEL, GUILD, MINUTE, newSession, setup } from "./helpers/harness";

/**
 * The smallest thing that behaves like a `/pomodoro stop` interaction.
 *
 * The caller is in the session's voice channel, so authorization passes and the
 * test exercises the stop path itself rather than the permission branch.
 */
function stopInteraction() {
  return {
    isButton: () => false,
    isModalSubmit: () => false,
    isChatInputCommand: () => true,
    commandName: "pomodoro",
    guildId: GUILD,
    channelId: CHANNEL,
    user: { id: "user-1" },
    memberPermissions: { bitfield: 0n },
    member: { voice: { channelId: CHANNEL } },
    options: {
      getSubcommand: () => "stop",
      getString: () => null,
      getInteger: () => null,
      getBoolean: () => null,
      getChannel: () => null,
    },
    async reply() {
      return undefined;
    },
  };
}

describe("a session started at runtime begins refreshing", () => {
  it("starts a refresh loop as soon as the session begins", async () => {
    const { supervisor, presenter } = setup();

    expect(presenter.watching.has(GUILD)).toBe(false);

    await supervisor.begin(newSession());

    expect(presenter.watching.has(GUILD)).toBe(true);
  });
});

describe("a stage that ends on its own repaints the message", () => {
  it("renders the new stage at the boundary without anyone pressing a button", async () => {
    const { supervisor, presenter, timers } = setup();

    await supervisor.begin(newSession());
    presenter.renders.length = 0;

    // Let the focus stage expire on its own.
    await timers.advanceBy(25 * MINUTE);

    const last = presenter.renders.at(-1);
    expect(last).toBeDefined();
    expect(last?.stage).toBe("short_break");
  });

  it("keeps repainting through a whole cycle, not just the first boundary", async () => {
    const { supervisor, presenter, timers } = setup();

    await supervisor.begin(newSession());
    presenter.renders.length = 0;

    await timers.advanceBy(25 * MINUTE);
    await timers.advanceBy(5 * MINUTE);

    const stages = presenter.renders.map((session) => session.stage);
    expect(stages).toContain("short_break");
    expect(stages.at(-1)).toBe("focus");
  });
});

describe("stopping", () => {
  it("stops refreshing and releases the guild", async () => {
    const { supervisor, presenter, voice } = setup();

    await supervisor.begin(newSession());
    expect(presenter.watching.has(GUILD)).toBe(true);

    await supervisor.stop(GUILD, "test");

    expect(presenter.watching.has(GUILD)).toBe(false);
    expect(voice.leaves).toBeGreaterThan(0);
  });
});

/** A payload with no content; these tests only care about which call is made. */
function emptyPayload(): SessionPayload {
  return { embeds: [], components: [] } as unknown as SessionPayload;
}

/** A text channel that records the calls the gateway makes. */
function fakeChannel() {
  const fetches: string[] = [];
  const edits: { id: string; payload: unknown }[] = [];

  const channel = {
    isTextBased: () => true,
    isDMBased: () => false,
    messages: {
      async fetch(id: string) {
        fetches.push(id);
        return { id, edit: async () => {} };
      },
      async edit(id: string, payload: unknown) {
        edits.push({ id, payload });
        return { id };
      },
    },
    async send() {
      return { id: "posted-message" };
    },
  };

  const client = { channels: { fetch: async () => channel } } as unknown as Client;

  return { client, channel, fetches, edits };
}

describe("refreshing a status message", () => {
  it("edits by id instead of fetching the message first", async () => {
    const { client, fetches, edits } = fakeChannel();
    const gateway = createMessageGateway(client);

    await gateway.edit(CHANNEL, "message-1", emptyPayload());

    // The fetch is the part that needs Read Message History. Editing by id
    // needs only Send Messages, which the bot actually has.
    expect(fetches).toEqual([]);
    expect(edits.map((entry) => entry.id)).toEqual(["message-1"]);
  });

  it("reports a deleted message so the presenter can post a replacement", async () => {
    const { client, channel } = fakeChannel();
    channel.messages.edit = async () => {
      // The REST layer always supplies the body data, and the error class
      // dereferences it unconditionally.
      throw new DiscordAPIError(
        { code: 10_008, message: "Unknown Message" },
        10_008,
        404,
        "PUT",
        "/channels/x/messages/y",
        { files: [], body: {} },
      );
    };

    const gateway = createMessageGateway(client);

    await expect(gateway.edit(CHANNEL, "gone", emptyPayload())).rejects.toBeInstanceOf(
      SessionMessageMissingError,
    );
  });
});

describe("the voice gateway changes its own self state", () => {
  it("uses rejoin rather than the server-side mute API", async () => {
    // The original bug is a *contract* mistake, not a typo: the wrong API was
    // called. Nothing in a fake gateway can catch that, so the real
    // implementation is checked directly.
    const source = await readFile(join(__dirname, "..", "src", "voice", "gateway.ts"), "utf8");

    expect(source).toContain("rejoin(");
    expect(source).not.toContain("setMute(");
    expect(source).not.toContain("setDeaf(");
  });
});

describe("the slash stop command", () => {
  it("goes through the supervisor instead of only editing the database", async () => {
    // The old handler wrote the stopped row and deleted it, and stopped there.
    // The stage timer stayed armed and the bot stayed in the voice channel: the
    // session looked finished in the database while it was still live in
    // Discord.
    const { db, supervisor, presenter, voice } = setup();
    await supervisor.begin(newSession());

    await handleInteraction(stopInteraction() as never, {
      db,
      presenter,
      supervisor,
      uptimeSeconds: () => 0,
      gatewayLatencyMs: () => 0,
      guildCount: () => 1,
      applicationId: () => "application-id",
    });

    expect(getActiveSession(db, GUILD)).toBeNull();
    expect(supervisor.isScheduled(GUILD)).toBe(false);
    expect(presenter.watching.has(GUILD)).toBe(false);
    expect(voice.leaves).toBeGreaterThan(0);
  });
});
