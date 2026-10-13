import { readFile } from "node:fs/promises";

import { execFileOutput } from "./ExecFileOutput.js";

const KIB = 1024;

/** Sampling period of a resident-memory watchdog. */
export const RESIDENT_MEMORY_SAMPLE_MS = 100;

/** Resident set size of one process in bytes; undefined when it was not observed. */
export type ResidentMemoryReader = (pid: number) => Promise<number | undefined>;

/** Parse `VmRSS` (KiB) from a Linux `/proc/<pid>/status` document. */
export const parseLinuxResidentBytes = (status: string): number | undefined => {
  const match = /^VmRSS:\s+(\d+)\s+kB$/mu.exec(status);
  return match?.[1] === undefined ? undefined : Number(match[1]) * KIB;
};

/** Parse the KiB value printed by `ps -o rss= -p <pid>`. */
export const parsePsResidentBytes = (stdout: string): number | undefined => {
  const match = /^\s*(\d+)\s*$/u.exec(stdout);
  return match?.[1] === undefined ? undefined : Number(match[1]) * KIB;
};

const readLinuxResidentBytes: ResidentMemoryReader = async (pid) => {
  try {
    return parseLinuxResidentBytes(
      await readFile(`/proc/${String(pid)}/status`, "utf8"),
    );
  } catch {
    return undefined;
  }
};

const readDarwinResidentBytes: ResidentMemoryReader = async (pid) => {
  try {
    // Absolute path: a caller-controlled PATH must not disable the limit.
    const { stdout } = await execFileOutput(
      "/bin/ps",
      ["-o", "rss=", "-p", String(pid)],
      { timeout: 1_000 },
    );
    return parsePsResidentBytes(stdout);
  } catch {
    return undefined;
  }
};

/** This host's RSS reader, or undefined where REA cannot observe a child's RSS. */
export const residentMemoryReader = (
  platform: NodeJS.Platform = process.platform,
): ResidentMemoryReader | undefined =>
  platform === "linux"
    ? readLinuxResidentBytes
    : platform === "darwin"
      ? readDarwinResidentBytes
      : undefined;

/** Options for one resident-memory watchdog. */
export interface ResidentMemoryWatchdogOptions {
  readonly pid: number;
  readonly limitBytes: number;
  readonly read: ResidentMemoryReader;
  /**
   * Stop the over-budget process; resolve true once it is stopped. False or a
   * rejection retries on the next sample without reading memory again.
   */
  readonly onLimitReached: () => Promise<boolean>;
  readonly sampleMs?: number;
}

/**
 * Sample one process's resident set and call `onLimitReached` once a sample
 * exceeds `limitBytes`.
 *
 * This bounds a runtime that ignores V8 heap flags (Bun). It is a sampled RSS
 * limit, not a heap or commit limit: an allocation burst between two samples
 * can overshoot it, pages swapped or compressed by the OS are not counted, and
 * an unreadable sample (undefined) is skipped rather than treated as a breach.
 * Samples never overlap; `stop` cancels the next one and is idempotent.
 */
export const watchResidentMemory = (
  options: ResidentMemoryWatchdogOptions,
): { stop(): void } => {
  const sampleMs = options.sampleMs ?? RESIDENT_MEMORY_SAMPLE_MS;
  let stopped = false;
  let reached = false;
  let timer: NodeJS.Timeout | undefined;
  const schedule = (): void => {
    timer = setTimeout(() => {
      timer = undefined;
      void sample();
    }, sampleMs);
  };
  const sample = async (): Promise<void> => {
    let finished = false;
    try {
      if (!reached) {
        const bytes = await options.read(options.pid);
        reached = !stopped && bytes !== undefined && bytes > options.limitBytes;
      }
      if (reached && !stopped) finished = await options.onLimitReached();
    } catch {
      // A failed stop is retried on the next sample.
    }
    if (!stopped && !finished) schedule();
  };
  schedule();
  return {
    stop: () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
};
