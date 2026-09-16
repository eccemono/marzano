/**
 * The health heartbeat.
 *
 * Written to a file rather than served over a port. Two reasons:
 *
 *   1. The deploy script already runs on the host, so it can read a file
 *      directly. A loopback endpoint would add an open socket and a firewall
 *      question for no benefit.
 *   2. A file survives the process. If the bot dies, the last snapshot stays on
 *      disk with its timestamp, which is exactly what you want to read
 *      afterwards - an endpoint would simply stop answering and tell you
 *      nothing.
 *
 * The write is atomic (temp file plus rename) so a reader can never observe a
 * half-written snapshot.
 */

import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Logger } from "./logger";
import { VERSION } from "./runtime";

export type DiscordState = "ready" | "connecting" | "disconnected";
export type DatabaseState = "ok" | "error";

export interface HealthSnapshot {
  /** True once the bot is logged in and has finished recovery. */
  ready: boolean;
  version: string;
  /** The deployed revision, supplied by the deploy script. */
  commit: string;
  node: string;
  database: DatabaseState;
  discord: DiscordState;
  guilds: number;
  activeSessions: number;
  uptimeSeconds: number;
  timestamp: string;
}

export interface HealthReporterOptions {
  /** Directory the snapshot is written into; normally the data directory. */
  directory: string;
  logger: Logger;
  intervalMs?: number;
  commit?: string;
  now?: () => number;
  writeFile?: (path: string, contents: string) => void;
  rename?: (from: string, to: string) => void;
}

export const DEFAULT_HEARTBEAT_MS = 15_000;
export const HEALTH_FILENAME = "health.json";

export interface HealthReporter {
  /** Absolute path of the snapshot file. */
  readonly path: string;
  /** Write one snapshot immediately. */
  beat(overrides?: Partial<HealthSnapshot>): HealthSnapshot;
  start(collect: () => Partial<HealthSnapshot>): void;
  stop(): void;
}

export function createHealthReporter(options: HealthReporterOptions): HealthReporter {
  const intervalMs = options.intervalMs ?? DEFAULT_HEARTBEAT_MS;
  const now = options.now ?? (() => Date.now());
  const writeFile =
    options.writeFile ?? ((path, contents) => writeFileSync(path, contents, "utf8"));
  const rename = options.rename ?? ((from, to) => renameSync(from, to));

  const path = join(options.directory, HEALTH_FILENAME);
  const temporaryPath = `${path}.tmp`;

  let timer: ReturnType<typeof setInterval> | null = null;
  let startedAt = now();

  function beat(collect?: () => Partial<HealthSnapshot>): HealthSnapshot {
    const extra = collect?.() ?? {};

    const snapshot: HealthSnapshot = {
      ready: false,
      version: VERSION,
      commit: options.commit ?? "unknown",
      node: process.versions.node,
      database: "ok",
      discord: "connecting",
      guilds: 0,
      activeSessions: 0,
      uptimeSeconds: Math.floor((now() - startedAt) / 1_000),
      timestamp: new Date(now()).toISOString(),
      ...extra,
    };

    try {
      writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`);
      // Atomic swap, so a poller never reads a partial file.
      rename(temporaryPath, path);
    } catch (error) {
      // A heartbeat that cannot be written must not take the bot down; the
      // deploy script will simply time out and roll back, which is correct.
      options.logger.warn("could not write the health snapshot", {
        path,
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    return snapshot;
  }

  return {
    path,

    beat: (overrides) => beat(() => overrides ?? {}),

    start(collect) {
      startedAt = now();
      // Write one straight away so a poller does not have to wait a full
      // interval after a reload.
      beat(collect);

      timer = setInterval(() => beat(collect), intervalMs);
      if (typeof timer.unref === "function") timer.unref();
    },

    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
