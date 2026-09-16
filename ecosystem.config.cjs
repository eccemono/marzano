/**
 * PM2 process definition for Marzano.
 *
 * Loaded by the deploy script as `pm2 startOrReload ecosystem.config.cjs
 * --only marzano`. The `--only marzano` is not optional: PM2 will otherwise
 * happily act on every app in its list, and this host runs other services.
 *
 * CommonJS (.cjs) because PM2 loads this file with `require`, and the package
 * has no "type" field - a `.js` file would work today but would break the
 * moment the project moves to ESM.
 */

const { execFileSync } = require("node:child_process");
const { existsSync, readdirSync } = require("node:fs");
const { join } = require("node:path");

const NODE_ROOT = "/usr/local/lib/nodejs";

/**
 * Locate a Node 22 interpreter.
 *
 * The host's system Node is 24.x, which aborts the process inside native SQLite
 * bindings (nodejs/node#65446). Falling back to it would produce an
 * intermittent SIGABRT that looks like a random crash, so this refuses to
 * resolve at all rather than silently picking the wrong runtime.
 */
function resolveNode22(root = NODE_ROOT) {
  if (!existsSync(root)) {
    throw new Error(
      `Cannot find ${root}. Marzano must run on Node 22; refusing to fall back to the system node.`,
    );
  }

  const candidates = readdirSync(root)
    .filter((entry) => /^node-v22\./.test(entry))
    .sort()
    .reverse();

  for (const candidate of candidates) {
    const binary = join(root, candidate, "bin", "node");
    if (existsSync(binary)) return binary;
  }

  throw new Error(
    `No Node 22 interpreter under ${root} (found: ${readdirSync(root).join(", ") || "nothing"}). ` +
      "Install one or set NODE22_BIN. Refusing to fall back to the system node.",
  );
}

const interpreter = process.env.NODE22_BIN || resolveNode22();

/**
 * The revision that is actually deployed.
 *
 * Read from the checkout at load time, so the answer is right for a plain
 * `pm2 reload` as well as for the deploy script (which also sets GIT_COMMIT in
 * the environment). Without this a manual restart reports "unknown" and the
 * health snapshot stops being able to tell you what is running.
 */
function resolveCommit(appDir) {
  if (process.env.GIT_COMMIT) return process.env.GIT_COMMIT;

  try {
    return execFileSync("git", ["-C", appDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

const APP_DIR = process.env.MARZANO_APP_DIR || "/opt/marzano";
const DATA_DIR = process.env.MARZANO_DATA_DIR || "/srv/marzano";

module.exports = {
  apps: [
    {
      name: "marzano",
      cwd: APP_DIR,
      script: "dist/index.js",

      // Node 22, never the system node.
      interpreter,
      interpreter_args: "",

      // Discord gateway clients hold a persistent WebSocket and long-lived
      // voice state, neither of which survives a cluster fork. One process.
      exec_mode: "fork",
      instances: 1,

      autorestart: true,
      max_restarts: 10,
      // Constrained by the deploy gate; see docs/OPERATIONS.md.
      min_uptime: "20s",
      restart_delay: 1000,
      // Exponential backoff between restart attempts, so a crash loop backs
      // off instead of hammering the Discord API and tripping rate limits.
      exp_backoff_restart_delay: 200,

      // Must exceed the app's own SHUTDOWN_TIMEOUT_MS (default 5000) or the
      // process is killed mid-shutdown and vanishes from voice uncleanly.
      kill_timeout: 10000,

      wait_ready: false,

      env: {
        NODE_ENV: "production",
        DATA_DIR,
        SOUNDS_DIR: join(APP_DIR, "assets", "sounds"),
        GIT_COMMIT: resolveCommit(APP_DIR),
      },

      // Keep logs bounded on a host with limited disk.
      max_memory_restart: "300M",
      merge_logs: true,
      time: true,
    },
  ],
};
