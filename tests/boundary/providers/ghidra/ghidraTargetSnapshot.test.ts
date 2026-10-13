import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

import { createGhidraTargetSnapshot } from "../../../../src/ghidra/GhidraTargetSnapshot.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Ghidra target snapshot", () => {
  it("refuses to overwrite an existing snapshot", async () => {
    const root = await createTestTempDirectory("rea-ghidra-platform-");
    roots.push(root);
    const source = join(root, "source.exe");
    const bytes = Buffer.from("platform fixture");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(source, bytes);
    const snapshot = await createGhidraTargetSnapshot(source, root, sha256);
    expect(snapshot.admission).toBeUndefined();
    await expect(readFile(snapshot.path)).resolves.toEqual(bytes);
    await expect(
      createGhidraTargetSnapshot(source, root, sha256),
    ).rejects.toMatchObject({ code: "EEXIST" });
    await expect(readFile(snapshot.path)).resolves.toEqual(bytes);
  });
});
