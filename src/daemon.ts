/**
 * Daemon management for Engram — delegates to core's createDaemonManager.
 */

import { getConfigDir } from "@shetty4l/core/config";
import { createDaemonManager } from "@shetty4l/core/daemon";
import { join } from "path";
import { getConfig } from "./config";

export function getDaemon() {
  const config = getConfig();
  const { port, host } = config.http;

  return createDaemonManager({
    name: "engram",
    configDir: getConfigDir("engram"),
    cliPath: join(import.meta.dir, "cli.ts"),
    healthUrl: `http://${host}:${port}/health`,
  });
}

export type { DaemonManager, DaemonStatus } from "@shetty4l/core/daemon";
