import {
  buildJsonPluginConfigSchema,
  definePluginEntry,
  type OpenClawPluginApi,
  type OpenClawPluginDefinition,
} from "openclaw/plugin-sdk/plugin-entry";
import { isSecretRef } from "openclaw/plugin-sdk/secret-input";
import { resolveSecretRefValues } from "openclaw/plugin-sdk/secret-ref-runtime";
import { Type } from "typebox";
import { createTriliumClient, type TriliumClientHandle } from "./client.js";
import { createSemanticSearchHandle } from "./semantic/handle-openclaw.js";
import {
  createCreateAttachmentTool,
  createDeleteAttachmentTool,
  createGetAttachmentTool,
  createUpdateAttachmentTool,
} from "./tools/attachments.js";
import {
  createCreateAttributeTool,
  createDeleteAttributeTool,
  createUpdateAttributeTool,
} from "./tools/attributes.js";
import { createGetCalendarNoteTool } from "./tools/calendar.js";
import {
  createCreateNoteTool,
  createDeleteNoteTool,
  createGetNoteTool,
  createGetRecentChangesTool,
  createReadNoteContentTool,
  createSearchNotesTool,
  createUndeleteNoteTool,
  createUpdateNoteTool,
} from "./tools/notes.js";
import { createCreateRevisionTool, createReadRevisionContentTool } from "./tools/revisions.js";
import { createPlaceNoteInTreeTool, createRemoveNoteFromLocationTool } from "./tools/tree.js";

// Manifest-facing schema: apiToken accepts a plain string OR a SecretRef
// object, matching how other secret-capable bundled plugins (and this
// plugin's sibling, paperless-ngx) type their sensitive fields as
// `["string", "object"]` so config validation doesn't reject an unresolved
// ref at set-time. Despite the field being marked sensitive, OpenClaw does
// NOT resolve it before handing config to register() -- that has to
// happen explicitly, see resolveApiToken below.
const configSchema = Type.Object({
  baseUrl: Type.String({
    description:
      "Base URL of the Trilium instance, e.g. https://trilium.example.com (ETAPI lives under /etapi).",
  }),
  apiToken: Type.Union([Type.String(), Type.Object({}, { additionalProperties: true })], {
    description:
      "Trilium ETAPI token (Options -> ETAPI in the Trilium UI), as a plain string or a SecretRef object.",
  }),
  semanticSearch: Type.Optional(
    Type.Object({
      enabled: Type.Optional(
        Type.Boolean({
          description:
            "Enable the local semantic search index that hybridizes trilium_search_notes' `search` " +
            "results. Defaults to true; the plugin still fails open to Trilium's own lexical/" +
            "attribute-only search if the runtime/environment can't support it (e.g. Node <22.5, no " +
            "node:sqlite) even when this is left enabled.",
        }),
      ),
      indexPath: Type.Optional(
        Type.String({
          description:
            "Filesystem path for the plugin-owned SQLite+sqlite-vec index file. Defaults under " +
            "~/.openclaw/plugins/trilium/. The file is fully rebuildable from Trilium content, so it " +
            "never needs its own backup strategy beyond copying this one file.",
        }),
      ),
      // Powered by @myceliumhq/embed -- any OpenAI-compatible /v1/embeddings
      // endpoint (OpenAI, OpenRouter, Ollama, vLLM, LM Studio, ...), or an
      // opt-in local CPU model. Without baseUrl+apiKey+model+dimensions (or
      // provider: "local"), the semantic index simply never comes up and
      // trilium_search_notes stays lexical/attribute-only (fail open), same
      // as any other unavailable-backend case.
      embedding: Type.Optional(
        Type.Object({
          provider: Type.Optional(
            Type.Union([Type.Literal("openai-compatible"), Type.Literal("local")], {
              description:
                'Embedding backend to use. Defaults to "openai-compatible". "local" runs a small ' +
                "ONNX model on-CPU via @myceliumhq/embed, with zero API dependency, but is never " +
                "chosen automatically -- opt in explicitly if you want note content to never leave " +
                "the machine.",
            }),
          ),
          baseUrl: Type.Optional(
            Type.String({
              description:
                'Base URL of an OpenAI-compatible embeddings endpoint, e.g. "https://openrouter.ai/api/v1". ' +
                'Required when provider is "openai-compatible" (the default); unused for "local".',
            }),
          ),
          // Same SecretRef-or-plain-string shape as the top-level apiToken
          // above, resolved the same way (see resolveApiKeyViaOpenClaw in
          // src/semantic/handle-openclaw.ts).
          apiKey: Type.Optional(
            Type.Union([Type.String(), Type.Object({}, { additionalProperties: true })], {
              description:
                "API key for the embedding endpoint, as a plain string or a SecretRef object. " +
                "Required for semantic search to do anything with the default openai-compatible " +
                "provider -- note content is sent to that endpoint to embed it. Without this (and no " +
                'provider: "local"), trilium_search_notes silently stays lexical/attribute-only.',
            }),
          ),
          model: Type.Optional(
            Type.String({
              description:
                "Embedding model id. Required for the openai-compatible provider (models vary by " +
                'endpoint, so there\'s no universal default); optional for "local" (defaults to a ' +
                "small bundled ONNX model).",
            }),
          ),
          dimensions: Type.Optional(
            Type.Integer({
              description:
                "Embedding vector width, must match what the configured model actually produces. " +
                'Required for the openai-compatible provider; optional for "local" (defaults to 384, ' +
                "matching its default model).",
            }),
          ),
        }),
      ),
    }),
  ),
});

async function resolveApiToken(api: OpenClawPluginApi, value: unknown): Promise<string> {
  if (!isSecretRef(value)) {
    return value as string;
  }
  const resolved = await resolveSecretRefValues([value], { config: api.config });
  const [resolvedValue] = resolved.values();
  if (typeof resolvedValue !== "string") {
    throw new Error("trilium: apiToken SecretRef did not resolve to a string");
  }
  return resolvedValue;
}

// register() must be synchronous (the host throws "plugin register must be
// synchronous" otherwise), so the client can't be built eagerly there when
// apiToken might be an unresolved SecretRef needing an async lookup.
// Instead, kick off resolution here without awaiting it and hand tools the
// in-flight promise -- each tool's execute() (already async) awaits it
// once, reusing the result for every subsequent call.
function createClientHandle(api: OpenClawPluginApi): Promise<TriliumClientHandle> {
  const rawConfig = api.pluginConfig as { baseUrl: string; apiToken: unknown };
  const baseUrl = rawConfig.baseUrl.replace(/\/+$/, "");
  return resolveApiToken(api, rawConfig.apiToken).then((apiToken) => ({
    client: createTriliumClient({ baseUrl, apiToken }),
    baseUrl,
  }));
}

const entry: OpenClawPluginDefinition = definePluginEntry({
  id: "trilium",
  name: "trilium",
  description:
    "Tools for searching, reading, and editing notes in a TriliumNext instance over ETAPI -- notes, " +
    "the tree, labels/relations, attachments, revisions, and journal/calendar notes.",
  configSchema: buildJsonPluginConfigSchema(
    configSchema as unknown as Parameters<typeof buildJsonPluginConfigSchema>[0],
  ),
  register(api) {
    const handle = createClientHandle(api);
    const semanticHandle = createSemanticSearchHandle(api, handle);

    api.registerTool(createSearchNotesTool(handle, semanticHandle));
    api.registerTool(createGetNoteTool(handle));
    api.registerTool(createReadNoteContentTool(handle));
    api.registerTool(createCreateNoteTool(handle));
    api.registerTool(createUpdateNoteTool(handle));
    api.registerTool(createDeleteNoteTool(handle));
    api.registerTool(createUndeleteNoteTool(handle));
    api.registerTool(createGetRecentChangesTool(handle));

    api.registerTool(createPlaceNoteInTreeTool(handle));
    api.registerTool(createRemoveNoteFromLocationTool(handle));

    api.registerTool(createCreateAttributeTool(handle));
    api.registerTool(createUpdateAttributeTool(handle));
    api.registerTool(createDeleteAttributeTool(handle));

    api.registerTool(createCreateAttachmentTool(handle));
    api.registerTool(createGetAttachmentTool(handle));
    api.registerTool(createUpdateAttachmentTool(handle));
    api.registerTool(createDeleteAttachmentTool(handle));

    api.registerTool(createCreateRevisionTool(handle));
    api.registerTool(createReadRevisionContentTool(handle));

    api.registerTool(createGetCalendarNoteTool(handle));
  },
});

export default entry;
