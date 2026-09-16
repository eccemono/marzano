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
import { EXTEND_BUTTON_MS, buildModifyComponents } from "../src/discord/session-components";

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
  it("never asks, including before a stop", () => {
    // Stop used to ask "are you sure?" first. It no longer does: the click is
    // the decision, and an extra tap on the button someone just committed to is
    // friction for nothing.
    expect(requiresConfirmation("stop")).toBe(false);
    expect(requiresConfirmation("skip")).toBe(false);
  });

  it("does not ask for reversible actions", () => {
    expect(requiresConfirmation("pause")).toBe(false);
    expect(requiresConfirmation("resume")).toBe(false);
    expect(requiresConfirmation("extend")).toBe(false);
    expect(requiresConfirmation("change_split")).toBe(false);
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

  it("lets a moderator force-stop a session they are not part of, with no prompt", () => {
    const decision = authorizeControl(
      request({
        action: "stop",
        callerVoiceChannelId: OTHER_VOICE,
        permissions: MODERATOR_PERMISSIONS,
      }),
    );

    expect(decision.allowed).toBe(true);
    expect(decision.requiresConfirmation).toBe(false);
  });

  it("allows a skip immediately, without a confirmation step", () => {
    const decision = authorizeControl(request({ action: "skip" }));

    expect(decision.allowed).toBe(true);
    expect(decision.requiresConfirmation).toBe(false);
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
    expect(actionForButtonId(SESSION_BUTTON_IDS.changeSplit)).toBe("change_split");
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
  it("has nothing to confirm any more", () => {
    expect(parseConfirmationId(confirmIdFor("stop"))).toBeNull();
    expect(parseConfirmationId(cancelIdFor("stop"))).toBeNull();
    expect(parseConfirmationId(confirmIdFor("skip"))).toBeNull();
    expect(parseConfirmationId(confirmIdFor("pause"))).toBeNull();
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
      "change_split",
      "toggle_sound",
    ] as const) {
      expect(actionLabel(action).length).toBeGreaterThan(0);
    }
  });
});

describe("modify menu", () => {
  it("offers the extend buttons, a split change, a sound toggle and a cancel", () => {
    const rows = buildModifyComponents();
    const ids = rows.flatMap((row) =>
      row.components.map((component) => (component.data as { custom_id?: string }).custom_id),
    );

    expect(ids).toEqual([
      SESSION_BUTTON_IDS.extend2,
      SESSION_BUTTON_IDS.extend5,
      SESSION_BUTTON_IDS.changeSplit,
      SESSION_BUTTON_IDS.toggleSound,
      SESSION_BUTTON_IDS.modifyCancel,
    ]);
  });

  it("leaves the cancel out of the action map, so it can only dismiss the panel", () => {
    // The cancel is not a session action: mapping it would make a stray click
    // able to change the session.
    expect(actionForButtonId(SESSION_BUTTON_IDS.modifyCancel)).toBeNull();
  });

  it("maps the extend buttons to two and five minutes", () => {
    expect(EXTEND_BUTTON_MS[SESSION_BUTTON_IDS.extend2]).toBe(2 * 60_000);
    expect(EXTEND_BUTTON_MS[SESSION_BUTTON_IDS.extend5]).toBe(5 * 60_000);
  });
});
