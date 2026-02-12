#!/usr/bin/env bun

/**
 * Engram CLI - Analyze your AI memory database
 *
 * Usage:
 *   engram stats           Show memory statistics
 *   engram recent [n]      Show n most recent memories (default: 10)
 *   engram search <query>  Search memories by keyword
 *   engram metrics         Show usage metrics
 *   engram show <id>       Show a specific memory
 *   engram forget <id>     Delete a specific memory
 *   engram decay           Show decay status for all memories
 *   engram prune [opts]    Delete weak memories (--threshold=0.1 --dry-run)
 *
 *   engram serve           Start HTTP server (foreground)
 *   engram start           Start HTTP server as daemon
 *   engram stop            Stop daemon
 *   engram status          Show daemon status
 *   engram restart         Restart daemon
 *   engram version         Show version
 *
 * Options:
 *   --json                 Output in JSON format
 *   --version, -v          Show version
 *   --help, -h             Show help
 */

import {
  getDaemonStatus,
  restartDaemon,
  startDaemon,
  stopDaemon,
} from "./daemon";
import {
  deleteMemoryById,
  getAllMemoriesForDecay,
  getMemoriesBelowStrength,
  getMemoryById,
  getMetricsSummary,
  getRecentMemories,
  getStats,
  initDatabase,
  pruneMemoriesBelowStrength,
  searchMemories,
  updateMemoryStrength,
} from "./db";
import { calculateDecayedStrength, daysSince } from "./db/decay";
import { startHttpServer } from "./http";
import { VERSION } from "./version";

const HELP = `
Engram CLI - Analyze your AI memory database

Usage:
  engram stats           Show memory statistics
  engram recent [n]      Show n most recent memories (default: 10)
  engram search <query>  Search memories by keyword
  engram metrics         Show usage metrics
  engram show <id>       Show a specific memory
  engram forget <id>     Delete a specific memory
  engram decay           Show decay status for all memories
  engram prune [opts]    Delete weak memories (--threshold=0.1 --dry-run)

  engram serve           Start HTTP server (foreground)
  engram start           Start HTTP server as daemon
  engram stop            Stop daemon
  engram status          Show daemon status
  engram restart         Restart daemon
  engram version         Show version

Options:
  --json                 Output in JSON format
  --version, -v          Show version
  --help, -h             Show help
`;

function parseArgs(args: string[]): {
  command: string;
  args: string[];
  json: boolean;
} {
  const filtered = args.filter((a) => a !== "--json");
  const json = args.includes("--json");
  const [command = "help", ...rest] = filtered;
  return { command, args: rest, json };
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "N/A";
  const date = new Date(dateStr);
  return date.toLocaleString();
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return `${str.slice(0, maxLen - 3)}...`;
}

// Strip embedding from memory objects for JSON output (too noisy)
function stripEmbedding<T extends { embedding?: unknown }>(
  obj: T,
): Omit<T, "embedding"> {
  const { embedding: _, ...rest } = obj;
  return rest;
}

function stripEmbeddings<T extends { embedding?: unknown }>(
  arr: T[],
): Omit<T, "embedding">[] {
  return arr.map(stripEmbedding);
}

// Commands

function cmdStats(json: boolean): void {
  const stats = getStats();

  if (json) {
    console.log(JSON.stringify(stats, null, 2));
    return;
  }

  console.log("\n=== Engram Memory Stats ===\n");
  console.log(`Total memories:     ${stats.total_memories}`);
  console.log(`Total accesses:     ${stats.total_access_count}`);
  console.log(`Average strength:   ${stats.avg_strength.toFixed(2)}`);
  console.log(`Oldest memory:      ${formatDate(stats.oldest_memory)}`);
  console.log(`Newest memory:      ${formatDate(stats.newest_memory)}`);

  if (stats.categories.length > 0) {
    console.log("\nCategories:");
    for (const cat of stats.categories) {
      const label = cat.category ?? "(uncategorized)";
      console.log(`  ${label.padEnd(15)} ${cat.count}`);
    }
  }
  console.log();
}

function cmdRecent(limitStr: string | undefined, json: boolean): void {
  const limit = limitStr ? Number.parseInt(limitStr, 10) : 10;

  if (Number.isNaN(limit) || limit < 1) {
    console.error("Error: limit must be a positive number");
    process.exit(1);
  }

  const memories = getRecentMemories(limit);

  if (json) {
    console.log(JSON.stringify(stripEmbeddings(memories), null, 2));
    return;
  }

  if (memories.length === 0) {
    console.log("\nNo memories found.\n");
    return;
  }

  console.log(`\n=== Recent Memories (${memories.length}) ===\n`);

  for (const mem of memories) {
    const category = mem.category ?? "none";
    console.log(`[${mem.id.slice(0, 8)}] (${category})`);
    console.log(`  ${truncate(mem.content, 70)}`);
    console.log(`  Created: ${formatDate(mem.created_at)}`);
    console.log();
  }
}

function cmdSearch(query: string | undefined, json: boolean): void {
  if (!query) {
    console.error("Error: search query required");
    console.error("Usage: engram search <query>");
    process.exit(1);
  }

  const results = searchMemories(query, 20);

  if (json) {
    console.log(JSON.stringify(stripEmbeddings(results), null, 2));
    return;
  }

  if (results.length === 0) {
    console.log(`\nNo memories found for query: "${query}"\n`);
    return;
  }

  console.log(`\n=== Search Results for "${query}" (${results.length}) ===\n`);

  for (const mem of results) {
    const category = mem.category ?? "none";
    console.log(
      `[${mem.id.slice(0, 8)}] (${category}) rank: ${mem.rank.toFixed(2)}`,
    );
    console.log(`  ${truncate(mem.content, 70)}`);
    console.log();
  }
}

function cmdMetrics(json: boolean): void {
  const metrics = getMetricsSummary();

  if (json) {
    console.log(JSON.stringify(metrics, null, 2));
    return;
  }

  console.log("\n=== Engram Usage Metrics ===\n");
  console.log(`Total remembers:    ${metrics.total_remembers}`);
  console.log(`Total recalls:      ${metrics.total_recalls}`);
  console.log(
    `Recall hit rate:    ${(metrics.recall_hit_rate * 100).toFixed(1)}%`,
  );
  console.log(
    `Fallback rate:      ${(metrics.fallback_rate * 100).toFixed(1)}%`,
  );
  console.log();
}

function cmdShow(id: string | undefined, json: boolean): void {
  if (!id) {
    console.error("Error: memory ID required");
    console.error("Usage: engram show <id>");
    process.exit(1);
  }

  const memory = getMemoryById(id);

  if (!memory) {
    console.error(`Error: memory not found: ${id}`);
    process.exit(1);
  }

  if (json) {
    console.log(JSON.stringify(stripEmbedding(memory), null, 2));
    return;
  }

  console.log("\n=== Memory Details ===\n");
  console.log(`ID:            ${memory.id}`);
  console.log(`Category:      ${memory.category ?? "(none)"}`);
  console.log(`Strength:      ${memory.strength}`);
  console.log(`Access count:  ${memory.access_count}`);
  console.log(`Created:       ${formatDate(memory.created_at)}`);
  console.log(`Last accessed: ${formatDate(memory.last_accessed)}`);
  console.log(`\nContent:\n${memory.content}`);
  console.log();
}

function cmdForget(id: string | undefined, json: boolean): void {
  if (!id) {
    console.error("Error: memory ID required");
    console.error("Usage: engram forget <id>");
    process.exit(1);
  }

  const deleted = deleteMemoryById(id);

  if (json) {
    console.log(JSON.stringify({ id, deleted }, null, 2));
    process.exit(deleted ? 0 : 1);
  }

  if (!deleted) {
    console.error(`Error: memory not found: ${id}`);
    process.exit(1);
  }

  console.log(`Deleted memory: ${id}`);
}

function cmdDecay(args: string[], json: boolean): void {
  const memories = getAllMemoriesForDecay();

  if (memories.length === 0) {
    if (json) {
      console.log(JSON.stringify({ memories: [], updated: 0 }, null, 2));
    } else {
      console.log("\nNo memories found.\n");
    }
    return;
  }

  // Calculate decay for each memory
  const decayInfo = memories.map((m) => {
    const decayedStrength = calculateDecayedStrength(
      m.last_accessed,
      m.access_count,
      m.strength,
    );
    const days = daysSince(m.last_accessed);
    return {
      id: m.id,
      content: m.content,
      category: m.category,
      stored_strength: m.strength,
      decayed_strength: decayedStrength,
      days_since_access: days,
      access_count: m.access_count,
      needs_update: Math.abs(m.strength - decayedStrength) > 0.001,
    };
  });

  // Check if --apply flag is present
  const shouldApply = args.includes("--apply");

  if (json) {
    console.log(
      JSON.stringify(
        {
          memories: decayInfo,
          needs_update: decayInfo.filter((m) => m.needs_update).length,
          applied: shouldApply,
        },
        null,
        2,
      ),
    );
  } else {
    console.log("\n=== Memory Decay Status ===\n");

    for (const m of decayInfo) {
      const changeStr =
        m.stored_strength !== m.decayed_strength
          ? ` → ${m.decayed_strength.toFixed(3)}`
          : "";
      const staleStr = m.needs_update ? " (stale)" : "";
      console.log(
        `[${m.id.slice(0, 8)}] strength: ${m.stored_strength.toFixed(3)}${changeStr}${staleStr}`,
      );
      console.log(
        `  ${truncate(m.content, 50)} (${m.days_since_access.toFixed(1)}d ago, ${m.access_count} accesses)`,
      );
    }

    const staleCount = decayInfo.filter((m) => m.needs_update).length;
    console.log(
      `\nTotal: ${memories.length} memories, ${staleCount} need update`,
    );

    if (!shouldApply && staleCount > 0) {
      console.log("\nRun 'engram decay --apply' to persist decayed strengths.");
    }
  }

  // Apply decay if requested
  if (shouldApply) {
    let updated = 0;
    for (const m of decayInfo) {
      if (m.needs_update) {
        updateMemoryStrength(m.id, m.decayed_strength);
        updated++;
      }
    }
    if (!json) {
      console.log(`\nUpdated ${updated} memories with decayed strengths.`);
    }
  }
}

function cmdPrune(args: string[], json: boolean): void {
  // Parse options
  const dryRun = args.includes("--dry-run");
  const thresholdArg = args.find((a) => a.startsWith("--threshold="));
  const threshold = thresholdArg ? parseFloat(thresholdArg.split("=")[1]) : 0.1;

  if (Number.isNaN(threshold) || threshold < 0 || threshold > 1) {
    console.error("Error: threshold must be a number between 0 and 1");
    process.exit(1);
  }

  // First, apply decay to all memories so we're working with current values
  // (skip on dry-run to avoid side effects)
  const memories = getAllMemoriesForDecay();
  if (!dryRun) {
    for (const m of memories) {
      const decayedStrength = calculateDecayedStrength(
        m.last_accessed,
        m.access_count,
        m.strength,
      );
      if (Math.abs(m.strength - decayedStrength) > 0.001) {
        updateMemoryStrength(m.id, decayedStrength);
      }
    }
  }

  // For dry-run, calculate what decay WOULD produce without persisting
  const effectiveMemories = dryRun
    ? memories.map((m) => ({
        ...m,
        strength: calculateDecayedStrength(
          m.last_accessed,
          m.access_count,
          m.strength,
        ),
      }))
    : memories;

  // Now find memories below threshold
  const toPrune = dryRun
    ? effectiveMemories.filter((m) => m.strength < threshold)
    : getMemoriesBelowStrength(threshold);

  if (json) {
    const result = {
      threshold,
      dry_run: dryRun,
      count: toPrune.length,
      memories: toPrune.map((m) => ({
        id: m.id,
        content: truncate(m.content, 100),
        category: m.category,
        strength: m.strength,
      })),
      deleted: dryRun ? 0 : toPrune.length,
    };
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\n=== Prune Memories (threshold: ${threshold}) ===\n`);

    if (toPrune.length === 0) {
      console.log("No memories below threshold.\n");
      return;
    }

    for (const m of toPrune) {
      console.log(
        `[${m.id.slice(0, 8)}] strength: ${m.strength.toFixed(3)} (${m.category ?? "none"})`,
      );
      console.log(`  ${truncate(m.content, 60)}`);
    }

    console.log(`\nFound ${toPrune.length} memories below threshold.`);

    if (dryRun) {
      console.log("Dry run - no memories deleted.");
      console.log("Run without --dry-run to delete these memories.");
    }
  }

  // Actually delete if not dry run
  if (!dryRun && toPrune.length > 0) {
    const deleted = pruneMemoriesBelowStrength(threshold);
    if (!json) {
      console.log(`\nDeleted ${deleted} memories.`);
    }
  }
}

function cmdServe(): void {
  console.log("Starting Engram HTTP server...");
  const server = startHttpServer();

  // Keep process running
  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    server.stop();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    server.stop();
    process.exit(0);
  });
}

async function cmdStart(): Promise<void> {
  const started = await startDaemon();
  process.exit(started ? 0 : 1);
}

async function cmdStop(): Promise<void> {
  const stopped = await stopDaemon();
  process.exit(stopped ? 0 : 1);
}

async function cmdStatus(json: boolean): Promise<void> {
  const status = await getDaemonStatus();

  if (json) {
    console.log(JSON.stringify(status, null, 2));
    process.exit(status.running ? 0 : 1);
  }

  if (status.running) {
    const uptimeStr = status.uptime ? formatUptime(status.uptime) : "unknown";
    console.log(
      `Engram daemon running (PID: ${status.pid}, port: ${status.port}, uptime: ${uptimeStr})`,
    );
    process.exit(0);
  } else {
    console.log("Engram daemon is not running");
    process.exit(1);
  }
}

async function cmdRestart(): Promise<void> {
  const restarted = await restartDaemon();
  process.exit(restarted ? 0 : 1);
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

// Main

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);

  // Check for help flag
  if (
    rawArgs.includes("--help") ||
    rawArgs.includes("-h") ||
    rawArgs.length === 0
  ) {
    console.log(HELP);
    process.exit(0);
  }

  // Check for version flag
  if (rawArgs.includes("--version") || rawArgs.includes("-v")) {
    console.log(VERSION);
    process.exit(0);
  }

  const { command, args, json } = parseArgs(rawArgs);

  // Daemon commands (don't require DB init for some)
  switch (command) {
    case "serve":
      cmdServe();
      return; // Keep running
    case "start":
      await cmdStart();
      return;
    case "stop":
      await cmdStop();
      return;
    case "status":
      await cmdStatus(json);
      return;
    case "restart":
      await cmdRestart();
      return;
    case "version":
      console.log(VERSION);
      return;
  }

  // Initialize database for other commands
  initDatabase();

  switch (command) {
    case "stats":
      cmdStats(json);
      break;
    case "recent":
      cmdRecent(args[0], json);
      break;
    case "search":
      cmdSearch(args.join(" "), json);
      break;
    case "metrics":
      cmdMetrics(json);
      break;
    case "show":
      cmdShow(args[0], json);
      break;
    case "forget":
      cmdForget(args[0], json);
      break;
    case "decay":
      cmdDecay(args, json);
      break;
    case "prune":
      cmdPrune(args, json);
      break;
    case "help":
      console.log(HELP);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.log(HELP);
      process.exit(1);
  }
}

main();
