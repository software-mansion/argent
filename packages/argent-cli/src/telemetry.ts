import pc from "picocolors";
import {
  init as telemetryInit,
  isEnabled as telemetryIsEnabled,
  markDisabled,
  markEnabled,
  shutdown as telemetryShutdown,
  status as telemetryStatus,
  trackImmediate,
} from "@argent/telemetry";

// Consent-management subcommands for anonymous telemetry.
export async function telemetry(args: string[]): Promise<void> {
  const sub = args[0];
  const startedAt = performance.now();
  telemetryInit("cli");

  const trackCommandComplete = async (
    subcommand: "status" | "enable" | "disable" | "help" | "unknown"
  ): Promise<void> => {
    await trackImmediate("telemetry:command_complete", {
      subcommand,
      duration_ms: performance.now() - startedAt,
    });
  };

  switch (sub) {
    case undefined:
    case "status":
      printStatus();
      await trackCommandComplete("status");
      await telemetryShutdown();
      return;
    case "enable":
      await cmdEnable(trackCommandComplete);
      return;
    case "disable":
      await cmdDisable(trackCommandComplete);
      return;
    case "--help":
    case "-h":
    case "help":
      printHelp();
      await trackCommandComplete("help");
      await telemetryShutdown();
      return;
    default:
      console.error(pc.red(`Unknown telemetry subcommand: ${sub}\n`));
      printHelp();
      await trackCommandComplete("unknown");
      await telemetryShutdown();
      process.exit(1);
  }
}

function printHelp(): void {
  console.log(`
${pc.bold("argent telemetry")} — manage anonymous opt-out telemetry

Usage: argent telemetry <subcommand>

Subcommands:
  ${pc.cyan("status")}     Show current state, anon id prefix, host, and key status
  ${pc.cyan("enable")}     Persist consent and resume sending telemetry
  ${pc.cyan("disable")}    Emit a final telemetry:opt_out event, drop in-flight queue,
              and persist consent=false

Env-var overrides (any one wins, evaluated on every track() call):
  DO_NOT_TRACK=1
  ARGENT_TELEMETRY=0
  CI environments are captured with is_ci=true unless explicitly disabled

Debug audit: ARGENT_TELEMETRY_DEBUG=1 dumps every sanitized payload to
stderr and \`~/.argent/telemetry-debug.log\`.
`);
}

function printStatus(): void {
  const s = telemetryStatus();

  const lines: string[] = [];
  lines.push(`${pc.bold("State:")}    ${s.enabled ? pc.green("enabled") : pc.yellow("disabled")}`);

  const sourceLabel =
    s.source.source === "env_do_not_track"
      ? "env DO_NOT_TRACK"
      : s.source.source === "env_argent_telemetry"
        ? "env ARGENT_TELEMETRY"
        : s.source.source === "config_file"
          ? "~/.argent/config.json"
          : "default";
  lines.push(
    `${pc.bold("Source:")}   ${sourceLabel}${s.source.detail ? ` (${s.source.detail})` : ""}`
  );

  const anonLabel = s.anonIdPrefix
    ? `${s.anonIdPrefix}…`
    : s.hasAnonIdOnDisk
      ? pc.dim("present (not shown — telemetry disabled)")
      : pc.dim("not created");
  lines.push(`${pc.bold("Anon ID:")}  ${anonLabel}`);
  lines.push(`${pc.bold("Host:")}     ${s.host}`);
  lines.push(
    `${pc.bold("Key:")}      ${s.isKeyConfigured ? pc.green("configured") : pc.dim("sentinel-disabled (this build will never send)")}`
  );
  lines.push("");
  lines.push(pc.dim("Disable: argent telemetry disable\n" + "Debug:   ARGENT_TELEMETRY_DEBUG=1"));

  console.log("");
  for (const l of lines) console.log("  " + l);
  console.log("");
}

async function cmdEnable(
  trackCommandComplete: (subcommand: "enable") => Promise<void>
): Promise<void> {
  const wasEnabled = telemetryIsEnabled();
  markEnabled();
  if (wasEnabled) {
    console.log(pc.dim("Telemetry was already enabled."));
  } else {
    console.log(pc.green("✓ Telemetry enabled."));
  }
  await trackCommandComplete("enable");
  await telemetryShutdown();
}

async function cmdDisable(
  trackCommandComplete: (subcommand: "disable") => Promise<void>
): Promise<void> {
  const wasEnabled = telemetryIsEnabled();
  if (!wasEnabled) {
    console.log(pc.dim("Telemetry was already disabled."));
    await trackCommandComplete("disable");
    await telemetryShutdown();
    return;
  }
  await trackCommandComplete("disable");
  await markDisabled();
  console.log(pc.green("✓ Telemetry disabled. In-flight events dropped, opt_out recorded."));
  await telemetryShutdown();
}
