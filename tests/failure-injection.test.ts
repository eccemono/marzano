import { describe, expect, it } from "vitest";

import { openInMemoryDatabase } from "../src/db/database";
import { migrate } from "../src/db/migrations";
import { getActiveSession, saveActiveSession } from "../src/db/session-repository";
import { SessionMessageMissingError, SessionPresenter } from "../src/discord/session-presenter";
import { createLogger } from "../src/logger";
import { SessionSupervisor } from "../src/session/supervisor";
import type { SessionVoice } from "../src/voice/manager";
import {
  CHANNEL,
  GUILD,
  MINUTE,
  START,
  type FakePresenter,
  type FakeVoice,
  newSession,
  setup,
  silentLogger,
} from "./helpers/harness";

/**
 * Failure injection.
 *
 * Every one of these is something that happens in production and not in a happy
 * path test: the database goes away, someone deletes the status message, the
 * channel is removed, permissions are revoked mid-session.
 *
 * The bar is the same in all cases: the failure must not take the process down,
 * the session must survive where it reasonably can, and the operator must be
 * able to see what happened.
 */

function capture() {
  const lines: string[] = [];
  return {
    lines,
    logger: createLogger({ level: "debug", sink: (line) => void lines.push(line) }),
  };
}

/** A presenter wired to a real SessionPresenter whose gateway misbehaves. */
function presenterWithGateway(behaviour: { edit: "missing" | "ok"; postId: string }) {
  const posts: string[] = [];
  const presenter = new SessionPresenter({
    gateway: {
      async post() {
        posts.push(behaviour.postId);
        return behaviour.postId;
      },
      async edit() {
        if (behaviour.edit === "missing") throw new SessionMessageMissingError();
      },
    },
    logger: silentLogger(),
    now: () => START,
  });
  return { presenter, posts };
}

describe("database write failure", () => {
  it("does not crash the process when a scheduled wake cannot persist", async () => {
    const { db, supervisor, timers } = setup();
    await supervisor.begin(newSession());

    // The connection goes away underneath us.
    db.close();

    // A scheduled wake has no caller to return an error to, which is exactly
    // the case that would otherwise become an unhandled rejection.
    await expect(timers.advanceBy(FOCUS)).resolves.toBeUndefined();
  });

  it("reports the failure instead of swallowing it", async () => {
    const { lines, logger } = capture();
    const db = openInMemoryDatabase();
    migrate(db);

    const callbacks: (() => void)[] = [];
    const supervisor = new SessionSupervisor({
      db,
      voice: fakeVoice() as unknown as SessionVoice,
      presenter: fakePresenter() as never,
      audience: fakeAudience() as never,
      logger,
      now: () => START,
      schedule: (_delayMs, fn) => {
        callbacks.push(fn);
        return { cancel: () => {} };
      },
    });

    await supervisor.begin(newSession());
    db.close();

    // Fire the scheduled wake by hand: this is the path with no caller to
    // return an error to, so the supervisor itself has to report it.
    for (const callback of callbacks) callback();
    await new Promise((resolve) => setImmediate(resolve));

    expect(lines.some((line) => line.includes("session wake failed"))).toBe(true);
  });
});

describe("deleted status message", () => {
  it("posts a replacement during recovery and still resumes the session", async () => {
    const db = openInMemoryDatabase();
    migrate(db);

    const { presenter, posts } = presenterWithGateway({ edit: "missing", postId: "fresh-message" });
    const voice = fakeVoice();

    const supervisor = new SessionSupervisor({
      db,
      voice: voice as unknown as SessionVoice,
      presenter,
      audience: fakeAudience() as never,
      logger: silentLogger(),
      now: () => START + 5 * MINUTE,
      schedule: () => ({ cancel: () => {} }),
    });

    saveActiveSession(db, { ...newSession(), statusMessageId: "deleted-message" });

    const report = await supervisor.recover();

    expect(report.resumed).toBe(1);
    // The old message was gone, so a replacement was posted and recorded.
    expect(posts).toEqual(["fresh-message"]);
    expect(getActiveSession(db, GUILD)?.statusMessageId).toBe("fresh-message");
    expect(voice.joins).toEqual([CHANNEL]);
  });
});

describe("deleted voice channel", () => {
  it("stops the session and releases the guild", async () => {
    const { db, audience, supervisor, voice } = setup();
    saveActiveSession(db, newSession());
    audience.exists = false;

    const report = await supervisor.recover();

    expect(report.unrecoverable).toBe(1);
    expect(getActiveSession(db, GUILD)).toBeNull();
    expect(voice.leaves).toBe(1);
  });
});

describe("revoked permissions", () => {
  it("keeps the session running when the bot cannot join", async () => {
    const { db, supervisor, voice } = setup();
    voice.joinError = "Missing Permissions";

    await supervisor.begin(newSession());
    await expect(supervisor.wake(GUILD, { announce: true })).resolves.toBeDefined();

    expect(getActiveSession(db, GUILD)).not.toBeNull();
  });

  it("keeps the session running when the bell cannot be played", async () => {
    const { db, supervisor, timers, voice } = setup();
    await supervisor.begin(newSession());
    voice.announceTransition = async () => {
      throw new Error("The voice connection is destroyed");
    };

    await expect(timers.advanceBy(25 * MINUTE)).resolves.toBeUndefined();

    expect(getActiveSession(db, GUILD)?.stage).toBe("short_break");
  });
});

describe("voice disconnect", () => {
  it("does not stop the timer while the bot cannot reach the channel", async () => {
    const { db, supervisor, timers, voice } = setup();
    await supervisor.begin(newSession());

    voice.joinError = "The voice connection is destroyed";

    // Two more stages pass while the bot cannot get back in.
    await timers.advanceBy(25 * MINUTE);
    await timers.advanceBy(5 * MINUTE);

    const session = getActiveSession(db, GUILD);
    expect(session?.stage).toBe("focus");
    expect(session?.completedFocusStages).toBe(1);
  });
});

// Local minimal fakes for the supervisor tests that need a plain presenter.
function fakeVoice(): FakeVoice {
  const joins: string[] = [];
  let leaves = 0;
  return {
    joins,
    get leaves() {
      return leaves;
    },
    startCues: 0,
    transitions: 0,
    joinError: null,
    async join(session: { voiceChannelId: string }) {
      joins.push(session.voiceChannelId);
      return true;
    },
    async leave() {
      leaves += 1;
    },
    async announceStart() {},
    async announceTransition() {},
  } as unknown as FakeVoice;
}

function fakePresenter(): FakePresenter {
  return {
    renders: [],
    nextMessageId: "message-1",
    async render(session: { statusMessageId: string | null }) {
      return { messageId: session.statusMessageId ?? "message-1", replaced: false };
    },
  } as unknown as FakePresenter;
}

function fakeAudience() {
  return {
    async channelExists() {
      return true;
    },
    async humanMembers() {
      return ["user-1"];
    },
  };
}

const FOCUS = 25 * MINUTE;
