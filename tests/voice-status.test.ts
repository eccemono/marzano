import { DiscordAPIError } from "discord.js";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config/env";
import { createLogger } from "../src/logger";
import { VoiceStatus, type VoiceStatusGateway } from "../src/voice/channel-status";
import { MINUTE, newSession, silentLogger } from "./helpers/harness";

/**
 * The voice-channel status is optional and must stay that way: it needs a
 * permission the bot's least-privilege invite does not grant, and losing it must
 * never disturb the timer.
 */

class FakeStatusGateway implements VoiceStatusGateway {
  readonly writes: { channelId: string; text: string | null }[] = [];
  failure: Error | null = null;

  async set(channelId: string, text: string | null): Promise<void> {
    if (this.failure) throw this.failure;
    this.writes.push({ channelId, text });
  }
}

function missingPermissions(): DiscordAPIError {
  return new DiscordAPIError(
    { code: 50_013, message: "Missing Permissions" },
    50_013,
    403,
    "PUT",
    "/channels/x/voice-status",
    { files: [], body: {} },
  );
}

function setup(enabled = true) {
  const gateway = new FakeStatusGateway();
  const status = new VoiceStatus({ gateway, logger: silentLogger(), enabled });
  return { gateway, status };
}

describe("voice channel status", () => {
  it("writes the stage and the minutes left", async () => {
    const { gateway, status } = setup();

    await status.sync(newSession(), 1_760_000_000_000 + 13 * MINUTE);

    expect(gateway.writes).toEqual([
      { channelId: "222222222222222222", text: "\u{1F345} Focus - 12m left" },
    ]);
  });

  it("does not write again while the text is unchanged", async () => {
    // This is the rate limiting: the status only changes on a minute boundary,
    // so the 15-second refresh cadence costs one request a minute at most.
    const { gateway, status } = setup();
    const session = newSession();

    await status.sync(session, 1_760_000_000_000 + 13 * MINUTE);
    await status.sync(session, 1_760_000_000_000 + 13 * MINUTE + 5_000);
    await status.sync(session, 1_760_000_000_000 + 13 * MINUTE + 10_000);

    expect(gateway.writes).toHaveLength(1);
  });

  it("writes again once the minute rolls over", async () => {
    const { gateway, status } = setup();
    const session = newSession();

    await status.sync(session, 1_760_000_000_000);
    await status.sync(session, 1_760_000_000_000 + MINUTE);

    expect(gateway.writes.map((write) => write.text)).toEqual([
      "\u{1F345} Focus - 25m left",
      "\u{1F345} Focus - 24m left",
    ]);
  });

  it("clears the status when the session ends", async () => {
    const { gateway, status } = setup();
    const session = newSession();

    await status.sync(session, 1_760_000_000_000);
    await status.clear(session);

    expect(gateway.writes.at(-1)?.text).toBeNull();
  });

  it("does not clear a status it never wrote", async () => {
    const { gateway, status } = setup();

    await status.clear(newSession());

    expect(gateway.writes).toEqual([]);
  });
});

describe("voice channel status is opt-in", () => {
  it("writes nothing at all when disabled", async () => {
    const { gateway, status } = setup(false);

    await status.sync(newSession(), 1_760_000_000_000);
    await status.clear(newSession());

    expect(gateway.writes).toEqual([]);
    expect(status.isEnabled).toBe(false);
  });

  it("defaults to off, so an existing deployment is unaffected", () => {
    const config = loadConfig({
      DISCORD_TOKEN: "token",
      CLIENT_ID: "1549548366864584744",
    } as NodeJS.ProcessEnv);

    expect(config.voiceStatusEnabled).toBe(false);
  });

  it("accepts an explicit opt-in", () => {
    const config = loadConfig({
      DISCORD_TOKEN: "token",
      CLIENT_ID: "1549548366864584744",
      VOICE_STATUS_ENABLED: "true",
    } as NodeJS.ProcessEnv);

    expect(config.voiceStatusEnabled).toBe(true);
  });

  it("rejects a typo rather than silently reading it as off", () => {
    // "ture" reading as "off" is the kind of thing that costs an hour.
    expect(() =>
      loadConfig({
        DISCORD_TOKEN: "token",
        CLIENT_ID: "1549548366864584744",
        VOICE_STATUS_ENABLED: "ture",
      } as NodeJS.ProcessEnv),
    ).toThrow(/VOICE_STATUS_ENABLED/);
  });
});

describe("voice channel status degrades gracefully", () => {
  it("switches off for the guild when the permission is missing", async () => {
    const { gateway, status } = setup();
    gateway.failure = missingPermissions();

    const session = newSession();

    // Must not throw: the timer is unaffected by a missing optional permission.
    await expect(status.sync(session, 1_760_000_000_000)).resolves.toBeUndefined();

    // And it must not keep asking, or it would hammer a 403 every 15 seconds.
    gateway.failure = null;
    await status.sync(session, 1_760_000_000_000 + MINUTE);
    await status.sync(session, 1_760_000_000_000 + 2 * MINUTE);

    expect(gateway.writes).toEqual([]);
  });

  it("keeps retrying after a transient failure, since the status may still work", async () => {
    const { gateway, status } = setup();
    gateway.failure = new Error("temporary network problem");

    const session = newSession();
    await status.sync(session, 1_760_000_000_000);

    gateway.failure = null;
    await status.sync(session, 1_760_000_000_000 + MINUTE);

    expect(gateway.writes).toHaveLength(1);
  });

  it("never lets a failure escape into the session", async () => {
    const gateway: VoiceStatusGateway = {
      async set() {
        throw new Error("anything at all");
      },
    };
    const status = new VoiceStatus({ gateway, logger: silentLogger(), enabled: true });

    await expect(status.sync(newSession(), 1_760_000_000_000)).resolves.toBeUndefined();
    await expect(status.clear(newSession())).resolves.toBeUndefined();
  });
});

describe("voice channel status logging", () => {
  it("says the timer is unaffected when it stands down", async () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: "warn",
      sink: (line) => lines.push(String(line)),
    });
    const gateway = new FakeStatusGateway();
    gateway.failure = missingPermissions();
    const status = new VoiceStatus({ gateway, logger, enabled: true });

    await status.sync(newSession(), 1_760_000_000_000);

    expect(lines.some((line) => line.includes("timer is unaffected"))).toBe(true);
  });
});
