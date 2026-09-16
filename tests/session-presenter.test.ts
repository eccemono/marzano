import { afterEach, describe, expect, it, vi } from "vitest";

import { BUILT_IN_DEFAULTS } from "../src/domain/config";
import { type TimerSession, startSession, terminate } from "../src/domain/timer";
import {
  DEFAULT_REFRESH_MS,
  SessionMessageMissingError,
  SessionPresenter,
  type SessionMessageGateway,
  type SessionPayload,
} from "../src/discord/session-presenter";
import { createLogger } from "../src/logger";

const T0 = 1_760_000_000_000;

function silentLogger() {
  return createLogger({ level: "error", sink: () => {} });
}

class FakeGateway implements SessionMessageGateway {
  posts: string[] = [];
  edits: { channelId: string; messageId: string }[] = [];
  behaviour: "ok" | "missing" | "transient" = "ok";
  private counter = 0;

  async post(channelId: string, _payload: SessionPayload): Promise<string> {
    this.counter += 1;
    const id = `msg-${this.counter}`;
    this.posts.push(channelId);
    return id;
  }

  async edit(channelId: string, messageId: string, _payload: SessionPayload): Promise<void> {
    this.edits.push({ channelId, messageId });
    if (this.behaviour === "missing") throw new SessionMessageMissingError();
    if (this.behaviour === "transient") throw new Error("temporarily unavailable");
  }
}

function newSession(overrides: Partial<TimerSession> = {}): TimerSession {
  return {
    ...startSession({
      guildId: "111111111111111111",
      voiceChannelId: "222222222222222222",
      textChannelId: "222222222222222222",
      config: BUILT_IN_DEFAULTS,
      now: T0,
    }),
    ...overrides,
  };
}

function presenter(gateway: FakeGateway, baseIntervalMs?: number): SessionPresenter {
  return new SessionPresenter({
    gateway,
    logger: silentLogger(),
    now: () => T0 + 60_000,
    ...(baseIntervalMs === undefined ? {} : { baseIntervalMs }),
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("render", () => {
  it("posts the status message when the session has none yet", async () => {
    const gateway = new FakeGateway();
    const result = await presenter(gateway).render(newSession());

    expect(result).toEqual({ messageId: "msg-1", replaced: false });
    expect(gateway.posts).toEqual(["222222222222222222"]);
    expect(gateway.edits).toHaveLength(0);
  });

  it("edits the existing message instead of posting again", async () => {
    const gateway = new FakeGateway();
    const result = await presenter(gateway).render(newSession({ statusMessageId: "existing" }));

    expect(result).toEqual({ messageId: "existing", replaced: false });
    expect(gateway.edits).toEqual([{ channelId: "222222222222222222", messageId: "existing" }]);
    expect(gateway.posts).toHaveLength(0);
  });

  it("posts a replacement when the status message was deleted", async () => {
    const gateway = new FakeGateway();
    gateway.behaviour = "missing";

    const result = await presenter(gateway).render(newSession({ statusMessageId: "deleted" }));

    expect(result).toEqual({ messageId: "msg-1", replaced: true });
    expect(gateway.posts).toHaveLength(1);
    expect(gateway.edits).toHaveLength(1);
  });

  it("does not post a duplicate when the edit succeeds", async () => {
    const gateway = new FakeGateway();
    const instance = presenter(gateway);
    const session = newSession({ statusMessageId: "existing" });

    await instance.render(session);
    await instance.render(session);
    await instance.render(session);

    expect(gateway.posts).toHaveLength(0);
    expect(gateway.edits).toHaveLength(3);
  });

  it("propagates a transient failure and counts it", async () => {
    const gateway = new FakeGateway();
    gateway.behaviour = "transient";
    const instance = presenter(gateway);

    await expect(instance.render(newSession({ statusMessageId: "existing" }))).rejects.toThrow(
      "temporarily unavailable",
    );
    expect(instance.failures).toBe(1);
  });

  it("resets the failure count after a success", async () => {
    const gateway = new FakeGateway();
    gateway.behaviour = "transient";
    const instance = presenter(gateway);

    await expect(instance.render(newSession({ statusMessageId: "m" }))).rejects.toThrow();
    expect(instance.failures).toBe(1);

    gateway.behaviour = "ok";
    await instance.render(newSession({ statusMessageId: "m" }));
    expect(instance.failures).toBe(0);
  });
});

describe("backoff", () => {
  it("uses the base interval with no failures", () => {
    const instance = presenter(new FakeGateway(), 1_000);

    expect(instance.nextDelayMs()).toBe(1_000);
  });

  it("doubles with each consecutive failure", async () => {
    const gateway = new FakeGateway();
    gateway.behaviour = "transient";
    const instance = presenter(gateway, 1_000);

    await expect(instance.render(newSession({ statusMessageId: "m" }))).rejects.toThrow();
    expect(instance.nextDelayMs()).toBe(2_000);

    await expect(instance.render(newSession({ statusMessageId: "m" }))).rejects.toThrow();
    expect(instance.nextDelayMs()).toBe(4_000);
  });

  it("caps the delay so a long outage does not stop refreshes entirely", async () => {
    const gateway = new FakeGateway();
    gateway.behaviour = "transient";
    const instance = new SessionPresenter({
      gateway,
      logger: silentLogger(),
      baseIntervalMs: 1_000,
      maxIntervalMs: 5_000,
    });

    for (let attempt = 0; attempt < 8; attempt += 1) {
      await expect(instance.render(newSession({ statusMessageId: "m" }))).rejects.toThrow();
    }

    expect(instance.nextDelayMs()).toBe(5_000);
  });

  it("defaults to roughly fifteen seconds", () => {
    expect(DEFAULT_REFRESH_MS).toBe(15_000);
    expect(presenter(new FakeGateway()).nextDelayMs()).toBe(DEFAULT_REFRESH_MS);
  });
});

describe("refresh loop", () => {
  it("re-renders on the configured interval", async () => {
    vi.useFakeTimers();
    const gateway = new FakeGateway();
    const instance = presenter(gateway, 1_000);
    const session = newSession({ statusMessageId: "m1" });

    instance.startLoop(
      () => session,
      () => {},
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(gateway.edits).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(gateway.edits).toHaveLength(2);

    instance.stopLoop();
  });

  it("stops itself once the session ends", async () => {
    vi.useFakeTimers();
    const gateway = new FakeGateway();
    const instance = presenter(gateway, 1_000);
    let session: TimerSession | null = newSession({ statusMessageId: "m1" });

    instance.startLoop(
      () => session,
      () => {},
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(gateway.edits).toHaveLength(1);

    session = terminate(session, "everyone left");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(gateway.edits).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(gateway.edits).toHaveLength(1);
  });

  it("keeps going after a failure and recovers", async () => {
    vi.useFakeTimers();
    const gateway = new FakeGateway();
    gateway.behaviour = "missing";
    const instance = presenter(gateway, 1_000);
    const session = newSession({ statusMessageId: "gone" });

    instance.startLoop(
      () => session,
      () => {},
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(gateway.posts).toHaveLength(1);

    instance.stopLoop();
  });

  it("does not schedule more work once stopped", async () => {
    vi.useFakeTimers();
    const gateway = new FakeGateway();
    const instance = presenter(gateway, 1_000);

    instance.startLoop(
      () => newSession({ statusMessageId: "m1" }),
      () => {},
    );

    await vi.advanceTimersByTimeAsync(1_000);
    instance.stopLoop();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(gateway.edits).toHaveLength(1);
  });
});
