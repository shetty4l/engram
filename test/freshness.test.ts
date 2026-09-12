import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeDatabase,
  initDatabase,
  insertJudgeAudits,
  resetDatabase,
} from "../src/db";
import { getFreshness, isoWeek } from "../src/freshness";
import { startHttpServer } from "../src/http";

const NOW = new Date("2026-09-12T06:00:00Z");

describe("freshness", () => {
  let stateDir: string;
  const originalStateDir = process.env.ENGRAM_WORK_SYNC_STATE_DIR;
  const originalPort = process.env.ENGRAM_HTTP_PORT;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "engram-freshness-"));
    process.env.ENGRAM_WORK_SYNC_STATE_DIR = stateDir;
    process.env.ENGRAM_HTTP_PORT = "0";
    resetDatabase();
    initDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase();
    resetDatabase();
    rmSync(stateDir, { recursive: true, force: true });
    if (originalStateDir === undefined) {
      delete process.env.ENGRAM_WORK_SYNC_STATE_DIR;
    } else {
      process.env.ENGRAM_WORK_SYNC_STATE_DIR = originalStateDir;
    }
    if (originalPort === undefined) {
      delete process.env.ENGRAM_HTTP_PORT;
    } else {
      process.env.ENGRAM_HTTP_PORT = originalPort;
    }
  });

  function writeSyncState(lastSuccessAt: string, conflicts: unknown[] = []) {
    writeFileSync(
      join(stateDir, "status.json"),
      JSON.stringify({
        last_success_at: lastSuccessAt,
        memories_verified: 2613,
        interval_sec: 900,
        open_conflicts: conflicts.length,
      }),
    );
    writeFileSync(join(stateDir, "conflicts.json"), JSON.stringify(conflicts));
  }

  test("isoWeek matches the %G-W%V convention", () => {
    expect(isoWeek(new Date("2026-09-12T06:00:00Z"))).toBe("2026-W37");
    expect(isoWeek(new Date("2026-01-01T00:00:00Z"))).toBe("2026-W01");
    expect(isoWeek(new Date("2027-01-01T00:00:00Z"))).toBe("2026-W53");
  });

  test("a recent sync with no conflicts is fresh", () => {
    writeSyncState("2026-09-12T05:50:00Z");
    const f = getFreshness(NOW);
    expect(f.sync).toEqual({
      last_success_at: "2026-09-12T05:50:00Z",
      open_conflicts: 0,
      stale: false,
    });
  });

  test("a sync older than three intervals is stale", () => {
    writeSyncState("2026-09-12T05:00:00Z");
    expect(getFreshness(NOW).sync?.stale).toBe(true);
  });

  test("open conflicts are counted", () => {
    writeSyncState("2026-09-12T05:50:00Z", [
      { id: "fa335f3e", kind: "update" },
    ]);
    expect(getFreshness(NOW).sync?.open_conflicts).toBe(1);
  });

  test("a state dir with no status file means the sync never succeeded", () => {
    const f = getFreshness(NOW);
    expect(f.sync).toEqual({
      last_success_at: null,
      open_conflicts: 0,
      stale: true,
    });
  });

  test("no state dir means sync is not configured here", () => {
    process.env.ENGRAM_WORK_SYNC_STATE_DIR = join(stateDir, "absent");
    expect(getFreshness(NOW).sync).toBeNull();
  });

  test("judge freshness reports the last audited week and whether this week is missing", () => {
    expect(getFreshness(NOW).judge).toEqual({
      last_audit_week: null,
      missing_current_week: true,
    });
    insertJudgeAudits([
      { audit_week: "2026-W36", session_id: "s1", verdict: "ignored" },
    ]);
    expect(getFreshness(NOW).judge).toEqual({
      last_audit_week: "2026-W36",
      missing_current_week: true,
    });
    insertJudgeAudits([
      { audit_week: "2026-W37", session_id: "s2", verdict: "used" },
    ]);
    expect(getFreshness(NOW).judge.missing_current_week).toBe(false);
  });

  test("/health carries sync and judge freshness and degrades on a stale sync", async () => {
    writeSyncState("2026-01-01T00:00:00Z");
    const server = startHttpServer();
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        sync: {
          stale: boolean;
          open_conflicts: number;
          last_success_at: string;
        };
        judge: {
          last_audit_week: string | null;
          missing_current_week: boolean;
        };
      };
      expect(body.status).toBe("degraded");
      expect(body.sync.stale).toBe(true);
      expect(body.sync.last_success_at).toBe("2026-01-01T00:00:00Z");
      expect(body.judge.missing_current_week).toBe(true);
    } finally {
      server.stop();
    }
  });

  test("engram stats prints the same freshness, text and json", async () => {
    writeSyncState("2026-01-01T00:00:00Z", [
      { id: "fa335f3e", kind: "update" },
    ]);
    const env = {
      ...process.env,
      ENGRAM_DB_PATH: join(stateDir, "stats.db"),
      ENGRAM_WORK_SYNC_STATE_DIR: stateDir,
    };
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    const text = await new Response(
      Bun.spawn(["bun", "run", cli, "stats"], { env, stderr: "ignore" }).stdout,
    ).text();
    expect(text).toContain(
      "Sync:               STALE, last success 2026-01-01T00:00:00Z, 1 open conflicts",
    );
    expect(text).toContain(
      "Judge:              last audit none, MISSING for the current week",
    );

    const json = JSON.parse(
      await new Response(
        Bun.spawn(["bun", "run", cli, "stats", "--json"], {
          env,
          stderr: "ignore",
        }).stdout,
      ).text(),
    ) as {
      sync: { stale: boolean; open_conflicts: number };
      judge: { missing_current_week: boolean };
    };
    expect(json.sync).toMatchObject({ stale: true, open_conflicts: 1 });
    expect(json.judge.missing_current_week).toBe(true);
  });

  test("/health stays healthy when the sync is fresh", async () => {
    writeSyncState(new Date().toISOString().replace(/\.\d{3}Z$/, "Z"));
    const server = startHttpServer();
    try {
      const body = (await (
        await fetch(`http://127.0.0.1:${server.port}/health`)
      ).json()) as {
        status: string;
      };
      expect(body.status).toBe("healthy");
    } finally {
      server.stop();
    }
  });
});
