import { PermissionFlagsBits } from "discord.js";
import { describe, expect, it } from "vitest";

import {
  SESSION_BUTTON_IDS,
  actionForButtonId,
  actionLabel,
  authorizeControl,
  cancelIdFor,
  confirmIdFor,
  parseConfirmationId,
  requiresConfirmation,
} from "../src/discord/session-controls";

const SESSION_VOICE = "222222222222222222";
const OTHER_VOICE = "333333333333333333";

const MEMBER_PERMISSIONS = PermissionFlagsBits.SendMessages;
const MODERATOR_PERMISSIONS = PermissionFlagsBits.ManageChannels;

function request(overrides: Partial<Parameters<typeof authorizeControl>[0]> = {}) {
  return {
    action: "pause" as const,
    callerVoiceChannelId: SESSION_VOICE,
    sessionVoiceChannelId: SESSION_VOICE,
    permissions: MEMBER_PERMISSIONS,
    ...overrides,
  };
}

describe("requiresConfirmation", () => {
  it("asks before discarding work in progress", () => {
    expect(requiresConfirmation("skip")).toBe(true);
    expect(requiresConfirmation("stop")).toBe(true);
  });

  it("does not ask for reversible actions", () => {
    expect(requiresConfirmation("pause")).toBe(false);
    expect(requiresConfirmation("resume")).toBe(false);
    expect(requiresConfirmation("extend")).toBe(false);
    expect(requiresConfirmation("toggle_sound")).toBe(false);
  });
});

describe("authorizeControl", () => {
  it("allows a participant to pause", () => {
    expect(authorizeControl(request())).toEqual({
      allowed: true,
      requiresConfirmation: false,
      reason: null,
    });
  });

  it("denies someone who is in a different voice channel", () => {
    const decision = authorizeControl(request({ callerVoiceChannelId: OTHER_VOICE }));

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/need to be in this voice channel/i);
  });

  it("denies someone who is not in any voice channel", () => {
    expect(authorizeControl(request({ callerVoiceChannelId: null })).allowed).toBe(false);
  });

  it("denies a moderator pausing a session they are not part of", () => {
    const decision = authorizeControl(
      request({ callerVoiceChannelId: OTHER_VOICE, permissions: MODERATOR_PERMISSIONS }),
    );

    expect(decision.allowed).toBe(false);
  });

  it("allows a moderator to force-stop a session they are not part of", () => {
    const decision = authorizeControl(
      request({
        action: "stop",
        callerVoiceChannelId: OTHER_VOICE,
        permissions: MODERATOR_PERMISSIONS,
        confirmed: true,
      }),
    );

    expect(decision.allowed).toBe(true);
  });

  it("still requires confirmation for an out-of-channel force-stop", () => {
    const decision = authorizeControl(
      request({
        action: "stop",
        callerVoiceChannelId: OTHER_VOICE,
        permissions: MODERATOR_PERMISSIONS,
      }),
    );

    expect(decision.allowed).toBe(false);
    expect(decision.requiresConfirmation).toBe(true);
  });

  it("holds a skip behind confirmation, then allows it once confirmed", () => {
    const asked = authorizeControl(request({ action: "skip" }));
    expect(asked.allowed).toBe(false);
    expect(asked.requiresConfirmation).toBe(true);

    const confirmed = authorizeControl(request({ action: "skip", confirmed: true }));
    expect(confirmed.allowed).toBe(true);
    expect(confirmed.requiresConfirmation).toBe(false);
  });

  it("does not let a non-participant satisfy confirmation into a skip", () => {
    const decision = authorizeControl(
      request({ action: "skip", callerVoiceChannelId: OTHER_VOICE, confirmed: true }),
    );

    expect(decision.allowed).toBe(false);
  });
});

describe("button id mapping", () => {
  it("maps every session button to an action", () => {
    expect(actionForButtonId(SESSION_BUTTON_IDS.pauseResume)).toBe("pause");
    expect(actionForButtonId(SESSION_BUTTON_IDS.skip)).toBe("skip");
    expect(actionForButtonId(SESSION_BUTTON_IDS.stop)).toBe("stop");
    expect(actionForButtonId(SESSION_BUTTON_IDS.modify)).toBe("modify");
    expect(actionForButtonId(SESSION_BUTTON_IDS.extend2)).toBe("extend");
    expect(actionForButtonId(SESSION_BUTTON_IDS.extend5)).toBe("extend");
    expect(actionForButtonId(SESSION_BUTTON_IDS.toggleSound)).toBe("toggle_sound");
  });

  it("ignores foreign button ids", () => {
    expect(actionForButtonId("marzano:something-else")).toBeNull();
  });

  it("keeps ids stable, so a restart still resolves them", () => {
    expect(SESSION_BUTTON_IDS.pauseResume).toBe("marzano:session:pause");
    expect(SESSION_BUTTON_IDS.stop).toBe("marzano:session:stop");
  });
});

describe("confirmation ids", () => {
  it("round-trips a confirmed action", () => {
    expect(parseConfirmationId(confirmIdFor("skip"))).toEqual({
      action: "skip",
      confirmed: true,
    });
    expect(parseConfirmationId(confirmIdFor("stop"))).toEqual({
      action: "stop",
      confirmed: true,
    });
  });

  it("round-trips a cancelled action", () => {
    expect(parseConfirmationId(cancelIdFor("stop"))).toEqual({
      action: "stop",
      confirmed: false,
    });
  });

  it("rejects a non-confirmable action", () => {
    expect(parseConfirmationId(confirmIdFor("pause"))).toBeNull();
    expect(parseConfirmationId(confirmIdFor("extend"))).toBeNull();
  });

  it("rejects foreign ids", () => {
    expect(parseConfirmationId("marzano:session:confirm:")).toBeNull();
    expect(parseConfirmationId("nonsense")).toBeNull();
  });
});

describe("actionLabel", () => {
  it("has a human label for every action", () => {
    for (const action of [
      "pause",
      "resume",
      "skip",
      "stop",
      "modify",
      "extend",
      "toggle_sound",
    ] as const) {
      expect(actionLabel(action).length).toBeGreaterThan(0);
    }
  });
});
