import { expect, it } from "vitest";
import {
  BUN_WORKER_RUNTIME_RESERVE_BYTES,
  javaScriptWorkerMemoryLimitBytes,
} from "./JavaScriptWorkerMemoryLimit.js";

const MIB = 1024 * 1024;
const bun = { node: "24.3.0", bun: "1.4.2" };
const node = { node: "24.18.0" };

it("limits a Bun worker to its heap budget plus Bun's runtime reserve", () => {
  expect(BUN_WORKER_RUNTIME_RESERVE_BYTES).toBe(512 * MIB);
  expect(javaScriptWorkerMemoryLimitBytes(192, { versions: bun })).toBe(
    704 * MIB,
  );
  expect(javaScriptWorkerMemoryLimitBytes(1024, { versions: bun })).toBe(
    1536 * MIB,
  );
});

it("applies no process limit under Node.js, whose V8 heap flags bound the worker", () => {
  expect(javaScriptWorkerMemoryLimitBytes(192, { versions: node })).toBe(null);
});
