import { describe, expect, it } from "vitest";

import { GuildSerializer } from "../src/domain/serializer";
import { type TimerSession, type Transition, pause, skip, startSession } from "../src/domain/timer";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const T0 = 1_760_000_000_000;
const MINUTE = 60_000;

function newSession(): TimerSession {
  return startSession({
    guildId: "111111111111111111",
    voiceChannelId: "222222222222222222",
    config: {
      focusMinutes: 25,
      shortBreakMinutes: 5,
      longBreakMinutes: 15,
      cyclesBeforeLongBreak: 4,
      soundEnabled: true,
      soundVolume: 80,
    },
    now: T0,
  });
}

describe("GuildSerializer", () => {
  it("runs work for the same guild strictly in order", async () => {
    const serializer = new GuildSerializer();
    const order: string[] = [];

    const first = serializer.run("guild", async () => {
      order.push("first:start");
      await delay(20);
      order.push("first:end");
      return "first";
    });

    const second = serializer.run("guild", async () => {
      order.push("second:start");
      order.push("second:end");
      return "second";
    });

    expect(await Promise.all([first, second])).toEqual(["first", "second"]);
    expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  it("keeps different guilds concurrent", async () => {
    const serializer = new GuildSerializer();
    const order: string[] = [];

    const alpha = serializer.run("alpha", async () => {
      order.push("alpha:start");
      await delay(20);
      return "alpha";
    });

    const beta = serializer.run("beta", async () => {
      order.push("beta:start");
      return "beta";
    });

    await Promise.all([alpha, beta]);

    // Beta is not queued behind alpha, so it starts before alpha finishes.
    expect(order).toEqual(["alpha:start", "beta:start"]);
  });

  it("prevents lost updates in read-modify-write cycles", async () => {
    const serializer = new GuildSerializer();
    let counter = 0;

    // Mirrors how session transitions work: read the current state, do
    // something async, then write it back. Unserialised this loses updates.
    const bump = (): Promise<void> =>
      serializer.run("guild", async () => {
        const current = counter;
        await delay(5);
        counter = current + 1;
      });

    await Promise.all([bump(), bump(), bump(), bump(), bump()]);

    expect(counter).toBe(5);
  });

  it("serialises a simultaneous pause and skip into one ordered outcome", async () => {
    const serializer = new GuildSerializer();
    let session = newSession();
    const transitions: Transition[] = [];

    const applyPause = (): Promise<void> =>
      serializer.run(session.guildId, async () => {
        session = pause(session, T0 + MINUTE);
      });

    const applySkip = (): Promise<void> =>
      serializer.run(session.guildId, async () => {
        const result = skip(session, T0 + 2 * MINUTE);
        session = result.session;
        if (result.transition) transitions.push(result.transition);
      });

    await Promise.all([applyPause(), applySkip()]);

    // Exactly one stage change happened even though both actions were in
    // flight, and the session is left in a coherent running state.
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ from: "focus", to: "short_break" });
    expect(session.state).toBe("running");
    expect(session.pausedRemainingMs).toBeNull();
    expect(session.stage).toBe("short_break");
  });

  it("returns each task's own result", async () => {
    const serializer = new GuildSerializer();

    await expect(serializer.run("guild", () => 42)).resolves.toBe(42);
    await expect(serializer.run("guild", async () => "value")).resolves.toBe("value");
  });

  it("surfaces a task failure without poisoning the chain", async () => {
    const serializer = new GuildSerializer();

    await expect(
      serializer.run("guild", () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await expect(serializer.run("guild", () => "still working")).resolves.toBe("still working");
  });

  it("prunes guild entries once their work has settled", async () => {
    const serializer = new GuildSerializer();

    await serializer.run("guild", () => "done");
    await serializer.drain();

    expect(serializer.size).toBe(0);
  });

  it("drains every guild", async () => {
    const serializer = new GuildSerializer();
    let completed = 0;

    serializer.run("alpha", async () => {
      await delay(5);
      completed += 1;
    });
    serializer.run("beta", async () => {
      await delay(10);
      completed += 1;
    });

    await serializer.drain();

    expect(completed).toBe(2);
  });
});
