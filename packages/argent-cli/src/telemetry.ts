import pc from "picocolors";
import {
  init as telemetryInit,
  isEnabled as telemetryIsEnabled,
  markDisabled,
  markEnabled,
  shutdown as telemetryShutdown,
  status as telemetryStatus,
} from "@argent/telemetry";

// Consent-management subcommands for anonymous telemetry.
export async function telemetry(args: string[]): Promise<void> {
  const sub = args[0];
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
      await cmdEnable();
      return;
    case "disable":
      await cmdDisable();
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
  argent telemetry status    Show telemetry state and anonymous id
  argent telemetry enable    Enable telemetry
  argent telemetry disable   Disable telemetry
`);
}

function printStatus(): void {
  const s = telemetryStatus();

  const anonLabel = s.anonIdPrefix
    ? `${s.anonIdPrefix}...`
    : s.hasAnonIdOnDisk
      ? "present"
      : "not created";

  console.log("telemetry:");
  console.log(`  state:   ${s.enabled ? "enabled" : "disabled"}`);
  console.log(`  anon id: ${anonLabel}`);
}

async function cmdEnable(): Promise<void> {
  const wasEnabled = telemetryIsEnabled();
  markEnabled();
  if (wasEnabled) {
    console.log(pc.dim("Telemetry was already enabled."));
  } else {
    console.log(pc.green("Telemetry enabled."));
  }
  await telemetryShutdown();
}

async function cmdDisable(): Promise<void> {
  const wasEnabled = telemetryIsEnabled();
  if (!wasEnabled) {
    console.log(pc.dim("Telemetry was already disabled."));
    await telemetryShutdown();
    return;
  }
  await markDisabled();
  console.log(pc.red("Telemetry disabled."));
  await telemetryShutdown();
}
