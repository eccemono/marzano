import "dotenv/config";

import { loadConfig } from "./config/env";
import { createLogger } from "./logger";
import { BOT_NAME, REPOSITORY_URL, VERSION, assertSupportedNode } from "./runtime";

function main(): void {
  const bootstrap = createLogger();

  try {
    assertSupportedNode();

    const config = loadConfig();
    const logger = createLogger({ level: config.logLevel, bindings: { bot: BOT_NAME } });

    logger.info("startup", {
      version: VERSION,
      repository: REPOSITORY_URL,
      node: process.versions.node,
      clientId: config.clientId,
      dataDir: config.dataDir,
    });

    logger.warn("discord gateway is not wired yet; this build validates configuration only");
  } catch (error) {
    bootstrap.error(error instanceof Error ? error.message : "startup failed");
    process.exitCode = 1;
  }
}

main();
