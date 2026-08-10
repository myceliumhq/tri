import {
  addSubcommand,
  CliError,
  type Command,
  EXIT_CODES,
  parseBoundedInt,
  writeJson,
} from "@myceliumhq/toolkit";
import { resolveClientHandle } from "../config.js";
import { unwrapCli } from "../etapi.js";

const MAX_POSITION = 1_000_000;

function parsePosition(raw: string | undefined): number | undefined {
  return raw === undefined
    ? undefined
    : parseBoundedInt(raw, { min: 0, max: MAX_POSITION, flag: "--position" });
}

function splitNameValue(arg: string): { name: string; value: string | undefined } {
  const eq = arg.indexOf("=");
  if (eq === -1) return { name: arg, value: undefined };
  return { name: arg.slice(0, eq), value: arg.slice(eq + 1) };
}

export function registerAttr(program: Command): void {
  const attr = addSubcommand(program, "attr")
    .summary("Note labels and relations -- list, create, update, delete.")
    .description(
      "Manage a note's attributes: labels (key-value tags) and relations (typed links to another " +
        "note). `note get` shows labels/relations already flattened for reading -- use `attr list` " +
        "instead when you need an attributeId to update or delete one.",
    );

  addSubcommand(attr, "list <noteId>")
    .summary("List a note's raw attributes, with ids.")
    .action(async (noteId: string) => {
      const { client } = resolveClientHandle();
      const note = await unwrapCli(client.GET("/notes/{noteId}", { params: { path: { noteId } } }));
      const attributes = Array.isArray(note.attributes) ? note.attributes : [];
      writeJson(
        attributes.map((a) => ({
          attributeId: a.attributeId,
          type: a.type,
          name: a.name,
          value: a.value,
          isInheritable: a.isInheritable,
        })),
      );
    });

  addSubcommand(attr, "create <noteId> <nameOrNameValue>")
    .summary("Add a label or relation to a note.")
    .description(
      "Add a label (key-value tag) or relation (typed link) to a note. Trilium allows multiple " +
        "attributes with the same name on one note, so this never overwrites an existing one -- use " +
        "`attr update` with the existing attributeId (from `attr list`) for that instead.",
    )
    .option("--type <type>", "'label' or 'relation'.", "label")
    .option("--inheritable", "Whether child notes inherit this attribute.")
    .option("--position <n>", "Display order among this note's attributes.")
    .addHelpText(
      "after",
      "\nExamples: tri attr create abc123 priority=high\n" +
        "          tri attr create abc123 author=xyz789 --type relation",
    )
    .action(
      async (
        noteId: string,
        nameOrNameValue: string,
        options: { type: string; inheritable?: boolean; position?: string },
      ) => {
        if (options.type !== "label" && options.type !== "relation") {
          throw new CliError("--type must be 'label' or 'relation'", {
            exitCode: EXIT_CODES.usage,
          });
        }
        const { name, value } = splitNameValue(nameOrNameValue);
        if (!name) {
          throw new CliError("attribute name is empty", { exitCode: EXIT_CODES.usage });
        }
        if (options.type === "relation" && !value) {
          throw new CliError("a relation requires a value: name=<target noteId>", {
            exitCode: EXIT_CODES.usage,
          });
        }

        const { client } = resolveClientHandle();
        const result = await unwrapCli(
          client.POST("/attributes", {
            body: {
              noteId,
              type: options.type,
              name,
              value,
              isInheritable: options.inheritable,
              position: parsePosition(options.position),
            },
          }),
        );
        writeJson(result);
      },
    );

  addSubcommand(attr, "update <attributeId>")
    .summary("Update an existing attribute's value or position.")
    .description(
      "Update value and/or position by id -- name/type/relation-target can't change this way; " +
        "delete and recreate instead.",
    )
    .option("--value <v>", "New value.")
    .option("--position <n>", "New display order.")
    .action(async (attributeId: string, options: { value?: string; position?: string }) => {
      if (options.value === undefined && options.position === undefined) {
        throw new CliError("nothing to update -- pass --value and/or --position", {
          exitCode: EXIT_CODES.usage,
        });
      }
      const { client } = resolveClientHandle();
      const result = await unwrapCli(
        client.PATCH("/attributes/{attributeId}", {
          params: { path: { attributeId } },
          body: { value: options.value, position: parsePosition(options.position) },
        }),
      );
      writeJson(result);
    });

  addSubcommand(attr, "del <attributeId>")
    .summary("Delete an attribute.")
    .description(
      "Delete an attribute by id. Idempotent -- ETAPI returns success even for an already-deleted " +
        "or nonexistent id, so `deleted: true` here means 'this id is not present', not 'it existed " +
        "and was just removed'.",
    )
    .action(async (attributeId: string) => {
      const { client } = resolveClientHandle();
      await unwrapCli(
        client.DELETE("/attributes/{attributeId}", { params: { path: { attributeId } } }),
      );
      writeJson({ attributeId, deleted: true });
    });
}
