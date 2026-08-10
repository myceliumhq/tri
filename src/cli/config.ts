import { requireConfig } from "@myceliumhq/toolkit";
import { createTriliumClient, type TriliumClientHandle } from "../client.js";

export const CONFIG_SPEC = {
  baseUrl: { env: "TRILIUM_URL", description: "Base URL of the Trilium instance." },
  apiToken: { env: "TRILIUM_TOKEN", description: "ETAPI token (Options -> ETAPI in Trilium)." },
} as const;

// Every command resolves the client the same way -- built lazily (not at
// module load) so `tri --help` never requires TRILIUM_URL/TRILIUM_TOKEN to
// be set just to print usage.
export function resolveClientHandle(): TriliumClientHandle {
  const { baseUrl, apiToken } = requireConfig(CONFIG_SPEC);
  const trimmed = baseUrl.replace(/\/+$/, "");
  return { client: createTriliumClient({ baseUrl: trimmed, apiToken }), baseUrl: trimmed };
}
