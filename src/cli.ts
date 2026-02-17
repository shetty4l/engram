#!/usr/bin/env bun

/**
 * Engram CLI — persistent memory for AI agents
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

import type { CommandHandler } from "@shetty4l/core/cli";
import { formatUptime, runCli } from "@shetty4l/core/cli";
import { onShutdown } from "@shetty4l/core/signals";
import { getConfig } from "./config";
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
Engram CLI \u2014 persistent memory for AI agents

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
  engram health          Check health of running instance
  engram version         Show version

Options:
  --json                 Output in JSON format
  --version, -v          Show version
  --help, -h             Show help
`;

// --- Helpers ---

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "N/A";
  const date = new Date(dateStr);
  return date.toLocaleString();
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return `${str.slice(0, maxLen - 3)}...`;
}

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

/** Wrap a command handler so initDatabase() is called before dispatch. */
function withDb(fn: CommandHandler): CommandHandler {
  return (args, json) => {
    initDatabase();
    return fn(args, json);
  };
}

// --- Commands ---

function cmdStats(_args: string[], json: boolean): void {
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

function cmdRecent(args: string[], json: boolean): number {
  const limit = args[0] ? Number.parseInt(args[0], 10) : 10;

  if (Number.isNaN(limit) || limit < 1) {
    console.error("Error: limit must be a positive number");
    return 1;
  }

  const memories = getRecentMemories(limit);

  if (json) {
    console.log(JSON.stringify(stripEmbeddings(memories), null, 2));
    return 0;
  }

  if (memories.length === 0) {
    console.log("\nNo memories found.\n");
    return 0;
  }

  console.log(`\n=== Recent Memories (${memories.length}) ===\n`);

  for (const mem of memories) {
    const category = mem.category ?? "none";
    console.log(`[${mem.id.slice(0, 8)}] (${category})`);
    console.log(`  ${truncate(mem.content, 70)}`);
    console.log(`  Created: ${formatDate(mem.created_at)}`);
    console.log();
  }
  return 0;
}

function cmdSearch(args: string[], json: boolean): number {
  const query = args.join(" ");
  if (!query) {
    console.error("Error: search query required");
    console.error("Usage: engram search <query>");
    return 1;
  }

  const results = searchMemories(query, 20);

  if (json) {
    console.log(JSON.stringify(stripEmbeddings(results), null, 2));
    return 0;
  }

  if (results.length === 0) {
    console.log(`\nNo memories found for query: "${query}"\n`);
    return 0;
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
  return 0;
}

function cmdMetrics(_args: string[], json: boolean): void {
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

function cmdShow(args: string[], json: boolean): number {
  const id = args[0];
  if (!id) {
    console.error("Error: memory ID required");
    console.error("Usage: engram show <id>");
    return 1;
  }

  const memory = getMemoryById(id);

  if (!memory) {
    console.error(`Error: memory not found: ${id}`);
    return 1;
  }

  if (json) {
    console.log(JSON.stringify(stripEmbedding(memory), null, 2));
    return 0;
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
  return 0;
}

function cmdForget(args: string[], json: boolean): number {
  const id = args[0];
  if (!id) {
    console.error("Error: memory ID required");
    console.error("Usage: engram forget <id>");
    return 1;
  }

  const deleted = deleteMemoryById(id);

  if (json) {
    console.log(JSON.stringify({ id, deleted }, null, 2));
    return deleted ? 0 : 1;
  }

  if (!deleted) {
    console.error(`Error: memory not found: ${id}`);
    return 1;
  }

  console.log(`Deleted memory: ${id}`);
  return 0;
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
          ? ` \u2192 ${m.decayed_strength.toFixed(3)}`
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

function cmdPrune(args: string[], json: boolean): number {
  const dryRun = args.includes("--dry-run");
  const thresholdArg = args.find((a) => a.startsWith("--threshold="));
  const threshold = thresholdArg
    ? Number.parseFloat(thresholdArg.split("=")[1])
    : 0.1;

  if (Number.isNaN(threshold) || threshold < 0 || threshold > 1) {
    console.error("Error: threshold must be a number between 0 and 1");
    return 1;
  }

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
      return 0;
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

  if (!dryRun && toPrune.length > 0) {
    const deleted = pruneMemoriesBelowStrength(threshold);
    if (!json) {
      console.log(`\nDeleted ${deleted} memories.`);
    }
  }
  return 0;
}

function cmdServe(): void {
  const server = startHttpServer();
  onShutdown(() => server.stop(), { name: "engram" });
}

async function cmdStart(): Promise<number> {
  const started = await startDaemon();
  return started ? 0 : 1;
}

async function cmdStop(): Promise<number> {
  const stopped = await stopDaemon();
  return stopped ? 0 : 1;
}

async function cmdStatus(_args: string[], json: boolean): Promise<number> {
  const status = await getDaemonStatus();

  if (json) {
    console.log(JSON.stringify(status, null, 2));
    return status.running ? 0 : 1;
  }

  if (status.running) {
    const uptimeStr = status.uptime ? formatUptime(status.uptime) : "unknown";
    console.log(
      `engram is running (PID: ${status.pid}, port: ${status.port}, uptime: ${uptimeStr})`,
    );
    return 0;
  }

  console.log("engram is not running");
  return 1;
}

async function cmdRestart(): Promise<number> {
  const restarted = await restartDaemon();
  return restarted ? 0 : 1;
}

async function cmdHealth(_args: string[], json: boolean): Promise<number> {
  const config = getConfig();
  const { port, host } = config.http;

  let response: Response;
  try {
    response = await fetch(`http://${host}:${port}/health`);
  } catch {
    if (json) {
      console.log(JSON.stringify({ error: "Server not reachable", port }));
    } else {
      console.error(`engram is not running on port ${port}`);
    }
    return 1;
  }

  const data = (await response.json()) as {
    status: string;
    version: string;
    uptime: number;
  };

  if (json) {
    console.log(JSON.stringify(data, null, 2));
    return data.status === "healthy" ? 0 : 1;
  }

  console.log(
    `\nStatus:  ${data.status === "healthy" ? "healthy" : "degraded"}`,
  );
  console.log(`Version: ${data.version}`);
  console.log(`Uptime:  ${formatUptime(data.uptime)}\n`);

  return data.status === "healthy" ? 0 : 1;
}

// --- Main ---

runCli({
  name: "engram",
  version: VERSION,
  help: HELP,
  commands: {
    serve: () => cmdServe(),
    start: () => cmdStart(),
    stop: () => cmdStop(),
    status: cmdStatus,
    restart: () => cmdRestart(),
    health: cmdHealth,
    stats: withDb(cmdStats),
    recent: withDb(cmdRecent),
    search: withDb(cmdSearch),
    metrics: withDb(cmdMetrics),
    show: withDb(cmdShow),
    forget: withDb(cmdForget),
    decay: withDb(cmdDecay),
    prune: withDb(cmdPrune),
  },
});
