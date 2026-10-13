import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createCli } from "../../../src/cli.js";
import {
  allowableEffectNames,
  declaredEffects,
  describeToolContract,
  groupToolSummaries,
  missingEffects,
} from "../../../src/cli/toolCatalog.js";
import { createBinarySession } from "../../../src/composition/binary.js";
import { parseConfig } from "../../../src/config/parseConfig.js";
import { TOOL_CONTRACTS } from "../../../src/contracts/toolContracts.js";
import { silentLogger } from "../../../src/logger.js";
import { createServer } from "../../../src/server/createServer.js";
import {
  createTestWorkspace,
  removeTestWorkspace,
  type TestWorkspace,
} from "../../support/workspace/workspaceFixture.js";

const RECORDED_UNKNOWN = {
  question: "Does the alternate branch execute?",
  severity: "medium",
  domain: "control-flow",
  required_authority: "controlled-replay",
  required_confidence: "observed",
  required_environment: null,
  recommended_probes: [],
  relationships: [],
};

interface Served {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly json: unknown;
}

let workspace: TestWorkspace;
beforeAll(async () => {
  workspace = await createTestWorkspace("rea-cli-tool-contracts-");
});
afterAll(async () => {
  await removeTestWorkspace(workspace.root);
});

// Only structural validity is asserted; formats are advisory annotations here.
const compileSchema = (schema: Record<string, unknown>) =>
  new Ajv2020({ strict: false, validateFormats: false }).compile(schema);

const environment = (): NodeJS.ProcessEnv => ({ ...workspace.environment });

/** Serve one in-process invocation; logCliCommand reports failure via process.exitCode. */
const serve = async (
  argv: readonly string[],
  extraEnvironment: NodeJS.ProcessEnv = {},
): Promise<Served> => {
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  let stdout = "";
  let exitCode = 0;
  try {
    await createCli({ ...environment(), ...extraEnvironment }).serve(
      [...argv, "--json"],
      {
        env: {},
        exit: (code) => {
          exitCode = code;
        },
        stdout: (text) => {
          stdout += text;
        },
      },
    );
    const processExitCode = Number(process.exitCode ?? 0);
    return {
      stdout,
      stderr: stderr.mock.calls.map(([text]) => String(text)).join(""),
      exitCode: exitCode === 0 ? processExitCode : exitCode,
      json: JSON.parse(stdout) as unknown,
    };
  } finally {
    stderr.mockRestore();
    process.exitCode = previousExitCode;
  }
};

describe("tool discovery", () => {
  it("groups every contract exactly once under its own kind", () => {
    const groups = groupToolSummaries(TOOL_CONTRACTS);
    const listed = Object.entries(groups).flatMap(([kind, tools]) =>
      tools.map((tool) => ({ kind, ...tool })),
    );
    expect(listed.map(({ name }) => name).sort()).toEqual(
      TOOL_CONTRACTS.map(({ name }) => name).sort(),
    );
    for (const { kind, name, summary } of listed) {
      expect(TOOL_CONTRACTS.find((c) => c.name === name)?.kind).toBe(kind);
      expect(summary.length).toBeGreaterThan(0);
      expect(summary).not.toContain("\n");
    }
  });

  it("filters by kind and by case-insensitive substring", () => {
    expect(
      Object.keys(groupToolSummaries(TOOL_CONTRACTS, { kind: "session" })),
    ).toEqual(["session"]);
    const sqlite = groupToolSummaries(TOOL_CONTRACTS, { query: "SQLITE" });
    expect(
      Object.values(sqlite)
        .flat()
        .map(({ name }) => name),
    ).toContain("inspect_sqlite_database");
  });

  it("lists the whole catalog through the CLI", async () => {
    const result = await serve(["tools"]);
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({ tool_count: TOOL_CONTRACTS.length });
  });
});

describe("tool description", () => {
  it("projects a valid JSON Schema for every contract's input", () => {
    for (const contract of TOOL_CONTRACTS) {
      const described = describeToolContract(contract);
      expect(described.name).toBe(contract.name);
      expect(described).not.toHaveProperty("output_schema");
      expect(described.input_schema.type).toBe("object");
      expect(() => compileSchema(described.input_schema)).not.toThrow();
    }
  });

  it("includes the output schema only on request", async () => {
    const result = await serve([
      "describe",
      "list_unknowns",
      "--output-schema",
    ]);
    expect(result.exitCode).toBe(0);
    const { output_schema: schema } = result.json as {
      output_schema: Record<string, unknown>;
    };
    expect(() => compileSchema(schema)).not.toThrow();
  });

  it("declares no effects exactly for MCP readOnlyHint tools", () => {
    for (const contract of TOOL_CONTRACTS)
      expect(declaredEffects(contract.effects).length === 0).toBe(
        contract.annotations.readOnlyHint,
      );
  });

  it("derives allowable effects from contracts and ignores session effects", () => {
    const names = allowableEffectNames(TOOL_CONTRACTS);
    expect(names).not.toContain("mutatesSession");
    expect(names).not.toContain("idempotent");
    for (const contract of TOOL_CONTRACTS) {
      const required = missingEffects(contract.effects, new Set());
      expect(required).toEqual(
        declaredEffects(contract.effects).filter(
          (name) => name !== "mutatesSession",
        ),
      );
      expect(missingEffects(contract.effects, new Set(names))).toEqual([]);
    }
  });

  it("reports an unknown tool name", async () => {
    const result = await serve(["describe", "no_such_tool"]);
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({ error: { code: "UNKNOWN_TOOL" } });
  });
});

describe("tool calls match the MCP server", () => {
  let mcp: Client;
  let closeServer: () => Promise<void>;

  beforeAll(async () => {
    const config = parseConfig(environment());
    if (!config.ok) throw config.error;
    const session = createBinarySession(
      config.value,
      silentLogger,
      environment(),
    );
    const server = createServer(
      { kind: "session", session },
      { logger: silentLogger, environment: environment() },
    );
    mcp = new Client({ name: "tool-contract-cli-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await mcp.connect(clientTransport);
    closeServer = async () => {
      await mcp.close();
      await server.close();
      await session.close();
    };
  });
  afterAll(async () => {
    await closeServer();
  });

  it("describes each input schema exactly as tools/list advertises it", async () => {
    const { tools } = await mcp.listTools();
    expect(tools).toHaveLength(TOOL_CONTRACTS.length);
    for (const tool of tools) {
      const contract = TOOL_CONTRACTS.find(({ name }) => name === tool.name);
      if (contract === undefined) throw new Error(`Unknown ${tool.name}`);
      expect(describeToolContract(contract).input_schema).toEqual(
        tool.inputSchema,
      );
    }
  });

  it("returns the MCP structured result and surfaces the target-content marker", async () => {
    const direct = await mcp.callTool({ name: "list_unknowns", arguments: {} });
    expect(direct._meta).toMatchObject({
      provenance: { untrusted_content: true },
    });
    const result = await serve(["call", "list_unknowns", "{}"]);
    expect(result.exitCode).toBe(0);
    expect(result.json).toEqual(direct.structuredContent);
    expect(result.stderr).toContain("untrusted target content");
  });

  it("runs a session-only tool with no flag", async () => {
    const result = await serve([
      "call",
      "record_unknown",
      JSON.stringify(RECORDED_UNKNOWN),
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({
      result: { unknown_id: expect.any(String) },
    });
  });

  it("refuses naming only the missing effect and the flag that allows it", async () => {
    const result = await serve([
      "call",
      "inspect_sqlite_database",
      "{}",
      "--allow-effects",
      "writesFilesystem",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.json).toEqual({
      error: expect.objectContaining({
        code: "EFFECTS_NOT_ALLOWED",
        tool: "inspect_sqlite_database",
        missing_effects: ["launchesProcess"],
        allow_flag: "--allow-effects=launchesProcess",
      }),
    });
  });

  it("refuses every non-session effect when no flag is given", async () => {
    const result = await serve(["call", "inspect_sqlite_database", "{}"]);
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      error: {
        missing_effects: ["writesFilesystem", "launchesProcess"],
        allow_flag: "--allow-effects=writesFilesystem,launchesProcess",
      },
    });
  });

  for (const flags of [
    ["--allow-effects", "writesFilesystem,launchesProcess"],
    [
      "--allow-effects",
      "launchesProcess",
      "--allow-effects",
      "writesFilesystem",
    ],
  ])
    it(`passes the gate when all non-session effects are named (${flags.join(" ")})`, async () => {
      // An empty input passes the gate and is then rejected by the tool itself.
      const result = await serve([
        "call",
        "inspect_sqlite_database",
        "{}",
        ...flags,
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.json).toMatchObject({ error: expect.anything() });
      expect(JSON.stringify(result.json)).not.toContain("EFFECTS_NOT_ALLOWED");
    });

  it("rejects an unknown effect name and lists the valid ones", async () => {
    const result = await serve([
      "call",
      "list_unknowns",
      "{}",
      "--allow-effects",
      "launchesProcess,everything",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      error: {
        code: "INVALID_EFFECT_NAME",
        invalid: ["everything"],
        valid_effects: allowableEffectNames(TOOL_CONTRACTS),
      },
    });
  });

  it("rejects malformed JSON input before starting a server", async () => {
    const result = await serve(["call", "list_unknowns", "{nope"]);
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      error: {
        code: "INVALID_INPUT",
        message: expect.stringContaining("not valid JSON"),
      },
    });
  });

  it("rejects JSON input that is not an object", async () => {
    const result = await serve(["call", "list_unknowns", "[1]"]);
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      error: {
        code: "INVALID_INPUT",
        message: expect.stringContaining("object"),
      },
    });
  });
});

describe("tool call effect consent", () => {
  it("requires consent for binary_session's provider availability probes", async () => {
    const result = await serve(["call", "binary_session", "{}"]);
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      error: {
        code: "EFFECTS_NOT_ALLOWED",
        missing_effects: ["launchesProcess"],
      },
    });
  });
});

describe("tool call initial-target consent", () => {
  const target = (): NodeJS.ProcessEnv => ({
    HOPPER_TARGET_PATH: `${workspace.root}/target.bin`,
  });

  it("requires open_binary's effects when HOPPER_TARGET_PATH opens a target", async () => {
    // current_address declares only mutatesSession, but a configured initial
    // target is opened (launching the provider) before the tool runs.
    const refused = await serve(["call", "current_address", "{}"], target());
    expect(refused.exitCode).toBe(1);
    expect(refused.json).toMatchObject({
      error: {
        code: "EFFECTS_NOT_ALLOWED",
        missing_effects: ["writesFilesystem", "launchesProcess"],
        allow_flag: "--allow-effects=writesFilesystem,launchesProcess",
        opens_initial_target: true,
      },
    });
  });

  it("passes the gate once the open effects are named", async () => {
    const result = await serve(
      [
        "call",
        "current_address",
        "{}",
        "--allow-effects",
        "writesFilesystem,launchesProcess",
      ],
      target(),
    );
    expect(result.json).not.toMatchObject({
      error: { code: "EFFECTS_NOT_ALLOWED" },
    });
  });

  it("adds no open effects without a valid initial-target configuration", async () => {
    for (const extra of [{}, { ...target(), HOPPER_TARGET_KIND: "bogus" }]) {
      const result = await serve(["call", "current_address", "{}"], extra);
      expect(result.json).not.toMatchObject({
        error: { code: "EFFECTS_NOT_ALLOWED" },
      });
    }
  });
});
