import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import {
  describeModel,
  planFeature,
  writeFeature,
  type Metadata,
} from "./scaffold.js";

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "dry-run": { type: "boolean" },
      write: { type: "boolean" },
      help: { type: "boolean" },
      public: { type: "string" },
      create: { type: "string" },
      owner: { type: "string" },
      query: { type: "string" },
      mutation: { type: "string" },
      select: { type: "string" },
    },
  });
  if (values.help) {
    console.log(
      "scaffold <Model> [--dry-run | --write] [--public id,name --create name --owner ownerId --query notes --mutation createNote --select id,name]\nWithout all choices, an interactive terminal is required. --write applies explicit choices without another prompt; --dry-run prints the source without writing.",
    );
    return;
  }
  if (positionals.length !== 1 || (values.write && values["dry-run"]))
    throw new Error(
      "Supply one model and at most one of --dry-run / --write. See --help.",
    );
  const model = positionals[0];
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const metadata = JSON.parse(
    readFileSync(
      resolve(root, "packages/database/src/generated/contract.json"),
      "utf8",
    ),
  ) as Metadata;
  const description = describeModel(metadata, model);
  const terminal = process.stdin.isTTY
    ? createInterface({ input: process.stdin, output: process.stdout })
    : undefined;
  async function answer(
    provided: string | undefined,
    question: string,
    fallback?: string,
  ) {
    if (provided !== undefined) return provided;
    if (!terminal)
      throw new Error(
        `Missing choice: ${question}. Pass every choice as a flag in non-interactive use.`,
      );
    return (
      (
        await terminal.question(
          `${question}${fallback ? ` [${fallback}]` : ""}: `,
        )
      ).trim() ||
      fallback ||
      ""
    );
  }
  const list = (value: string) =>
    value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
  try {
    console.log(
      `Fields on ${model}: ${Object.keys(description.model.fields).join(", ")}\nRecipe: user-owned list/create; all selected public fields are non-null. Business validation remains yours to customize.`,
    );
    const publicFields = list(
      await answer(
        values.public,
        "Public fields (comma separated; ownership stays private)",
      ),
    );
    const choices = {
      model,
      publicFields,
      createFields: list(
        await answer(values.create, "Create fields (comma separated)"),
      ),
      owner: await answer(
        values.owner,
        "Owner foreign key referencing User.id",
        description.owners.length === 1 ? description.owners[0] : undefined,
      ),
      query: await answer(values.query, "Query name", description.repository),
      mutation: await answer(
        values.mutation,
        "Mutation name",
        `create${model}`,
      ),
      selection: list(
        await answer(
          values.select,
          "Screen fields (comma separated)",
          publicFields.join(","),
        ),
      ),
    };
    const changes = planFeature(root, metadata, choices);
    console.log(
      `Public: ${choices.publicFields.join(", ")}\nWithheld: ${Object.keys(
        description.model.fields,
      )
        .filter((name) => !choices.publicFields.includes(name))
        .join(", ")}\nOwnership: ${choices.owner} from the session user's id`,
    );
    for (const change of changes)
      console.log(
        `\n--- ${change.before === null ? "Create" : "Update"} ${change.path}\n${change.after}`,
      );
    if (values["dry-run"]) return;
    if (
      !values.write &&
      (await answer(undefined, "Write this source? Type yes")).toLowerCase() !==
        "yes"
    )
      return;
    writeFeature(root, changes);
    console.log(
      "Created ordinary application source. Review validation and public fields, then run npm run contract and npm run verify. No migration was applied.",
    );
  } finally {
    terminal?.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
