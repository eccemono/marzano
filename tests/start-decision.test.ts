import { describe, expect, it } from "vitest";

import { decideStart } from "../src/commands/start-decision";

const VOICE = "222222222222222222";
const OTHER_VOICE = "333333333333333333";

function base() {
  return {
    callerVoiceChannelId: VOICE,
    commandVoiceChannelId: VOICE,
    hasStoredConfig: true,
    splitInput: null,
    activeSessionVoiceChannelId: null,
  };
}

describe("decideStart", () => {
  it("starts with the stored configuration when the channel is configured", () => {
    expect(decideStart(base())).toEqual({ kind: "start", split: null });
  });

  it("rejects a caller who is not in the voice channel", () => {
    const decision = decideStart({ ...base(), callerVoiceChannelId: OTHER_VOICE });

    expect(decision).toMatchObject({ kind: "reject", reason: "not-in-channel" });
  });

  it("rejects a caller who is not in any voice channel", () => {
    const decision = decideStart({ ...base(), callerVoiceChannelId: null });

    expect(decision).toMatchObject({ kind: "reject", reason: "not-in-channel" });
  });

  it("rejects a command used in a text channel", () => {
    const decision = decideStart({ ...base(), commandVoiceChannelId: null });

    expect(decision).toMatchObject({ kind: "reject", reason: "not-in-channel" });
  });

  it("reports a session already running in the same channel", () => {
    const decision = decideStart({ ...base(), activeSessionVoiceChannelId: VOICE });

    expect(decision).toMatchObject({ kind: "reject", reason: "already-running" });
    expect((decision as { message: string }).message).toMatch(/already running in this channel/);
  });

  it("names the channel holding a session elsewhere in the guild", () => {
    const decision = decideStart({ ...base(), activeSessionVoiceChannelId: OTHER_VOICE });

    expect(decision).toMatchObject({ kind: "reject", reason: "already-running" });
    expect((decision as { message: string }).message).toContain(OTHER_VOICE);
  });

  it("starts with an explicit split even when the channel is unconfigured", () => {
    const decision = decideStart({ ...base(), hasStoredConfig: false, splitInput: "50 10 20" });

    expect(decision).toEqual({
      kind: "start",
      split: { focusMinutes: 50, shortBreakMinutes: 10, longBreakMinutes: 20 },
    });
  });

  it("opens setup when the channel is unconfigured and no split was given", () => {
    const decision = decideStart({ ...base(), hasStoredConfig: false });

    expect(decision).toMatchObject({ kind: "open-setup", reason: "unconfigured" });
  });

  it("opens setup with the parser message when the split is malformed", () => {
    const decision = decideStart({ ...base(), hasStoredConfig: false, splitInput: "nonsense" });

    expect(decision).toMatchObject({ kind: "open-setup", reason: "invalid-split" });
    expect((decision as { message: string }).message.length).toBeGreaterThan(0);
  });

  it("opens setup rather than dead-ending when a stored config exists but the split is bad", () => {
    const decision = decideStart({ ...base(), splitInput: "10 30 60" });

    expect(decision).toMatchObject({ kind: "open-setup", reason: "invalid-split" });
  });

  it("treats a whitespace-only split as absent", () => {
    expect(decideStart({ ...base(), splitInput: "   " })).toEqual({ kind: "start", split: null });
  });
});
