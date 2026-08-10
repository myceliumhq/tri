#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createProgram, runProgram } from "@myceliumhq/toolkit";
import { registerAttach } from "./commands/attach.js";
import { registerAttr } from "./commands/attr.js";
import { registerDoctor } from "./commands/doctor.js";
import { registerJournal } from "./commands/journal.js";
import { registerNote } from "./commands/note.js";
import { registerSearch } from "./commands/search.js";
import { registerTree } from "./commands/tree.js";

// Read directly from this package's own package.json (two levels up from
// dist/cli/index.js) rather than hardcoding a version string here that
// would silently drift from the published package version.
const packageJsonPath = fileURLToPath(new URL("../../package.json", import.meta.url));
const { version } = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version: string };

const program = createProgram(
  "tri",
  "Trilium CLI for agents -- search, read, and write notes over ETAPI.",
  version,
);
registerSearch(program);
registerNote(program);
registerTree(program);
registerJournal(program);
registerAttach(program);
registerAttr(program);
registerDoctor(program);

runProgram(program, process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
