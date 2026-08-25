import pc from "picocolors";
import type { FlagScope } from "@argent/configuration-core";
import {
  init as telemetryInit,
  isEnabled as telemetryIsEnabled,
  markDisabled,
  markEnabled,
  shutdown as telemetryShutdown,
  status as telemetryStatus,
} from "@argent/telemetry";

// Telemetry is opt-out: on by default.
export async function telemetry(args: string[]): Promise<void> {
  const sub = args[0];
  let scope: FlagScope;
  try {
    scope = parseScope(args.slice(1));
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(2);
  }
  telemetryInit("cli");

  switch (sub) {
    case undefined:
      printUsage();
      await telemetryShutdown();
      return;
    case "status":
      printStatus();
      await telemetryShutdown();
      return;
    case "enable":
      await cmdEnable(scope);
      return;
    case "disable":
      await cmdDisable(scope);
      return;
    case "--help":
    case "-h":
      printUsage();
      await telemetryShutdown();
      return;
    default:
      console.error(`Unknown subcommand: telemetry ${sub}`);
      await telemetryShutdown();
      process.exit(1);
  }
}

function printUsage(): void {
  console.log(`Usage:
  argent telemetry status                             Show telemetry state and device id
  argent telemetry enable  [--scope global|project]   Enable telemetry
  argent telemetry disable [--scope global|project]   Disable telemetry

The default scope is global (~/.argent/config.json). \`--scope project\` writes
<project-root>/.argent/config.json instead — commit it and telemetry stays off
for everyone who clones the repository. \`false\` in either scope wins.
`);
}

// `--scope <s>` / `--scope=<s>`; anything else is rejected so a typo cannot
// silently land in the wrong document.
function parseScope(rest: string[]): FlagScope {
  let scope: FlagScope = "global";
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    let value: string | undefined;
    if (arg === "--scope") value = rest[++i];
    else if (arg.startsWith("--scope=")) value = arg.slice("--scope=".length);
    else throw new Error(`unknown argument "${arg}".`);
    if (value !== "global" && value !== "project") {
      throw new Error(`--scope must be "global" or "project" (got "${value ?? ""}").`);
    }
    scope = value;
  }
  return scope;
}

function scopeLabel(scope: FlagScope): string {
  return scope === "project" ? "project scope" : "global scope";
}

function printStatus(): void {
  const s = telemetryStatus();

  const idLabel = s.anonIdPrefix
    ? `${s.anonIdPrefix}...`
    : s.hasAnonIdOnDisk
      ? "present"
      : "not created";

  console.log("telemetry:");
  console.log(`  state:     ${s.enabled ? "enabled" : "disabled"}`);
  console.log(`  source:    ${describeSource(s.source)}`);
  console.log(`  device id: ${idLabel}`);
}

function describeSource(source: ReturnType<typeof telemetryStatus>["source"]): string {
  switch (source.source) {
    case "env_do_not_track":
    case "env_argent_telemetry":
      return `environment (${source.detail ?? source.source})`;
    case "config_file":
      return source.detail ?? "config.json";
    case "session_override":
      return "this session";
    case "default":
      return "default (no opt-out set)";
  }
}

async function cmdEnable(scope: FlagScope): Promise<void> {
  const wasEnabled = telemetryIsEnabled();
  markEnabled(scope);
  const nowEnabled = telemetryIsEnabled();
  if (!nowEnabled) {
    // The other scope (or an env override) still says no — restrictive merge.
    console.log(
      pc.yellow(
        `Telemetry set to enabled at ${scopeLabel(scope)}, but it stays disabled: ` +
          `${describeSource(telemetryStatus().source)} still opts out.`
      )
    );
  } else if (wasEnabled) {
    console.log(pc.dim(`Telemetry was already enabled (written at ${scopeLabel(scope)}).`));
  } else {
    console.log(pc.green(`Telemetry enabled (${scopeLabel(scope)}).`));
  }
  await telemetryShutdown();
}

async function cmdDisable(scope: FlagScope): Promise<void> {
  const wasEnabled = telemetryIsEnabled();
  // Still write when already off: a global opt-out and a committed project
  // opt-out are different guarantees, and the user asked for this one.
  await markDisabled(scope);
  if (!wasEnabled) {
    console.log(pc.dim(`Telemetry was already disabled (written at ${scopeLabel(scope)}).`));
  } else {
    console.log(pc.red(`Telemetry disabled (${scopeLabel(scope)}).`));
  }
  await telemetryShutdown();
}
