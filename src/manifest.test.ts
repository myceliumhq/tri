import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import manifest from "../openclaw.plugin.json" with { type: "json" };
import entry from "./index.js";

// Same guard as @transmitt0r/openclaw-plugin-paperless-ngx's manifest.test.ts:
// calls the plugin's real register() against a fake api, the same as
// OpenClaw itself does at startup, so a tool registered in index.ts but
// missing from openclaw.plugin.json's contracts.tools (or vice versa) --
// which would leave it silently unavailable to the agent -- fails this
// test instead of shipping unnoticed.
describe("openclaw.plugin.json contracts.tools", () => {
  it("matches every tool index.ts actually registers", () => {
    const registered: string[] = [];
    const api = {
      pluginConfig: { baseUrl: "https://trilium.example.com", apiToken: "test-token" },
      registerTool: (tool: { name: string }) => {
        registered.push(tool.name);
      },
      lifecycle: { registerRuntimeLifecycle: () => {} },
    } as unknown as OpenClawPluginApi;

    if (!entry.register) throw new Error("test setup: entry.register is not defined");
    entry.register(api);

    expect(registered).toHaveLength(manifest.contracts.tools.length);
    expect(new Set(registered)).toEqual(new Set(manifest.contracts.tools));
  });
});
