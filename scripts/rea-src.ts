#!/usr/bin/env -S bun --conditions=source

// Spike: run REA from TypeScript sources under Bun with no build step.
// Mirrors scripts/rea.mjs routing, importing src/ instead of dist/.
const args = process.argv.slice(2);
const { default: packageJson } = await import("../package.json", {
  with: { type: "json" },
});
process.env.REA_PACKAGE_VERSION = packageJson.version;
const isMcpMode =
  args.length === 1 && (args[0] === "--mcp" || args[0] === "mcp");
const isMcpDoctorMode = args[0] === "mcp" && args[1] === "doctor";

if (isMcpMode) {
  const { runEntrypoint } = await import("../src/main.ts");
  await runEntrypoint();
} else if (isMcpDoctorMode) {
  const { runProductionMcpDoctorCli } = await import("../src/mcpDoctor.ts");
  const result = await runProductionMcpDoctorCli(args.slice(2), {
    dispatcherPath: import.meta.path,
    packageRoot: `${import.meta.dir}/..`,
  });
  process.stdout.write(result.output);
  process.exitCode = result.exitCode;
} else {
  const { cliConfigurationError, createCli } = await import("../src/cli.ts");
  const { createCliResultOutput } = await import(
    "../src/cli/cliResultOutput.ts"
  );
  const {
    renderCliOutputArgumentError,
    renderEmptyFilteredCliOutput,
    validateCliOutputArguments,
  } = await import("../src/cliOutput.ts");
  const outputArguments = validateCliOutputArguments(args);
  const configurationError = cliConfigurationError(process.env);
  if (configurationError !== undefined) {
    process.stderr.write(`${configurationError}\n`);
    process.exitCode = 1;
  } else if (!outputArguments.ok) {
    process.stdout.write(renderCliOutputArgumentError(outputArguments));
    process.exitCode = 1;
  } else {
    let wroteOutput = false;
    const resultOutput = createCliResultOutput(args, process.stdout);
    await createCli(process.env, resultOutput).serve(args, {
      stdout: (output: string) => {
        if (resultOutput?.handled) {
          if (resultOutput.failed) process.stderr.write(output);
          return;
        }
        if (output.length > 0) wroteOutput = true;
        process.stdout.write(output);
      },
    });
    if (!wroteOutput && !resultOutput?.handled)
      process.stdout.write(renderEmptyFilteredCliOutput(args) ?? "");
  }
}
