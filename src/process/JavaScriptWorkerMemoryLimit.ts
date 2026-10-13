import { javaScriptRuntime } from "../domain/runtimeVersion.js";

const MIB = 1024 * 1024;

/**
 * Memory reserved for Bun itself above a worker's heap budget.
 *
 * Measured first as Windows Job Object commit (Bun 1.4.2): the source-map
 * codec, HAR decoder and JavaScript analysis worker committed up to 368 MiB
 * on a trivial input because JavaScriptCore commits parsed and compiled module
 * code and per-thread runtime state. Their resident set is smaller (the idle
 * analysis worker is about 62 MiB RSS on macOS arm64, Bun 1.4.3), so 512 MiB
 * also leaves room for JavaScriptCore objects being larger than V8's, keeping
 * a workload that fits the V8 heap budget from being killed under Bun.
 */
export const BUN_WORKER_RUNTIME_RESERVE_BYTES = 512 * MIB;

/** Runtime facts that decide whether V8 heap flags bound a worker. */
export interface JavaScriptWorkerHost {
  readonly versions: {
    readonly node: string;
    readonly bun?: string | undefined;
  };
}

/**
 * Process memory limit for a JavaScript worker launched on `process.execPath`.
 *
 * Node.js enforces each worker's V8 heap flags, so it receives no process
 * limit (null) and its launch is unchanged. Bun ignores those flags; its
 * worker instead receives the heap budget plus Bun's runtime reserve, which
 * the owned launcher enforces as a parent-sampled resident-set (RSS) limit.
 */
export const javaScriptWorkerMemoryLimitBytes = (
  heapBudgetMiB: number,
  host: JavaScriptWorkerHost = process,
): number | null =>
  javaScriptRuntime(host.versions).id === "bun"
    ? heapBudgetMiB * MIB + BUN_WORKER_RUNTIME_RESERVE_BYTES
    : null;
