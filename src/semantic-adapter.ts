import type { SourceAdapter } from "@myceliumhq/index";
import { createTriliumClient } from "./client.js";
import { createTriliumSourceAdapter } from "./semantic/source-adapter.js";

// Public entrypoint for external hosts that want to sync this source --
// bin/semanticd.ts passes createAdapter()'s return value straight into
// @myceliumhq/semanticd's runSemanticd().
export { createTriliumClient, type TriliumClient, type TriliumClientConfig } from "./client.js";
export { createTriliumSourceAdapter } from "./semantic/source-adapter.js";

// Zero-argument factory returning a ready SourceAdapter -- reads its own
// connection config from TRILIUM_URL/TRILIUM_TOKEN so the caller never has
// to know this source exists, let alone how to configure it.
export function createAdapter(): SourceAdapter<string> {
  const baseUrl = process.env.TRILIUM_URL;
  const apiToken = process.env.TRILIUM_TOKEN;
  if (!baseUrl || !apiToken) {
    throw new Error("trilium semantic-adapter: missing TRILIUM_URL and/or TRILIUM_TOKEN");
  }
  const client = createTriliumClient({ baseUrl, apiToken });
  return createTriliumSourceAdapter(Promise.resolve(client));
}
