#!/usr/bin/env bun

/**
 * Setup script for Engram OpenCode integration
 *
 * Copies plugin file from the repo to ~/.config/opencode/
 * so it is available to OpenCode.
 *
 * Usage: bun run setup
 *
 * Note: Run this again after making changes to sync them.
 */

import { createHash } from "crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { dirname, resolve } from "path";

interface CopyConfig {
  source: string; // relative to repo root
  target: string; // relative to home directory
  description: string;
}

const FILES_TO_COPY: CopyConfig[] = [
  {
    source: "opencode/plugins/engram.ts",
    target: ".config/opencode/plugins/engram.ts",
    description: "Engram plugin",
  },
];

function getRepoRoot(): string {
  // This script is in scripts/, so repo root is one level up
  return resolve(dirname(import.meta.path), "..");
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function removeIfSymlink(targetPath: string): void {
  try {
    const stats = lstatSync(targetPath);
    if (stats.isSymbolicLink()) {
      console.log(`    Removing existing symlink: ${targetPath}`);
      unlinkSync(targetPath);
    }
  } catch {
    // File doesn't exist, which is fine
  }
}

function copyFile(config: CopyConfig): void {
  const repoRoot = getRepoRoot();
  const sourcePath = resolve(repoRoot, config.source);
  const targetPath = resolve(homedir(), config.target);
  const targetDir = dirname(targetPath);

  console.log(`  ${config.description}`);

  // Check source exists
  if (!existsSync(sourcePath)) {
    console.error(`    Error: Source file not found: ${sourcePath}`);
    process.exit(1);
  }

  // Create target directory if needed
  if (!existsSync(targetDir)) {
    console.log(`    Creating directory: ${targetDir}`);
    mkdirSync(targetDir, { recursive: true });
  }

  // Remove if it's a symlink (from previous setup)
  removeIfSymlink(targetPath);

  // Read source content
  const content = readFileSync(sourcePath, "utf-8");
  const sourceHash = hashContent(content);

  // Write to target (overwrites existing)
  console.log(`    Copying to ${targetPath}`);
  writeFileSync(targetPath, content, "utf-8");

  // Verify the copy
  if (!existsSync(targetPath)) {
    console.error(`    Error: Failed to create file at ${targetPath}`);
    process.exit(1);
  }

  const copiedContent = readFileSync(targetPath, "utf-8");
  const targetHash = hashContent(copiedContent);

  if (sourceHash !== targetHash) {
    console.error(`    Error: File verification failed - content mismatch`);
    console.error(`    Source hash: ${sourceHash}`);
    console.error(`    Target hash: ${targetHash}`);
    process.exit(1);
  }

  console.log(`    Verified (hash: ${sourceHash})`);
}

function main(): void {
  console.log("\n=== Engram Setup ===\n");
  console.log("Copying files for OpenCode integration...\n");

  for (const config of FILES_TO_COPY) {
    try {
      copyFile(config);
      console.log("    Done.\n");
    } catch (error) {
      console.error(`    Error copying file: ${error}`);
      process.exit(1);
    }
  }

  console.log("Setup complete!\n");
  console.log("Next steps:");
  console.log(
    "  1. Run 'bun link' to make the 'engram' CLI available globally",
  );
  console.log("  2. Restart OpenCode to load the plugin");
  console.log(
    "  3. The plugin will auto-start the engram daemon when needed\n",
  );
  console.log("Manual daemon control:");
  console.log("  engram start     Start daemon in background");
  console.log("  engram stop      Stop daemon");
  console.log("  engram status    Check daemon status\n");
  console.log(
    "Note: Run 'bun run setup' again after making changes to sync them.\n",
  );
}

main();
