import { deleteMemoryById, logMetric } from "../db";

export interface ForgetInput {
  id: string;
  session_id?: string;
}

export interface ForgetOutput {
  id: string;
  deleted: boolean;
}

export async function forget(input: ForgetInput): Promise<ForgetOutput> {
  const deleted = deleteMemoryById(input.id);

  logMetric({
    session_id: input.session_id,
    event: "forget",
    memory_id: input.id,
  });

  return {
    id: input.id,
    deleted,
  };
}
