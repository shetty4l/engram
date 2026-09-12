import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "@shetty4l/core/config";
import { getDatabase } from "./db";

interface SyncFreshness {
  last_success_at: string | null;
  open_conflicts: number;
  stale: boolean;
}

interface JudgeFreshness {
  last_audit_week: string | null;
  missing_current_week: boolean;
}

export interface Freshness {
  sync: SyncFreshness | null;
  judge: JudgeFreshness;
}

const STALE_INTERVALS = 3;

export function isoWeek(date: Date): string {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function getSyncFreshness(now: Date): SyncFreshness | null {
  const stateDir =
    process.env.ENGRAM_WORK_SYNC_STATE_DIR ??
    join(getDataDir("engram"), "work-sync-state");
  if (!existsSync(stateDir)) return null;
  const statusPath = join(stateDir, "status.json");
  if (!existsSync(statusPath)) {
    return { last_success_at: null, open_conflicts: 0, stale: true };
  }
  const status = readJson<{ last_success_at: string; interval_sec: number }>(
    statusPath,
  );
  const conflicts = readJson<unknown[]>(join(stateDir, "conflicts.json"));
  const last = Date.parse(status.last_success_at);
  if (
    Number.isNaN(last) ||
    typeof status.interval_sec !== "number" ||
    !Array.isArray(conflicts)
  ) {
    throw new Error(`malformed ${statusPath}`);
  }
  const ageSec = (now.getTime() - last) / 1000;
  return {
    last_success_at: status.last_success_at,
    open_conflicts: conflicts.length,
    stale: ageSec > STALE_INTERVALS * status.interval_sec,
  };
}

function getJudgeFreshness(now: Date): JudgeFreshness {
  const row = getDatabase()
    .prepare(
      "SELECT audit_week FROM judge_audits ORDER BY audit_week DESC LIMIT 1",
    )
    .get() as { audit_week: string } | null;
  const last = row?.audit_week ?? null;
  return { last_audit_week: last, missing_current_week: last !== isoWeek(now) };
}

export function getFreshness(now = new Date()): Freshness {
  return { sync: getSyncFreshness(now), judge: getJudgeFreshness(now) };
}

export function healthStatus(freshness: Freshness): "healthy" | "degraded" {
  const sync = freshness.sync;
  return sync !== null && (sync.stale || sync.open_conflicts > 0)
    ? "degraded"
    : "healthy";
}
