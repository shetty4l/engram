#!/usr/bin/env bun

import { dirname, resolve } from "path";

function getRepoRoot(): string {
  return resolve(dirname(import.meta.path), "..");
}

function main(): void {
  const repoRoot = getRepoRoot();
  const config = {
    mcp: {
      engram: {
        type: "local",
        enabled: true,
        command: ["bun", "run", `${repoRoot}/src/index.ts`],
      },
    },
  };

  console.log(JSON.stringify(config, null, 2));
}

main();
