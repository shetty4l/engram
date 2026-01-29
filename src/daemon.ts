/**
 * Daemon management for Engram HTTP server
 *
 * Handles starting/stopping the HTTP server as a background process.
 * PID and log files stored in ~/.local/share/engram/
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { getConfig, getDataDirectory } from "./config";

const PID_FILE = "engram.pid";
const LOG_FILE = "engram.log";

export interface DaemonStatus {
  running: boolean;
  pid?: number;
  port?: number;
  uptime?: number;
}

function getPidPath(): string {
  return join(getDataDirectory(), PID_FILE);
}

function getLogPath(): string {
  return join(getDataDirectory(), LOG_FILE);
}

/**
 * Check if a process with the given PID is running
 */
function isProcessRunning(pid: number): boolean {
  try {
    // Sending signal 0 doesn't kill the process, just checks if it exists
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read PID from file, returns undefined if not found or invalid
 */
function readPid(): number | undefined {
  const pidPath = getPidPath();
  if (!existsSync(pidPath)) {
    return undefined;
  }

  try {
    const content = readFileSync(pidPath, "utf-8").trim();
    const pid = parseInt(content, 10);
    return isNaN(pid) ? undefined : pid;
  } catch {
    return undefined;
  }
}

/**
 * Write PID to file
 */
function writePid(pid: number): void {
  const pidPath = getPidPath();
  writeFileSync(pidPath, pid.toString(), "utf-8");
}

/**
 * Remove PID file
 */
function removePidFile(): void {
  const pidPath = getPidPath();
  if (existsSync(pidPath)) {
    unlinkSync(pidPath);
  }
}

/**
 * Get daemon status
 */
export async function getDaemonStatus(): Promise<DaemonStatus> {
  const pid = readPid();

  if (!pid) {
    return { running: false };
  }

  if (!isProcessRunning(pid)) {
    // Stale PID file, clean it up
    removePidFile();
    return { running: false };
  }

  // Try to get health info from the running server
  const config = getConfig();
  try {
    const response = await fetch(
      `http://${config.http.host}:${config.http.port}/health`,
    );
    if (response.ok) {
      const health = (await response.json()) as { uptime?: number };
      return {
        running: true,
        pid,
        port: config.http.port,
        uptime: health.uptime,
      };
    }
  } catch {
    // Server might be starting up or unresponsive
  }

  return {
    running: true,
    pid,
    port: config.http.port,
  };
}

/**
 * Start the daemon
 * Returns true if started successfully, false if already running
 */
export async function startDaemon(): Promise<boolean> {
  const status = await getDaemonStatus();

  if (status.running) {
    console.log(`Engram daemon already running (PID: ${status.pid})`);
    return false;
  }

  const config = getConfig();
  const logPath = getLogPath();

  // Get the path to the CLI entry point
  const cliPath = join(import.meta.dir, "cli.ts");

  // Spawn detached process
  const proc = Bun.spawn(["bun", "run", cliPath, "serve"], {
    stdout: Bun.file(logPath),
    stderr: Bun.file(logPath),
    stdin: "ignore",
  });

  // Write PID
  writePid(proc.pid);

  // Wait a moment for the server to start
  await new Promise((resolve) => setTimeout(resolve, 500));

  // Verify it's running
  const newStatus = await getDaemonStatus();
  if (newStatus.running) {
    console.log(
      `Engram daemon started (PID: ${proc.pid}, port: ${config.http.port})`,
    );
    return true;
  }

  console.error("Failed to start Engram daemon. Check logs:", logPath);
  removePidFile();
  return false;
}

/**
 * Stop the daemon
 * Returns true if stopped successfully, false if not running
 */
export async function stopDaemon(): Promise<boolean> {
  const status = await getDaemonStatus();

  if (!status.running || !status.pid) {
    console.log("Engram daemon is not running");
    return false;
  }

  try {
    // Send SIGTERM for graceful shutdown
    process.kill(status.pid, "SIGTERM");

    // Wait for process to exit (with timeout)
    const maxWait = 5000;
    const interval = 100;
    let waited = 0;

    while (waited < maxWait) {
      await new Promise((resolve) => setTimeout(resolve, interval));
      waited += interval;

      if (!isProcessRunning(status.pid)) {
        break;
      }
    }

    // Force kill if still running
    if (isProcessRunning(status.pid)) {
      process.kill(status.pid, "SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    removePidFile();
    console.log(`Engram daemon stopped (was PID: ${status.pid})`);
    return true;
  } catch (error) {
    console.error("Error stopping daemon:", error);
    removePidFile();
    return false;
  }
}

/**
 * Restart the daemon
 */
export async function restartDaemon(): Promise<boolean> {
  await stopDaemon();
  return startDaemon();
}
