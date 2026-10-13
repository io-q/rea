import { join, posix } from "node:path";

import { describe, expect, it } from "vitest";

import { ghidraHeadlessArguments } from "../../../../src/ghidra/GhidraLauncher.js";

const expectOptions = (
  arguments_: readonly string[],
  options: readonly (readonly [string, string])[],
): void => {
  for (const [flag, value] of options) {
    const index = arguments_.indexOf(flag);
    expect(index, flag).toBeGreaterThanOrEqual(0);
    expect(arguments_[index + 1], flag).toBe(value);
  }
};

describe("Ghidra COM loader", () => {
  it("loads explicit COM at its PSP-relative entry before auto-analysis", () => {
    const arguments_ = ghidraHeadlessArguments({
      projectRoot: "/tmp/project",
      targetPath: "/tmp/target.com",
      bridgeScriptPath: "/package/bridge/ReaGhidraBridge.java",
      descriptorPath: "/tmp/session.json",
      ghidraLogPath: "/tmp/ghidra.log",
      scriptLogPath: "/tmp/script.log",
      dosCom: true,
    });
    expectOptions(arguments_, [
      ["-loader", "BinaryLoader"],
      ["-loader-baseAddr", "1000:0100"],
      ["-processor", "x86:LE:16:Real Mode"],
      ["-cspec", "default"],
    ]);
    const prepare = arguments_.indexOf("-preScript");
    expect(arguments_[prepare + 1]).toBe(
      join("/package/bridge", "ReaGhidraPrepareCom.java"),
    );
    expect(prepare).toBeLessThan(arguments_.indexOf("-postScript"));
    expect(arguments_).toContain("-readOnly");
    expect(arguments_).toContain("-deleteProject");
  });
});

describe("Ghidra raw-binary loader", () => {
  it("loads caller-supplied architecture and entry before auto-analysis", () => {
    const arguments_ = ghidraHeadlessArguments({
      projectRoot: "/tmp/project",
      targetPath: "/tmp/ecu.bin",
      bridgeScriptPath: "/package/bridge/ReaGhidraBridge.java",
      descriptorPath: "/tmp/session.json",
      ghidraLogPath: "/tmp/ghidra.log",
      scriptLogPath: "/tmp/script.log",
      rawBinary: {
        languageId: "ARM:LE:32:v7",
        compilerSpecId: "default",
        baseAddr: "0x8000000",
      },
    });
    expectOptions(arguments_, [
      ["-loader", "BinaryLoader"],
      ["-loader-baseAddr", "0x8000000"],
      ["-processor", "ARM:LE:32:v7"],
      ["-cspec", "default"],
    ]);
    const prepare = arguments_.indexOf("-preScript");
    expect(arguments_[prepare + 1]).toBe(
      join("/package/bridge", "ReaGhidraPrepareRaw.java"),
    );
    expect(arguments_[prepare + 2]).toBe("ARM:LE:32:v7");
    expect(arguments_[prepare + 3]).toBe("0x8000000");
    expect(prepare).toBeLessThan(arguments_.indexOf("-postScript"));
    expect(arguments_).toContain("-readOnly");
    expect(arguments_).toContain("-deleteProject");
  });
});

describe("Ghidra headless launcher", () => {
  it("forces the admitted real-mode language and loader for DOS MZ", () => {
    const arguments_ = ghidraHeadlessArguments({
      projectRoot: "/tmp/project",
      targetPath: "/tmp/target",
      bridgeScriptPath: "/package/bridge/ReaGhidraBridge.java",
      descriptorPath: "/tmp/session.json",
      ghidraLogPath: "/tmp/ghidra.log",
      scriptLogPath: "/tmp/script.log",
      dosMz: true,
    });
    expectOptions(arguments_, [
      ["-loader", "MzLoader"],
      ["-processor", "x86:LE:16:Real Mode"],
      ["-cspec", "default"],
    ]);
    expect(arguments_).toContain("-readOnly");
    expect(arguments_).toContain("-deleteProject");
  });
  it("builds a read-only ephemeral import with its bridge descriptor", () => {
    const arguments_ = ghidraHeadlessArguments({
      projectRoot: "/tmp/project",
      targetPath: "/tmp/target",
      bridgeScriptPath: "/package/bridge/ReaGhidraBridge.java",
      descriptorPath: "/tmp/session.json",
      ghidraLogPath: "/tmp/ghidra.log",
      scriptLogPath: "/tmp/script.log",
    });
    expect(arguments_.slice(0, 2)).toEqual(["/tmp/project", "rea-project"]);
    expectOptions(arguments_, [
      ["-import", "/tmp/target"],
      ["-log", "/tmp/ghidra.log"],
      ["-scriptlog", "/tmp/script.log"],
      ["-scriptPath", "/package/bridge"],
      ["-postScript", "/package/bridge/ReaGhidraNoReturnFix.java"],
    ]);
    // The no-return repair must finish before the bridge starts serving.
    const fix = arguments_.indexOf("/package/bridge/ReaGhidraNoReturnFix.java");
    const bridge = arguments_.indexOf("/package/bridge/ReaGhidraBridge.java");
    expect(fix).toBeLessThan(bridge);
    expect(arguments_[bridge + 1]).toBe("/tmp/session.json");
    expect(arguments_).toContain("-readOnly");
    expect(arguments_).toContain("-deleteProject");
  });
  it("remaps soft-float storage after the no-return fix and before the bridge", () => {
    const base = {
      platform: "linux" as const,
      projectRoot: "/tmp/project",
      targetPath: "/tmp/target",
      bridgeScriptPath: "/package/bridge/ReaGhidraBridge.java",
      descriptorPath: "/tmp/session.json",
      ghidraLogPath: "/tmp/ghidra.log",
      scriptLogPath: "/tmp/script.log",
    };
    const soft = "/package/bridge/ReaGhidraMipsSoftFloat.java";
    expect(ghidraHeadlessArguments(base)).not.toContain(soft);
    const arguments_ = ghidraHeadlessArguments({
      ...base,
      mipsSoftFloat: true,
    });
    expect(arguments_[arguments_.indexOf(soft) - 1]).toBe("-postScript");
    expect(
      arguments_.indexOf("/package/bridge/ReaGhidraNoReturnFix.java"),
    ).toBeLessThan(arguments_.indexOf(soft));
    expect(arguments_.indexOf(soft)).toBeLessThan(
      arguments_.indexOf("/package/bridge/ReaGhidraBridge.java"),
    );
    for (const conflict of [
      { psp: true as const },
      { dosMz: true as const },
      { dosCom: true as const },
      {
        rawBinary: {
          languageId: "x86:LE:32:default",
          compilerSpecId: "default",
          baseAddr: "0x1000",
        },
      },
    ])
      expect(() =>
        ghidraHeadlessArguments({ ...base, mipsSoftFloat: true, ...conflict }),
      ).toThrow(/generic MIPS ELF/u);
  });
});

describe("Ghidra configured import language and seeds", () => {
  const base = {
    platform: "darwin" as const,
    projectRoot: "/tmp/project",
    targetPath: "/tmp/target",
    bridgeScriptPath: "/package/bridge/ReaGhidraBridge.java",
    descriptorPath: "/tmp/session.json",
    ghidraLogPath: "/tmp/ghidra.log",
    scriptLogPath: "/tmp/script.log",
  };

  it("passes a configured language and compiler spec to the import", () => {
    const arguments_ = ghidraHeadlessArguments({
      ...base,
      languageOverride: {
        languageId: "x86:LE:32:default",
        compilerSpecId: "borlandcpp",
      },
    });
    expectOptions(arguments_, [
      ["-processor", "x86:LE:32:default"],
      ["-cspec", "borlandcpp"],
    ]);
    expect(arguments_).not.toContain("-loader");
    expect(arguments_.indexOf("-processor")).toBeGreaterThan(
      arguments_.indexOf("-import"),
    );
  });

  it("lets Ghidra choose the language default compiler spec", () => {
    const arguments_ = ghidraHeadlessArguments({
      ...base,
      languageOverride: { languageId: "x86:LE:32:default" },
    });
    expectOptions(arguments_, [["-processor", "x86:LE:32:default"]]);
    expect(arguments_).not.toContain("-cspec");
  });

  it("never combines a configured language with a DOS import", () => {
    expect(() =>
      ghidraHeadlessArguments({
        ...base,
        dosMz: true,
        languageOverride: { languageId: "x86:LE:32:default" },
      }),
    ).toThrow(/cannot be combined with a DOS import/u);
  });

  it("never combines a configured language with a raw-binary import", () => {
    expect(() =>
      ghidraHeadlessArguments({
        ...base,
        languageOverride: { languageId: "x86:LE:32:default" },
        rawBinary: {
          languageId: "ARM:LE:32:v7",
          compilerSpecId: "default",
          baseAddr: "0x8000000",
        },
      }),
    ).toThrow(/cannot be combined with a raw-binary import/u);
  });

  it("applies seeds after loader preparation and before analysis scripts", () => {
    const path = posix;
    const bridgeDirectory = path.join("/package", "bridge");
    const seedPath = path.join("/tmp/runtime/seeds", "seeds.tsv");
    const arguments_ = ghidraHeadlessArguments({
      ...base,
      bridgeScriptPath: path.join(bridgeDirectory, "ReaGhidraBridge.java"),
      dosCom: true,
      seedPath,
    });
    const prepare = arguments_.indexOf(
      path.join(bridgeDirectory, "ReaGhidraPrepareCom.java"),
    );
    const seeds = arguments_.indexOf(
      path.join(bridgeDirectory, "ReaGhidraApplySeeds.java"),
    );
    expect(prepare).toBeGreaterThanOrEqual(0);
    expect(arguments_[seeds - 1]).toBe("-preScript");
    expect(arguments_[seeds + 1]).toBe(seedPath);
    expect(prepare).toBeLessThan(seeds);
    expect(seeds).toBeLessThan(arguments_.indexOf("-postScript"));
  });

  it("adds no seed script without a seed snapshot", () => {
    expect(ghidraHeadlessArguments(base)).not.toContain(
      posix.join("/package/bridge", "ReaGhidraApplySeeds.java"),
    );
  });
});

describe("Ghidra disabled analyzers", () => {
  const base = {
    platform: "darwin" as const,
    projectRoot: "/tmp/project",
    targetPath: "/tmp/target",
    bridgeScriptPath: "/package/bridge/ReaGhidraBridge.java",
    descriptorPath: "/tmp/session.json",
    ghidraLogPath: "/tmp/ghidra.log",
    scriptLogPath: "/tmp/script.log",
  };

  it("applies the analyzer options after seeds and before analysis scripts", () => {
    const arguments_ = ghidraHeadlessArguments({
      ...base,
      dosCom: true,
      seedPath: posix.join("/tmp/runtime/seeds", "seeds.tsv"),
      disabledAnalyzers: [
        "Objective-C Message Analyzer",
        "Decompiler Switch Analysis",
      ],
    });
    const options = arguments_.indexOf(
      posix.join("/package/bridge", "ReaGhidraAnalysisOptions.java"),
    );
    expect(arguments_[options - 1]).toBe("-preScript");
    expect(arguments_[options + 1]).toBe(
      "Objective-C Message Analyzer,Decompiler Switch Analysis",
    );
    const prepare = arguments_.indexOf(
      posix.join("/package/bridge", "ReaGhidraPrepareCom.java"),
    );
    const seeds = arguments_.indexOf(
      posix.join("/package/bridge", "ReaGhidraApplySeeds.java"),
    );
    expect(prepare).toBeLessThan(seeds);
    expect(seeds).toBeLessThan(options);
    expect(options).toBeLessThan(arguments_.indexOf("-postScript"));
  });

  it("uses the bridge directory for the options script", () => {
    const path = posix;
    const arguments_ = ghidraHeadlessArguments({
      ...base,
      bridgeScriptPath: path.join("/package", "bridge", "ReaGhidraBridge.java"),
      disabledAnalyzers: ["Objective-C Message Analyzer"],
    });
    const options = arguments_.indexOf(
      path.join("/package", "bridge", "ReaGhidraAnalysisOptions.java"),
    );
    expect(arguments_[options - 1]).toBe("-preScript");
    expect(arguments_[options + 1]).toBe("Objective-C Message Analyzer");
    expect(options).toBeLessThan(arguments_.indexOf("-postScript"));
  });

  it("keeps the invocation byte-identical without an override", () => {
    expect(ghidraHeadlessArguments(base)).toEqual([
      "/tmp/project",
      "rea-project",
      "-import",
      "/tmp/target",
      "-readOnly",
      "-deleteProject",
      "-log",
      "/tmp/ghidra.log",
      "-scriptlog",
      "/tmp/script.log",
      "-scriptPath",
      "/package/bridge",
      "-postScript",
      "/package/bridge/ReaGhidraNoReturnFix.java",
      "-postScript",
      "/package/bridge/ReaGhidraBridge.java",
      "/tmp/session.json",
    ]);
  });

  it("adds no analyzer script for an empty override", () => {
    expect(
      ghidraHeadlessArguments({ ...base, disabledAnalyzers: [] }),
    ).not.toContain(
      posix.join("/package/bridge", "ReaGhidraAnalysisOptions.java"),
    );
  });
});
