import { ok, type Result } from "@shetty4l/core/result";
import { getConfig } from "../config";
import { type DeleteScope, deleteMemoryById, logMetric } from "../db";

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

  let scope: DeleteScope;
  if (!config.features.scopes) {
    scope = { mode: "any" };
  } else if (input.scope_id) {
    scope = { mode: "scoped", scope_id: input.scope_id };
  } else {
    scope = { mode: "unscoped" };
  }

  const deleted = deleteMemoryById(input.id, scope);

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
