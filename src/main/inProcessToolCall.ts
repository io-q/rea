import {
  Client,
  InMemoryTransport,
  type CallToolResult,
} from "@modelcontextprotocol/client";

import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import { parseConfig } from "../config/parseConfig.js";
import { createBinarySession } from "../composition/binary.js";
import {
  createOptionalObservationFactories,
  loadOptionalObservationProviders,
} from "../composition/optionalObservationProviders.js";
import { createLogger } from "../logger.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import { createToolResultDelivery } from "../server/toolResult.js";
import { MCP_SHUTDOWN_FAILED } from "./messages.js";
import { createShutdown } from "./shutdown.js";
import { openInitialTarget } from "./startup.js";
import { startMcpTransport } from "./transport.js";
import type { RuntimeDependencies } from "./types.js";

// setTimeout's ceiling; a one-shot call is bounded by the tool, not the client.
const UNBOUNDED_REQUEST_TIMEOUT_MS = 2_147_483_647;

/** Outcome of one tools/call made against a freshly composed MCP server. */
export type InProcessToolCallOutcome =
  | {
      readonly ok: true;
      readonly result: CallToolResult;
      /** Session/provider cleanup failed after the call; reported on stderr. */
      readonly cleanupFailed: boolean;
    }
  | { readonly ok: false; readonly message: string };

/**
 * Compose the MCP server exactly as `main.ts` does (config, binary session,
 * initial target, optional providers, Android provider, result delivery),
 * connect it to an in-process client over a linked in-memory transport, make
 * one `tools/call`, then run the MCP shutdown path. Nothing persists: every
 * call is a fresh session, so retained Evidence IDs do not survive the call.
 */
export const callToolInProcess = async (
  name: string,
  arguments_: Readonly<Record<string, unknown>>,
  options: {
    readonly env: NodeJS.ProcessEnv;
    readonly signal?: AbortSignal;
    readonly writeStderr: (text: string) => void;
  },
): Promise<InProcessToolCallOutcome> => {
  const environment = snapshotEnvironment(options.env);
  const config = parseConfig(environment);
  if (!config.ok)
    return { ok: false, message: projectAnalysisError(config.error).message };
  // MCP logs at info by default; the CLI stays silent unless asked.
  const logger = createLogger(
    "cli",
    environment.REA_LOG_LEVEL === undefined ? "silent" : config.value.logLevel,
  );
  const serverLogger = logger.child({ layer: "server" });
  const session = createBinarySession(config.value, logger, environment);
  const opened = await openInitialTarget(
    session,
    config.value,
    serverLogger,
    options.writeStderr,
  );
  if (!opened.ok)
    return { ok: false, message: "The configured initial target failed." };

  let connection: Promise<Client> | undefined;
  const dependencies: RuntimeDependencies = {
    env: options.env,
    // Stand-in for serveStdio: one server instance, one linked client.
    serve: (factory) => {
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      const client = new Client({
        name: `${PRODUCT_IDENTITY.cliBinary}-cli`,
        version: PRODUCT_IDENTITY.packageVersion,
      });
      connection = (async () => {
        const server = await factory({ era: "legacy" });
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        return client;
      })();
      return { close: () => client.close() };
    },
    writeStderr: options.writeStderr,
    // The CLI command owns interrupts and awaits shutdown itself, so the
    // signal-driven shutdown request (the only setExitCode caller) never runs.
    setExitCode: () => undefined,
    registerShutdown: () => () => undefined,
  };
  const transport = await startMcpTransport(dependencies, session, {
    logger,
    serverLogger,
    environment,
    delivery: createToolResultDelivery(config.value.mcpMaxResponseBytes),
    loadOptionalProviders: () =>
      loadOptionalObservationProviders(
        createOptionalObservationFactories(environment),
      ),
  });
  if (!transport.ok)
    return { ok: false, message: "The in-process MCP server did not start." };
  const { shutdown } = createShutdown({
    handle: transport.handle,
    closeAndroid: transport.closeAndroid,
    closeOptionalProviders: transport.closeOptionalProviders,
    session,
    dependencies,
    serverLogger,
  });
  let result: CallToolResult;
  let cleanupFailed = false;
  try {
    if (connection === undefined)
      throw new Error("The in-process MCP server was not constructed");
    const client = await connection;
    result = await client.callTool(
      { name, arguments: { ...arguments_ } },
      {
        timeout: UNBOUNDED_REQUEST_TIMEOUT_MS,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
  } finally {
    await shutdown().catch(() => {
      cleanupFailed = true;
      options.writeStderr(`${MCP_SHUTDOWN_FAILED}\n`);
    });
  }
  return { ok: true, result, cleanupFailed };
};
