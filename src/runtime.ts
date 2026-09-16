export const BOT_NAME = "Marzano";
export const VERSION = "0.1.0";
export const REPOSITORY_URL = "https://github.com/eccemono/marzano";
export const LICENSE = "MIT";
export const REQUIRED_NODE_MAJOR = 22;

/**
 * Fail fast when the process is not running on the pinned Node line.
 *
 * Node 24.x (>= 24.19.0) carries the ObjectWrap cleanup-hook regression that
 * aborts the process inside native SQLite bindings (nodejs/node#65446), so the
 * bot must not silently start on the host's system node.
 */
export function assertSupportedNode(version: string = process.versions.node): void {
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  if (!Number.isInteger(major) || major !== REQUIRED_NODE_MAJOR) {
    throw new Error(
      `${BOT_NAME} requires Node ${REQUIRED_NODE_MAJOR}.x but is running on ${version}. ` +
        "Refusing to start: Node 24 aborts native SQLite bindings (nodejs/node#65446).",
    );
  }
}
