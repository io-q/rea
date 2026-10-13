import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseLinuxResidentBytes,
  parsePsResidentBytes,
  residentMemoryReader,
  watchResidentMemory,
} from "./ResidentMemoryWatchdog.js";

const KIB = 1024;

afterEach(() => {
  vi.useRealTimers();
});

describe("resident memory sampling", () => {
  it("reads VmRSS from Linux process status in KiB", () => {
    expect(
      parseLinuxResidentBytes(
        "Name:\tbun\nVmHWM:\t  9000 kB\nVmRSS:\t  8192 kB\n",
      ),
    ).toBe(8192 * KIB);
    expect(parseLinuxResidentBytes("Name:\tzombie\nState:\tZ\n")).toBe(
      undefined,
    );
  });

  it("reads the KiB value printed by ps and rejects anything else", () => {
    expect(parsePsResidentBytes("  65536\n")).toBe(65536 * KIB);
    expect(parsePsResidentBytes("")).toBe(undefined);
    expect(parsePsResidentBytes("12 34\n")).toBe(undefined);
  });

  it("has a reader only on hosts whose child RSS REA can observe", async () => {
    expect(residentMemoryReader("linux")).toBeTypeOf("function");
    expect(residentMemoryReader("darwin")).toBeTypeOf("function");
    expect(residentMemoryReader("win32")).toBe(undefined);
    const read = residentMemoryReader();
    if (read === undefined) return;
    const bytes = await read(process.pid);
    expect(bytes).toBeGreaterThan(process.memoryUsage().rss / 2);
  });
});

describe("resident memory watchdog", () => {
  it("never stops a process whose samples stay within its limit", async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => 100);
    const onLimitReached = vi.fn(async () => true);
    const watchdog = watchResidentMemory({
      pid: 1234,
      limitBytes: 100,
      read,
      onLimitReached,
      sampleMs: 50,
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(read).toHaveBeenCalledTimes(10);
    expect(read).toHaveBeenCalledWith(1234);
    expect(onLimitReached).not.toHaveBeenCalled();
    watchdog.stop();
  });

  it("skips unreadable samples instead of treating them as a breach", async () => {
    vi.useFakeTimers();
    const onLimitReached = vi.fn(async () => true);
    const watchdog = watchResidentMemory({
      pid: 1234,
      limitBytes: 100,
      read: async () => undefined,
      onLimitReached,
      sampleMs: 50,
    });
    await vi.advanceTimersByTimeAsync(200);
    expect(onLimitReached).not.toHaveBeenCalled();
    watchdog.stop();
  });

  it("stops the process on the first sample over its limit, then stops sampling", async () => {
    vi.useFakeTimers();
    const samples = [50, 99, 101, 1_000];
    const read = vi.fn(async () => samples.shift());
    const onLimitReached = vi.fn(async () => true);
    watchResidentMemory({
      pid: 1234,
      limitBytes: 100,
      read,
      onLimitReached,
      sampleMs: 50,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(read).toHaveBeenCalledTimes(3);
    expect(onLimitReached).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries a failed stop on later samples without sampling again", async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => 200);
    const outcomes = [
      () => Promise.reject(new Error("process table unavailable")),
      () => Promise.resolve(false),
      () => Promise.resolve(true),
    ];
    const onLimitReached = vi.fn(
      () => outcomes.shift()?.() ?? Promise.resolve(true),
    );
    watchResidentMemory({
      pid: 1234,
      limitBytes: 100,
      read,
      onLimitReached,
      sampleMs: 50,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(onLimitReached).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves no timer and takes no further samples once stopped", async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => 1);
    const watchdog = watchResidentMemory({
      pid: 1234,
      limitBytes: 100,
      read,
      onLimitReached: async () => true,
      sampleMs: 50,
    });
    await vi.advanceTimersByTimeAsync(120);
    expect(read).toHaveBeenCalledTimes(2);
    watchdog.stop();
    watchdog.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("does not stop a process whose over-limit sample arrived after stop", async () => {
    vi.useFakeTimers();
    let release: ((bytes: number) => void) | undefined;
    const onLimitReached = vi.fn(async () => true);
    const watchdog = watchResidentMemory({
      pid: 1234,
      limitBytes: 100,
      read: () =>
        new Promise<number>((resolve) => {
          release = resolve;
        }),
      onLimitReached,
      sampleMs: 50,
    });
    await vi.advanceTimersByTimeAsync(50);
    watchdog.stop();
    release?.(1_000);
    await vi.advanceTimersByTimeAsync(200);
    expect(onLimitReached).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
