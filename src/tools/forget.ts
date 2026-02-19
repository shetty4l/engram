import { err, ok, type Result } from "@shetty4l/core/result";
import { getConfig } from "../config";
import { deleteMemoryById, logMetric } from "../db";

export interface ForgetInput {
  id: string;
  session_id?: string;
  scope_id?: string;
}

export interface ForgetOutput {
  id: string;
  deleted: boolean;
}

export async function forget(
  input: ForgetInput,
): Promise<Result<ForgetOutput>> {
  const config = getConfig();
  if (config.features.scopes && !input.scope_id) {
    return err("scope_id is required when scopes are enabled");
  }

  const deleted = deleteMemoryById(
    input.id,
    config.features.scopes ? input.scope_id : undefined,
  );

  logMetric({
    session_id: input.session_id,
    event: "forget",
    memory_id: input.id,
  });

  return ok({
    id: input.id,
    deleted,
  });
}
