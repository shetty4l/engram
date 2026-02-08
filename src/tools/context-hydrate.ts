import { type RecallInput, type RecallMemory, recall } from "./recall";

export interface ContextHydrateInput extends Omit<RecallInput, "query"> {
  query?: string;
}

export interface ContextHydrateOutput {
  context: RecallMemory[];
  fallback_mode: boolean;
}

export async function contextHydrate(
  input: ContextHydrateInput,
): Promise<ContextHydrateOutput> {
  const result = await recall({
    ...input,
    query: input.query ?? "",
  });

  return {
    context: result.memories,
    fallback_mode: result.fallback_mode,
  };
}
