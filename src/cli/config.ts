import { CliError, EXIT_CODES, loadConfig, requireConfig } from "@myceliumhq/toolkit";
import { createTriliumClient, type TriliumClientHandle } from "../client.js";

export const CONFIG_SPEC = {
  baseUrl: { env: "TRILIUM_URL", description: "Base URL of the Trilium instance." },
  apiToken: { env: "TRILIUM_TOKEN", description: "ETAPI token (Options -> ETAPI in Trilium)." },
  revisionInterval: {
    env: "TRILIUM_REVISION_INTERVAL",
    required: false,
    description: "Minimum time between automatic note revisions (for example, 5m).",
  },
} as const;

const DEFAULT_REVISION_INTERVAL_MS = 5 * 60 * 1000;

export function resolveRevisionInterval(): number | undefined {
  const raw = loadConfig(CONFIG_SPEC).revisionInterval?.trim();
  if (raw === undefined || raw === "") return DEFAULT_REVISION_INTERVAL_MS;
  if (raw === "0" || raw.toLowerCase() === "off") return undefined;

  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(raw);
  if (!match) {
    throw new CliError(
      `invalid TRILIUM_REVISION_INTERVAL: ${raw} (use a duration such as 5m, 30s, 0, or off)`,
      { exitCode: EXIT_CODES.usage },
    );
  }

  const value = Number(match[1]);
  const multiplier = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
    match[2] as "ms" | "s" | "m" | "h" | "d"
  ];
  const interval = value * multiplier;
  if (!Number.isFinite(interval)) {
    throw new CliError(`invalid TRILIUM_REVISION_INTERVAL: ${raw}`, { exitCode: EXIT_CODES.usage });
  }
  return interval;
}

// Every command resolves the client the same way -- built lazily (not at
// module load) so `tri --help` never requires TRILIUM_URL/TRILIUM_TOKEN to
// be set just to print usage.
export function resolveClientHandle(): TriliumClientHandle {
  const { baseUrl, apiToken } = requireConfig(CONFIG_SPEC);
  const trimmed = baseUrl.replace(/\/+$/, "");
  return { client: createTriliumClient({ baseUrl: trimmed, apiToken }), baseUrl: trimmed };
}
