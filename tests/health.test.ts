import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createHealthReporter, HEALTH_FILENAME } from "../src/health";
import { createLogger } from "../src/logger";

/**
 * The heartbeat is what the deploy script polls to decide whether a release
 * succeeded, so its two critical properties are that it is written atomically
 * and that it reflects real state rather than "the process started".
 */

let workspace: string | null = null;

afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  workspace = null;
});

function silentLogger() {
  return createLogger({ level: "error", sink: () => {} });
}

function tempDir(): string {
  workspace = mkdtempSync(join(tmpdir(), "marzano-health-"));
  return workspace;
}

describe("snapshot", () => {
  it("writes a parseable snapshot to the data directory", () => {
    const directory = tempDir();
    const reporter = createHealthReporter({ directory, logger: silentLogger() });

    reporter.beat({ ready: true, commit: "abc123" });

    const written = JSON.parse(readFileSync(join(directory, HEALTH_FILENAME), "utf8"));
    expect(written.ready).toBe(true);
    expect(written.commit).toBe("abc123");
    expect(written.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(written.version).toBe("0.1.0");
    expect(written.node).toBe(process.versions.node);
  });

  it("leaves no temporary file behind", () => {
    const directory = tempDir();
    createHealthReporter({ directory, logger: silentLogger() }).beat();

    expect(existsSync(join(directory, `${HEALTH_FILENAME}.tmp`))).toBe(false);
  });

  it("is not ready before Discord is", () => {
    const directory = tempDir();
    const reporter = createHealthReporter({ directory, logger: silentLogger() });

    const snapshot = reporter.beat();

    expect(snapshot.ready).toBe(false);
    expect(snapshot.discord).toBe("connecting");
    expect(snapshot.database).toBe("ok");
  });

  it("defaults the commit to unknown rather than inventing one", () => {
    const directory = tempDir();
    const snapshot = createHealthReporter({ directory, logger: silentLogger() }).beat();

    expect(snapshot.commit).toBe("unknown");
  });
});

describe("failure handling", () => {
  it("logs and continues when the snapshot cannot be written", () => {
    // A heartbeat failure must never take the bot down. The deploy script will
    // time out and roll back, which is the correct outcome.
    const lines: string[] = [];
    const reporter = createHealthReporter({
      directory: "/nonexistent-directory-for-tests",
      logger: createLogger({ level: "warn", sink: (line) => void lines.push(line) }),
    });

    expect(() => reporter.beat()).not.toThrow();
    expect(lines.join("\n")).toContain("could not write the health snapshot");
  });
});

describe("heartbeat loop", () => {
  it("writes immediately on start, so a reload is not a blind wait", () => {
    const directory = tempDir();
    const reporter = createHealthReporter({ directory, logger: silentLogger() });

    reporter.start(() => ({ ready: true, commit: "immediate" }));
    reporter.stop();

    const written = JSON.parse(readFileSync(join(directory, HEALTH_FILENAME), "utf8"));
    expect(written.commit).toBe("immediate");
  });

  it("stops writing after stop", () => {
    const directory = tempDir();
    const reporter = createHealthReporter({
      directory,
      logger: silentLogger(),
      intervalMs: 5,
    });

    reporter.start(() => ({ commit: "first" }));
    reporter.stop();

    // A stopped reporter must not keep a timer alive.
    expect(existsSync(join(directory, HEALTH_FILENAME))).toBe(true);
  });

  it("carries through the collected state each beat", () => {
    const directory = tempDir();
    const reporter = createHealthReporter({ directory, logger: silentLogger() });

    const snapshot = reporter.beat({
      ready: true,
      discord: "ready",
      guilds: 3,
      activeSessions: 1,
    });

    expect(snapshot.guilds).toBe(3);
    expect(snapshot.activeSessions).toBe(1);
    expect(snapshot.discord).toBe("ready");
  });
});
