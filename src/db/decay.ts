import { getConfig } from "../config";

/**
 * Calculate the decayed strength of a memory based on time since last access.
 *
 * Formula: base_strength * decay_rate^days * log(access_count + 1)
 *
 * - Decay rate of 0.95 means ~50% strength after 14 days without access
 * - Access count provides log-scale boost to reward frequently-used memories
 * - Result is capped at 1.0
 *
 * @param lastAccessed - ISO date string of last access
 * @param accessCount - Number of times memory has been accessed
 * @param baseStrength - Current stored strength (default 1.0)
 * @returns Decayed strength value between 0 and 1
 */
export function calculateDecayedStrength(
  lastAccessed: string,
  accessCount: number,
  baseStrength: number = 1.0,
): number {
  const config = getConfig();
  const decayRate = config.decay.rate;

  // Calculate days since last access
  const lastAccessDate = new Date(lastAccessed);
  const now = new Date();
  const msSinceAccess = now.getTime() - lastAccessDate.getTime();
  const daysSinceAccess = msSinceAccess / (1000 * 60 * 60 * 24);

  // Don't decay if accessed very recently (< ~1.4 minutes) or in the future (clock skew)
  if (daysSinceAccess < 0.001) {
    return Math.min(baseStrength, 1.0);
  }

  // Apply exponential decay
  const decayFactor = Math.pow(decayRate, daysSinceAccess);

  // Apply access count boost (log scale)
  // log(1) = 0, log(2) ≈ 0.69, log(10) ≈ 2.3
  const accessBoost = Math.log(accessCount + 1);

  // Calculate final strength
  // Normalize access boost so that access_count=1 gives boost of 1.0
  // log(2) ≈ 0.693, so we divide by log(2) to normalize
  const normalizedBoost = accessBoost / Math.log(2);
  const decayedStrength = baseStrength * decayFactor * normalizedBoost;

  // Cap at 1.0
  return Math.min(Math.max(decayedStrength, 0), 1.0);
}

/**
 * Calculate days since a given date.
 *
 * @param dateStr - ISO date string
 * @returns Number of days (can be fractional)
 */
export function daysSince(dateStr: string): number {
  const date = new Date(dateStr);
  const now = new Date();
  const ms = now.getTime() - date.getTime();
  return ms / (1000 * 60 * 60 * 24);
}

/**
 * Format decay info for display.
 *
 * @param currentStrength - Current stored strength
 * @param decayedStrength - Calculated decayed strength
 * @param daysSinceAccess - Days since last access
 * @returns Formatted string
 */
export function formatDecayInfo(
  currentStrength: number,
  decayedStrength: number,
  daysSinceAccess: number,
): string {
  const change = decayedStrength - currentStrength;
  const changeStr = change >= 0 ? `+${change.toFixed(3)}` : change.toFixed(3);
  const daysStr = daysSinceAccess.toFixed(1);

  return `${currentStrength.toFixed(3)} → ${decayedStrength.toFixed(3)} (${changeStr}, ${daysStr}d ago)`;
}
