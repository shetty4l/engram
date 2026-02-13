/**
 * Creates a version bump marker commit for the release workflow.
 *
 * Usage:
 *   bun run version:bump minor   # next release bumps minor (e.g. 0.1.18 -> 0.2.0)
 *   bun run version:bump major   # next release bumps major (e.g. 0.1.18 -> 1.0.0)
 *
 * Patch bumps are the default in the release workflow and need no marker.
 *
 * The script creates an empty commit with a [minor] or [major] tag in the
 * message. The release workflow scans all commits since the last tag for
 * these markers to determine the bump level.
 */

type BumpLevel = "minor" | "major";

const VALID_BUMPS: ReadonlySet<string> = new Set(["minor", "major"]);

const run = (cmd: string[]): { stdout: string; exitCode: number } => {
  const result = Bun.spawnSync({
    cmd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: new TextDecoder().decode(result.stdout).trim(),
    exitCode: result.exitCode,
  };
};

const fail = (message: string): never => {
  console.error(`error: ${message}`);
  return process.exit(1) as never;
};

const getLatestTag = (): string => {
  const { stdout, exitCode } = run(["git", "describe", "--tags", "--abbrev=0"]);
  if (exitCode !== 0 || !stdout.startsWith("v")) {
    fail("no git tags found. Create an initial tag (e.g. v0.1.0) first.");
  }
  return stdout;
};

const parseVersion = (tag: string): [number, number, number] => {
  const match = tag.match(/^v(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    return fail(`cannot parse tag "${tag}" as semver.`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
};

const computeNext = (
  current: [number, number, number],
  bump: BumpLevel,
): string => {
  const [major, minor] = current;
  if (bump === "major") {
    return `${major + 1}.0.0`;
  }
  return `${major}.${minor + 1}.0`;
};

const assertCleanTree = (): void => {
  const { stdout } = run(["git", "status", "--porcelain"]);
  if (stdout.length > 0) {
    fail(
      "working tree is dirty. Commit or stash changes first.\n" +
        "  (version bump creates an empty commit and requires a clean tree)",
    );
  }
};

const assertNoPendingBump = (latestTag: string, bump: BumpLevel): void => {
  const { stdout } = run(["git", "log", `${latestTag}..HEAD`, "--format=%s"]);
  if (stdout.includes(`[${bump}]`)) {
    fail(
      `a [${bump}] bump marker already exists in commits since ${latestTag}.\n` +
        "  There is no need to run this again.",
    );
  }
  // Warn if there's a different bump already pending
  const other: BumpLevel = bump === "minor" ? "major" : "minor";
  if (stdout.includes(`[${other}]`)) {
    console.warn(
      `warning: a [${other}] bump marker already exists since ${latestTag}.` +
        ` Adding [${bump}] — the release workflow will use the higher of the two.`,
    );
  }
};

// --- main ---

const bumpArg = process.argv[2];

if (!bumpArg || !VALID_BUMPS.has(bumpArg)) {
  console.error("usage: bun run version:bump <minor|major>");
  console.error("");
  console.error(
    "  minor   bump minor version, reset patch (e.g. 0.1.18 -> 0.2.0)",
  );
  console.error(
    "  major   bump major version, reset minor + patch (e.g. 0.1.18 -> 1.0.0)",
  );
  console.error("");
  console.error("  Patch bumps are automatic and need no marker.");
  process.exit(1);
}

const bump = bumpArg as BumpLevel;
const latestTag = getLatestTag();
const current = parseVersion(latestTag);
const next = computeNext(current, bump);

assertCleanTree();
assertNoPendingBump(latestTag, bump);

const commitMessage = `chore: version bump v${next} [${bump}]`;

const commitResult = run([
  "git",
  "commit",
  "--allow-empty",
  "-m",
  commitMessage,
]);

if (commitResult.exitCode !== 0) {
  fail("git commit failed.");
}

console.log("");
console.log(`  current version:  ${latestTag}`);
console.log(`  next version:     v${next} (${bump} bump)`);
console.log("");
console.log(`  created commit: ${commitMessage}`);
console.log("");
