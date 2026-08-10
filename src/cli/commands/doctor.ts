import {
  addSubcommand,
  CliError,
  type Command,
  EXIT_CODES,
  requireConfig,
  runDoctorChecks,
} from "@myceliumhq/toolkit";
import { CONFIG_SPEC, resolveClientHandle } from "../config.js";
import { unwrapCli } from "../etapi.js";

export function registerDoctor(program: Command): void {
  addSubcommand(program, "doctor")
    .description("Check config and connectivity.")
    .action(async () => {
      const code = await runDoctorChecks([
        {
          name: "config (TRILIUM_URL, TRILIUM_TOKEN)",
          run: async () => {
            requireConfig(CONFIG_SPEC);
          },
        },
        {
          name: "connect to Trilium ETAPI",
          run: async () => {
            const { client } = resolveClientHandle();
            await unwrapCli(
              client.GET("/notes", {
                params: { query: { search: "note.noteId = 'root'", limit: 1 } },
              }),
            );
          },
        },
      ]);
      if (code !== EXIT_CODES.ok) {
        throw new CliError("doctor checks failed", { exitCode: code });
      }
    });
}
