import { existsSync, readFileSync } from "fs";
import { join } from "path";

const VERSION_FILE = join(import.meta.dir, "..", "VERSION");

let version = "0.1.0-dev";
if (existsSync(VERSION_FILE)) {
  version = readFileSync(VERSION_FILE, "utf-8").trim();
}

export const VERSION = version;
