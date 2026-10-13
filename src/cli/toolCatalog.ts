import type { ToolContract, ToolKind } from "../contracts/toolContractTypes.js";
import type { ToolEffects } from "../contracts/toolEffects.js";
import {
  toolInputSchemaWithMetadata,
  toolOutputSchemaWithMetadata,
} from "../contracts/toolSchemaMetadata.js";

// The MCP SDK projects every registered schema with this target.
const JSON_SCHEMA_TARGET = "draft-2020-12";

/** One discovery line: a tool name and the first sentence of its description. */
export interface ToolSummary {
  readonly name: string;
  readonly summary: string;
}

/** First sentence of a contract description, so discovery stays one line per tool. */
const summarize = (description: string): string => {
  const line = description.split("\n", 1)[0] ?? "";
  const sentence = /^.*?[.!?](?=\s|$)/u.exec(line)?.[0] ?? line;
  return sentence.trim();
};

/** Group contracts by adapter kind, optionally narrowed by kind or a case-insensitive substring. */
export const groupToolSummaries = (
  contracts: readonly ToolContract[],
  filter: { readonly kind?: ToolKind; readonly query?: string } = {},
): Readonly<Partial<Record<ToolKind, readonly ToolSummary[]>>> => {
  const query = filter.query?.toLowerCase();
  const groups: Partial<Record<ToolKind, ToolSummary[]>> = {};
  for (const contract of contracts) {
    if (filter.kind !== undefined && contract.kind !== filter.kind) continue;
    if (
      query !== undefined &&
      ![contract.name, contract.title, contract.description].some((text) =>
        text.toLowerCase().includes(query),
      )
    )
      continue;
    (groups[contract.kind] ??= []).push({
      name: contract.name,
      summary: summarize(contract.description),
    });
  }
  return groups;
};

/**
 * Every effect a tool declares (all but idempotence). The list is empty
 * exactly when MCP advertises the tool as `readOnlyHint`.
 */
export const declaredEffects = (effects: ToolEffects): readonly string[] =>
  Object.entries(effects)
    .filter(([name, value]) => name !== "idempotent" && value === true)
    .map(([name]) => name);

/** A one-shot `call` session dies with its process, so session effects need no consent. */
const ONE_SHOT_IGNORED_EFFECTS: ReadonlySet<string> = new Set([
  "mutatesSession",
]);

/** Effect names a caller can allow, derived from the audited contract effects. */
export const allowableEffectNames = (
  contracts: readonly ToolContract[],
): readonly string[] =>
  [
    ...new Set(
      contracts.flatMap(({ effects }) =>
        Object.entries(effects)
          .filter(([, value]) => typeof value === "boolean")
          .map(([name]) => name),
      ),
    ),
  ].filter(
    (name) => name !== "idempotent" && !ONE_SHOT_IGNORED_EFFECTS.has(name),
  );

/** Declared effects a one-shot call needs explicit consent for, minus those allowed. */
export const missingEffects = (
  effects: ToolEffects,
  allowed: ReadonlySet<string>,
): readonly string[] =>
  declaredEffects(effects).filter(
    (name) => !ONE_SHOT_IGNORED_EFFECTS.has(name) && !allowed.has(name),
  );

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The JSON Schema the MCP server advertises for one side of a contract. */
const advertisedJsonSchema = (
  schema: ToolContract["inputSchema"],
  io: "input" | "output",
): Record<string, unknown> => {
  const projected: unknown = schema["~standard"].jsonSchema[io]({
    target: JSON_SCHEMA_TARGET,
  });
  if (!isRecord(projected))
    throw new TypeError(`Tool ${io} schema did not project to an object`);
  // The SDK stamps an object root on typeless input schemas (e.g. unions).
  return io === "input" && projected.type === undefined
    ? { type: "object", ...projected }
    : projected;
};

/** Everything an agent needs to call one tool; the large output schema is opt-in. */
export const describeToolContract = (
  contract: ToolContract,
  options: { readonly outputSchema?: boolean } = {},
) => {
  const effects = declaredEffects(contract.effects);
  return {
    name: contract.name,
    title: contract.title,
    kind: contract.kind,
    description: contract.description,
    read_only: contract.annotations.readOnlyHint,
    effects,
    idempotent: contract.effects.idempotent,
    annotations: contract.annotations,
    returns_target_content: contract.returnsTargetContent,
    // Matches the MCP tools/list projection, including its advertised examples.
    input_schema: advertisedJsonSchema(
      toolInputSchemaWithMetadata(contract),
      "input",
    ),
    ...(options.outputSchema === true
      ? {
          output_schema: advertisedJsonSchema(
            toolOutputSchemaWithMetadata(contract),
            "output",
          ),
        }
      : {}),
  };
};
