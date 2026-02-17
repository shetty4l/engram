import { readVersion } from "@shetty4l/core/version";
import { join } from "path";

export const VERSION = readVersion(join(import.meta.dir, ".."));
