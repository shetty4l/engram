import { getConfig } from "./config";

export interface CapabilitiesResponse {
  version: string;
  features: {
    query_only: boolean;
    scopes: boolean;
    idempotency: boolean;
    context_hydration: boolean;
    work_items: boolean;
  };
  tools: string[];
}

export function getCapabilities(version: string): CapabilitiesResponse {
  const config = getConfig();
  const tools = config.queryOnly
    ? ["recall", "capabilities"]
    : ["remember", "recall", "forget", "capabilities"];

  if (config.features.contextHydration) {
    tools.push("context_hydrate");
  }

  return {
    version,
    features: {
      query_only: config.queryOnly,
      scopes: config.features.scopes,
      idempotency: config.features.idempotency,
      context_hydration: config.features.contextHydration,
      work_items: config.features.workItems,
    },
    tools,
  };
}
