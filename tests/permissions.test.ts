import { PermissionFlagsBits } from "discord.js";
import { describe, expect, it } from "vitest";

import {
  canConfigureChannel,
  canConfigureGuild,
  canForceStop,
  hasAnyPermission,
} from "../src/discord/permissions";
import { isParticipant } from "../src/discord/voice";

const NONE = 0n;
const MANAGE_CHANNELS = PermissionFlagsBits.ManageChannels;
const MANAGE_GUILD = PermissionFlagsBits.ManageGuild;
const SEND_MESSAGES = PermissionFlagsBits.SendMessages;

describe("hasAnyPermission", () => {
  it("is true when the bitfield grants one of the required bits", () => {
    expect(hasAnyPermission(MANAGE_CHANNELS, [MANAGE_GUILD, MANAGE_CHANNELS])).toBe(true);
  });

  it("is false when none of the required bits are granted", () => {
    expect(hasAnyPermission(SEND_MESSAGES, [MANAGE_GUILD, MANAGE_CHANNELS])).toBe(false);
  });

  it("is false for an empty requirement list", () => {
    expect(hasAnyPermission(MANAGE_GUILD, [])).toBe(false);
  });

  it("ignores unrelated bits", () => {
    const combined = SEND_MESSAGES | MANAGE_GUILD;

    expect(hasAnyPermission(combined, [MANAGE_GUILD])).toBe(true);
    expect(hasAnyPermission(combined, [MANAGE_CHANNELS])).toBe(false);
  });
});

describe("canConfigureChannel", () => {
  it("allows Manage Channels or Manage Server", () => {
    expect(canConfigureChannel(MANAGE_CHANNELS)).toBe(true);
    expect(canConfigureChannel(MANAGE_GUILD)).toBe(true);
  });

  it("denies an ordinary member", () => {
    expect(canConfigureChannel(SEND_MESSAGES)).toBe(false);
    expect(canConfigureChannel(NONE)).toBe(false);
  });
});

describe("canConfigureGuild", () => {
  it("requires Manage Server specifically", () => {
    expect(canConfigureGuild(MANAGE_GUILD)).toBe(true);
    expect(canConfigureGuild(MANAGE_CHANNELS)).toBe(false);
  });
});

describe("canForceStop", () => {
  it("allows a moderator to stop a session they are not part of", () => {
    expect(canForceStop(MANAGE_CHANNELS)).toBe(true);
    expect(canForceStop(MANAGE_GUILD)).toBe(true);
  });

  it("denies an ordinary member", () => {
    expect(canForceStop(SEND_MESSAGES)).toBe(false);
  });
});

describe("isParticipant", () => {
  it("is true only when the caller is in the command's voice channel", () => {
    expect(isParticipant({ callerVoiceChannelId: "a", commandVoiceChannelId: "a" })).toBe(true);
  });

  it("is false when the caller is in a different voice channel", () => {
    expect(isParticipant({ callerVoiceChannelId: "a", commandVoiceChannelId: "b" })).toBe(false);
  });

  it("is false when the caller is not in any voice channel", () => {
    expect(isParticipant({ callerVoiceChannelId: null, commandVoiceChannelId: "a" })).toBe(false);
    expect(isParticipant({ callerVoiceChannelId: undefined, commandVoiceChannelId: "a" })).toBe(
      false,
    );
  });

  it("is false in a text channel, which has no session context", () => {
    expect(isParticipant({ callerVoiceChannelId: "a", commandVoiceChannelId: null })).toBe(false);
  });
});
