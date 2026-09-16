import { describe, expect, it } from "vitest";

import { BUILT_IN_DEFAULTS } from "../src/domain/config";
import { createLogger } from "../src/logger";
import type { PlaybackResult, VoiceGateway } from "../src/voice/gateway";
import { SessionVoice, type VoiceSession } from "../src/voice/manager";
import { BELL, START_CUE, type SoundName } from "../src/voice/sounds";

function silentLogger() {
  return createLogger({ level: "error", sink: () => {} });
}

/**
 * A voice gateway that records what it was asked to do.
 *
 * This is the whole point of the gateway boundary: the orchestration rules -
 * join once, unmute only to play, bell-only on transitions, never fail the
 * session - are asserted here without a Discord connection.
 */
class FakeGateway implements VoiceGateway {
  readonly calls: string[] = [];
  connected = false;
  silenced = true;
  joinFails = false;
  playResult: PlaybackResult = { played: true };

  async join(guildId: string, channelId: string): Promise<void> {
    this.calls.push(`join:${guildId}:${channelId}`);
    if (this.joinFails) throw new Error("Missing Permissions");
    this.connected = true;
  }

  leave(): void {
    this.calls.push("leave");
    this.connected = false;
  }

  async play(sound: SoundName, volumePercent: number): Promise<PlaybackResult> {
    this.calls.push(`play:${sound}:${volumePercent}`);
    return this.playResult;
  }

  async setSilenced(silenced: boolean): Promise<void> {
    this.calls.push(`silenced:${silenced}`);
    this.silenced = silenced;
  }

  /** Everything except join/leave/silence that touched playback. */
  get played(): string[] {
    return this.calls.filter((call) => call.startsWith("play:"));
  }
}

function newSession(overrides: Partial<VoiceSession> = {}): VoiceSession {
  return {
    guildId: "111111111111111111",
    voiceChannelId: "222222222222222222",
    config: { soundEnabled: true, soundVolume: BUILT_IN_DEFAULTS.soundVolume },
    ...overrides,
  };
}

function setup() {
  const gateway = new FakeGateway();
  const voice = new SessionVoice({ gateway, logger: silentLogger() });
  return { gateway, voice };
}

describe("session start", () => {
  it("joins, unmutes, plays the cue then the bell, and goes quiet again", async () => {
    const { gateway, voice } = setup();

    await voice.announceStart(newSession());

    expect(gateway.calls).toEqual([
      "join:111111111111111111:222222222222222222",
      "silenced:true",
      "silenced:false",
      `play:${START_CUE}:80`,
      `play:${BELL}:80`,
      "silenced:true",
    ]);
  });

  it("leaves the bot silent once the cue has finished", async () => {
    const { gateway, voice } = setup();

    await voice.announceStart(newSession());

    expect(gateway.silenced).toBe(true);
  });
});

describe("stage transitions", () => {
  it("plays the bell only, never the start cue", async () => {
    const { gateway, voice } = setup();
    const session = newSession();

    await voice.announceStart(session);
    gateway.calls.length = 0;

    await voice.announceTransition(session);

    expect(gateway.played).toEqual([`play:${BELL}:80`]);
    expect(gateway.played).not.toContain(`play:${START_CUE}:80`);
  });

  it("reuses the existing connection instead of rejoining", async () => {
    const { gateway, voice } = setup();
    const session = newSession();

    await voice.announceStart(session);
    gateway.calls.length = 0;

    await voice.announceTransition(session);

    expect(gateway.calls.filter((call) => call.startsWith("join:"))).toEqual([]);
  });

  it("rejoins when the session has moved to another channel", async () => {
    const { gateway, voice } = setup();

    await voice.announceStart(newSession());
    gateway.calls.length = 0;

    await voice.announceTransition(newSession({ voiceChannelId: "333333333333333333" }));

    expect(gateway.calls).toContain("join:111111111111111111:333333333333333333");
  });
});

describe("sound configuration", () => {
  it("joins but stays silent when sound is disabled", async () => {
    const { gateway, voice } = setup();

    await voice.announceStart(newSession({ config: { soundEnabled: false, soundVolume: 80 } }));

    expect(gateway.calls).toContain("join:111111111111111111:222222222222222222");
    expect(gateway.played).toEqual([]);
    expect(gateway.silenced).toBe(true);
  });

  it("stays silent at zero volume", async () => {
    const { gateway, voice } = setup();

    await voice.announceTransition(newSession({ config: { soundEnabled: true, soundVolume: 0 } }));

    expect(gateway.played).toEqual([]);
  });

  it("passes the configured volume through to playback", async () => {
    const { gateway, voice } = setup();

    await voice.announceStart(newSession({ config: { soundEnabled: true, soundVolume: 35 } }));

    expect(gateway.played).toEqual([`play:${START_CUE}:35`, `play:${BELL}:35`]);
  });

  it("only ever requests the generated cue sounds, never speech", async () => {
    const { gateway, voice } = setup();

    await voice.announceStart(newSession());
    await voice.announceTransition(newSession());

    for (const call of gateway.played) {
      const sound = call.split(":")[1];
      expect([START_CUE, BELL]).toContain(sound);
    }
  });
});

describe("resilience", () => {
  it("does not throw and never plays when the join fails", async () => {
    const { gateway, voice } = setup();
    gateway.joinFails = true;

    await expect(voice.announceStart(newSession())).resolves.toBeUndefined();

    expect(gateway.played).toEqual([]);
    expect(voice.channelId).toBeNull();
  });

  it("reports a failed join to the caller", async () => {
    const { gateway, voice } = setup();
    gateway.joinFails = true;

    await expect(voice.join(newSession())).resolves.toBe(false);
  });

  it("continues and re-silences when playback fails", async () => {
    const { gateway, voice } = setup();
    gateway.playResult = { played: false, reason: "unsupported encoder" };

    await expect(voice.announceStart(newSession())).resolves.toBeUndefined();

    expect(gateway.played).toHaveLength(2);
    expect(gateway.silenced).toBe(true);
  });

  it("survives a gateway that throws from play, contrary to its contract", async () => {
    const gateway = new FakeGateway();
    gateway.play = async () => {
      throw new Error("unexpected");
    };
    const voice = new SessionVoice({ gateway, logger: silentLogger() });

    await expect(voice.announceStart(newSession())).resolves.toBeUndefined();
    expect(gateway.silenced).toBe(true);
  });

  it("survives a failed voice-state change", async () => {
    const gateway = new FakeGateway();
    gateway.setSilenced = async () => {
      throw new Error("voice state unavailable");
    };
    const voice = new SessionVoice({ gateway, logger: silentLogger() });

    await expect(voice.announceStart(newSession())).resolves.toBeUndefined();
  });

  it("leaves cleanly even if the gateway throws on leave", async () => {
    const gateway = new FakeGateway();
    const voice = new SessionVoice({ gateway, logger: silentLogger() });

    await voice.announceStart(newSession());
    gateway.leave = () => {
      throw new Error("already gone");
    };

    await expect(voice.leave()).resolves.toBeUndefined();
    expect(voice.channelId).toBeNull();
  });
});

describe("leave", () => {
  it("destroys the connection and forgets it", async () => {
    const { gateway, voice } = setup();

    await voice.announceStart(newSession());
    expect(voice.channelId).toBe("222222222222222222");

    await voice.leave();

    expect(gateway.calls).toContain("leave");
    expect(voice.channelId).toBeNull();
  });

  it("is safe to call when not connected", async () => {
    const { voice } = setup();

    await expect(voice.leave()).resolves.toBeUndefined();
  });
});

describe("non-blocking", () => {
  it("does not settle while a cue is still playing, so callers can move on", async () => {
    // Call sites invoke announceStart with `void`, which is only safe because
    // playback is genuinely asynchronous: a stalled voice join must not hold up
    // the interaction reply or the timer.
    const gateway = new FakeGateway();
    const control: { finishJoin?: () => void } = {};
    gateway.join = async () => {
      await new Promise<void>((resolve) => {
        control.finishJoin = resolve;
      });
      gateway.connected = true;
    };

    const voice = new SessionVoice({ gateway, logger: silentLogger() });
    let settled = false;
    const pending = voice.announceStart(newSession()).then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    control.finishJoin?.();
    await pending;
    expect(settled).toBe(true);
  });
});

describe("own voice state only", () => {
  it("never issues a command that would affect another member", async () => {
    const { gateway, voice } = setup();

    await voice.announceStart(newSession());
    await voice.announceTransition(newSession());
    await voice.leave();

    // The gateway surface has no way to name another member; every call is
    // either about our own connection or our own mute/deafen state.
    for (const call of gateway.calls) {
      expect(call).toMatch(/^(join:|leave$|play:|silenced:)/);
    }
  });
});
