import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The PM2 definition is loaded by PM2 itself rather than imported by the app,
 * so nothing else would catch a regression here. These assertions are the ones
 * that matter operationally: one app, and timeouts that do not cut a graceful
 * shutdown short.
 */

interface Pm2App {
  name: string;
  exec_mode: string;
  instances: number;
  autorestart: boolean;
  max_restarts: number;
  min_uptime: string;
  exp_backoff_restart_delay: number;
  kill_timeout: number;
  interpreter: string;
  cwd: string;
  env: Record<string, string>;
}

const CONFIG_PATH = join(__dirname, "..", "ecosystem.config.cjs");

function loadConfig(overrides: Record<string, string> = {}): { apps: Pm2App[] } {
  const saved = { ...process.env };

  // The resolver throws without a Node 22 interpreter, which is the point of
  // it - so give it one rather than weakening the check.
  process.env.NODE22_BIN = process.execPath;
  Object.assign(process.env, overrides);

  try {
    // Re-load every time: the config reads the environment when it is required.
    delete require.cache[require.resolve(CONFIG_PATH)];
    return require(CONFIG_PATH) as { apps: Pm2App[] };
  } finally {
    process.env = saved;
  }
}

/** The single app, asserted rather than non-null-asserted. */
function firstApp(overrides: Record<string, string> = {}): Pm2App {
  const apps = loadConfig(overrides).apps;
  const app = apps[0];

  if (!app) throw new Error("ecosystem.config.cjs defines no apps");

  return app;
}

describe("pm2 definition", () => {
  it("defines exactly one app, named marzano", () => {
    const config = loadConfig();

    expect(config.apps).toHaveLength(1);
    expect(config.apps[0]?.name).toBe("marzano");
  });

  it("runs as a single forked process", () => {
    // The Discord gateway holds a long-lived WebSocket and voice state; neither
    // survives a cluster fork.
    const app = firstApp();

    expect(app.exec_mode).toBe("fork");
    expect(app.instances).toBe(1);
  });

  it("gives a kill timeout longer than the app's own shutdown bound", () => {
    // If PM2 kills the process first, it vanishes from Discord without leaving
    // its voice channel cleanly.
    const app = firstApp();

    expect(app.kill_timeout).toBe(10_000);
    expect(app.kill_timeout).toBeGreaterThan(5_000);
  });

  it("backs off rather than hammering the Discord API in a crash loop", () => {
    const app = firstApp();

    expect(app.autorestart).toBe(true);
    expect(app.max_restarts).toBeGreaterThan(0);
    expect(app.max_restarts).toBeLessThanOrEqual(20);
    expect(app.exp_backoff_restart_delay).toBeGreaterThan(0);
    expect(app.min_uptime).toBe("20s");
  });

  it("reports the deployed commit rather than the literal string unknown", () => {
    const app = firstApp({ GIT_COMMIT: "deadbeef" });

    expect(app.env.GIT_COMMIT).toBe("deadbeef");
  });

  it("falls back to the checkout revision when GIT_COMMIT is not supplied", () => {
    // This is the case that matters: a plain `pm2 reload` still reports what is
    // actually deployed, rather than "unknown".
    const app = firstApp({ MARZANO_APP_DIR: join(__dirname, "..") });

    expect(app.env.GIT_COMMIT).toMatch(/^[0-9a-f]{40}$/);
  });

  it("reports unknown only when the revision genuinely cannot be read", () => {
    const app = firstApp({ MARZANO_APP_DIR: "/nonexistent-checkout" });

    expect(app.env.GIT_COMMIT).toBe("unknown");
  });

  it("points at the app directory and its sound assets", () => {
    const app = firstApp({ MARZANO_APP_DIR: "/opt/marzano" });

    expect(app.cwd).toBe("/opt/marzano");
    expect(app.env.SOUNDS_DIR).toBe("/opt/marzano/assets/sounds");
  });
});
