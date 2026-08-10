import { readFileSync } from "node:fs";
import { CliError, EXIT_CODES } from "@myceliumhq/toolkit";

// Every write-path command (note write, note append, ...) reads content the
// same way: from --file, or from stdin when it's piped. Never as a bare
// positional/flag value -- large or binary-adjacent content belongs in a
// file/pipe, not command-line args (shell quoting limits, and it would
// otherwise show up in shell history/process listings).
//
// A resolved-but-empty source (an empty file, a pipe from a filter that
// matched nothing) is rejected unless allowEmpty is set -- `write` has no
// undo, so a silent empty write would wipe a note's content with zero
// warning on a scripted/piped invocation that produced no bytes by
// accident.
export function readContentInput(
  filePath: string | undefined,
  usageCommand: string,
  options: { allowEmpty?: boolean } = {},
): string {
  let content: string;
  if (filePath !== undefined) {
    content = readFileSync(filePath, "utf8");
  } else if (process.stdin.isTTY) {
    throw new CliError("no content given", {
      exitCode: EXIT_CODES.usage,
      fix: `pass --file <path> or pipe content in, see: ${usageCommand} --help`,
    });
  } else {
    content = readFileSync(0, "utf8");
  }

  if (content === "" && !options.allowEmpty) {
    throw new CliError("content is empty", {
      exitCode: EXIT_CODES.usage,
      fix: "pass --allow-empty to write/append empty content intentionally",
    });
  }
  return content;
}
