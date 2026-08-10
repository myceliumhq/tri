import type { SourceAdapter } from "@myceliumhq/index";
import { createTriliumClient } from "./client.js";
import { createTriliumSourceAdapter } from "./semantic/source-adapter.js";

// Public entrypoint for external hosts (a generic semanticd sidecar) that
// want to sync this source.
export { createTriliumClient, type TriliumClient, type TriliumClientConfig } from "./client.js";
export { createTriliumSourceAdapter } from "./semantic/source-adapter.js";

// Zero-argument factory matching semanticd's adapter-loader convention
// (SEMANTICD_ADAPTER_EXPORT defaults to "createAdapter") -- reads its own
// connection config from TRILIUM_URL/TRILIUM_TOKEN so semanticd itself
// never has to know this source exists, let alone how to configure it.
export function createAdapter(): SourceAdapter<string> {
  const baseUrl = process.env.TRILIUM_URL;
  const apiToken = process.env.TRILIUM_TOKEN;
  if (!baseUrl || !apiToken) {
    throw new Error("trilium semantic-adapter: missing TRILIUM_URL and/or TRILIUM_TOKEN");
  }
  const client = createTriliumClient({ baseUrl, apiToken });
  return createTriliumSourceAdapter(Promise.resolve(client));
}
