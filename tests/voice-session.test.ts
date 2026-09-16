import { describe, expect, it } from "vitest";

import { BUILT_IN_DEFAULTS } from "../src/domain/config";
import { createLogger } from "../src/logger";
import type { PlaybackResult, VoiceGateway } from "../src/voice/gateway";
import { SessionVoice, type VoiceSession } from "../src/voice/manager";
import { BELL, START_CUE, type SoundName } from "../src/voice/sounds";

const GUILD = "111111111111111111";
const GUILD_B = "444444444444444444";

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
  readonly connectedGuilds = new Set<string>();
  silenced = true;
  joinFails = false;
  playResult: PlaybackResult = { played: true };

  async join(guildId: string, channelId: string): Promise<void> {
    this.calls.push(`join:${guildId}:${channelId}`);
    if (this.joinFails) throw new Error("Missing Permissions");
    this.connectedGuilds.add(guildId);
  }

  leave(guildId: string): void {
    this.calls.push(`leave:${guildId}`);
    this.connectedGuilds.delete(guildId);
  }

  leaveAll(): void {
    this.calls.push("leaveAll");
    this.connectedGuilds.clear();
  }

  isConnected(guildId: string): boolean {
    return this.connectedGuilds.has(guildId);
  }

  async play(guildId: string, sound: SoundName, volumePercent: number): Promise<PlaybackResult> {
    this.calls.push(`play:${guildId}:${sound}:${volumePercent}`);
    return this.playResult;
  }

  async setSilenced(guildId: string, silenced: boolean): Promise<void> {
    this.calls.push(`silenced:${guildId}:${silenced}`);
    this.silenced = silenced;
  }

  /** Everything except join/leave/silence that touched playback. */
  get played(): string[] {
    return this.calls.filter((call) => call.startsWith("play:"));
  }

  /** Playback calls stripped of the guild, for single-guild assertions. */
  get playedSounds(): string[] {
    return this.played.map((call) => {
      const [, , sound, volume] = call.split(":");
      return `play:${sound}:${volume}`;
    });
  }
}

function newSession(overrides: Partial<VoiceSession> = {}): VoiceSession {
  return {
    guildId: GUILD,
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
      `join:${GUILD}:222222222222222222`,
      `silenced:${GUILD}:true`,
      `silenced:${GUILD}:false`,
      `play:${GUILD}:${START_CUE}:80`,
      `play:${GUILD}:${BELL}:80`,
      `silenced:${GUILD}:true`,
    ]);
  });

  it("leaves the bot silent once the cue has finished", async () => {
    const { gateway, voice } = setup();

    await voice.announceStart(newSession());

    expect(gateway.silenced).toBe(true);
  });

  it("re-silences even when playback throws, so the bot is never left audible", async () => {
    // The unmute happens before playback. If anything after it throws and the
    // silence is not restored in a finally path, the bot sits in the channel
    // unmuted and undeafened indefinitely.
    const { gateway, voice } = setup();
    gateway.playResult = { played: false, reason: "encoder blew up" };

    await voice.announceStart(newSession());

    expect(gateway.silenced).toBe(true);
    expect(gateway.calls.at(-1)).toBe(`silenced:${GUILD}:true`);
  });
});

describe("stage transitions", () => {
  it("plays the bell only, never the start cue", async () => {
    const { gateway, voice } = setup();
    const session = newSession();

    await voice.announceStart(session);
    gateway.calls.length = 0;

    await voice.announceTransition(session);

    expect(gateway.playedSounds).toEqual([`play:${BELL}:80`]);
    expect(gateway.playedSounds).not.toContain(`play:${START_CUE}:80`);
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

    expect(gateway.calls).toContain(`join:${GUILD}:333333333333333333`);
  });
});

describe("sound configuration", () => {
  it("joins but stays silent when sound is disabled", async () => {
    const { gateway, voice } = setup();

    await voice.announceStart(newSession({ config: { soundEnabled: false, soundVolume: 80 } }));

    expect(gateway.calls).toContain(`join:${GUILD}:222222222222222222`);
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

    expect(gateway.playedSounds).toEqual([`play:${START_CUE}:35`, `play:${BELL}:35`]);
  });

  it("only ever requests the generated cue sounds, never speech", async () => {
    const { gateway, voice } = setup();

    await voice.announceStart(newSession());
    await voice.announceTransition(newSession());

    for (const call of gateway.played) {
      const sound = call.split(":")[2];
      expect([START_CUE, BELL]).toContain(sound);
    }
  });
});

describe("per-guild isolation", () => {
  it("keeps a session in another guild joined when one guild leaves", async () => {
    const { gateway, voice } = setup();

    await voice.announceStart(newSession());
    await voice.announceStart(newSession({ guildId: GUILD_B }));

    await voice.leave(GUILD);

    expect(voice.channelId(GUILD)).toBeNull();
    expect(voice.channelId(GUILD_B)).toBe("222222222222222222");
    expect(gateway.isConnected(GUILD_B)).toBe(true);
  });

  it("never routes a cue to the wrong guild's connection", async () => {
    const { gateway, voice } = setup();

    await voice.announceStart(newSession({ guildId: GUILD_B }));
    gateway.calls.length = 0;

    await voice.announceTransition(newSession({ guildId: GUILD }));

    expect(gateway.calls).toContain(`join:${GUILD}:222222222222222222`);
    for (const call of gateway.played) {
      expect(call.startsWith(`play:${GUILD}:`)).toBe(true);
    }
  });

  it("leaves every guild on request", async () => {
    const { gateway, voice } = setup();

    await voice.announceStart(newSession());
    await voice.announceStart(newSession({ guildId: GUILD_B }));

    await voice.leaveAll();

    expect(voice.channelId(GUILD)).toBeNull();
    expect(voice.channelId(GUILD_B)).toBeNull();
    expect(gateway.calls).toContain("leaveAll");
  });
});

describe("resilience", () => {
  it("does not throw and never plays when the join fails", async () => {
    const { gateway, voice } = setup();
    gateway.joinFails = true;

    await expect(voice.announceStart(newSession())).resolves.toBeUndefined();

    expect(gateway.played).toEqual([]);
    expect(voice.channelId(GUILD)).toBeNull();
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

    await expect(voice.leave(GUILD)).resolves.toBeUndefined();
    expect(voice.channelId(GUILD)).toBeNull();
  });
});

describe("leave", () => {
  it("destroys the connection and forgets it", async () => {
    const { gateway, voice } = setup();

    await voice.announceStart(newSession());
    expect(voice.channelId(GUILD)).toBe("222222222222222222");

    await voice.leave(GUILD);

    expect(gateway.calls).toContain(`leave:${GUILD}`);
    expect(voice.channelId(GUILD)).toBeNull();
  });

  it("is safe to call when not connected", async () => {
    const { voice } = setup();

    await expect(voice.leave(GUILD)).resolves.toBeUndefined();
  });
});

describe("non-blocking", () => {
  it("does not settle while a cue is still playing, so callers can move on", async () => {
    // Call sites invoke announceStart with `void`, which is only safe because
    // playback is genuinely asynchronous: a stalled voice join must not hold up
    // the interaction reply or the timer.
    const gateway = new FakeGateway();
    const control: { finishJoin?: () => void } = {};
    gateway.join = async (guildId: string) => {
      await new Promise<void>((resolve) => {
        control.finishJoin = resolve;
      });
      gateway.connectedGuilds.add(guildId);
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
    await voice.leave(GUILD);

    // The gateway surface has no way to name another member; every call is
    // either about our own connection or our own mute/deafen state.
    for (const call of gateway.calls) {
      expect(call).toMatch(/^(join:|leave:|leaveAll$|play:|silenced:)/);
    }
  });
});
