import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Filesystem coordinates for one provider-owned private runtime directory. */
export interface PrivateRuntimeRootOptions {
  readonly parent?: string;
  readonly prefix?: string;
}

/** Provider-neutral security status for one runtime-root implementation. */
export type PrivateRuntimeRootCapability =
  | {
      readonly available: true;
      readonly reason: null;
      readonly proof: "posix-mkdtemp-owner-only";
    }
  | { readonly available: false; readonly reason: string };

/** Report whether this process can establish a private runtime root. */
export const privateRuntimeRootCapability =
  (): PrivateRuntimeRootCapability => ({
    available: true,
    reason: null,
    proof: "posix-mkdtemp-owner-only",
  });

/** Expected failure when a runtime root's privacy boundary is unavailable. */
export class PrivateRuntimeRootUnavailableError extends Error {
  readonly code = "private-runtime-root-authority-unavailable";

  constructor(message: string) {
    super(message);
    this.name = "PrivateRuntimeRootUnavailableError";
  }
}

/**
 * Owns a private temporary runtime root and removes it idempotently.
 *
 * Protocol adapters decide what belongs inside the directory; this primitive
 * establishes a private filesystem boundary on POSIX and deterministic cleanup.
 */
export class PrivateRuntimeRoot {
  #closePromise: Promise<void> | undefined;

  private constructor(readonly path: string) {}

  /** Allocate a new private runtime root without performing protocol work. */
  static async create(
    options: PrivateRuntimeRootOptions = {},
  ): Promise<PrivateRuntimeRoot> {
    const path = await mkdtemp(
      join(options.parent ?? tmpdir(), options.prefix ?? "rea-provider-"),
    );
    // POSIX mkdtemp establishes owner-only access atomically. Return its owner
    // without a fallible permission rewrite and rollback after allocation.
    return new PrivateRuntimeRoot(path);
  }

  /**
   * Remove the runtime root; concurrent callers share one attempt. A failed
   * attempt is not cached, so a later close retries the removal.
   */
  close(): Promise<void> {
    this.#closePromise ??= rm(this.path, {
      recursive: true,
      force: true,
    }).catch((cause: unknown) => {
      this.#closePromise = undefined;
      throw cause;
    });
    return this.#closePromise;
  }
}
