/**
 * `argent providers check` — a conformance checker for the external device
 * provider contract.
 *
 * It exists so a third party implementing the contract can verify their
 * descriptor and `/devices` endpoint against the same validators the
 * tool-server runs at runtime.
 *
 * Everything it reports is either a hard `error` (argent would reject this) or
 * a `warning` (argent accepts it, but it is probably not what you meant). Only
 * errors affect the exit code.
 */

import * as fs from "node:fs";
import pc from "picocolors";
import {
  EXTERNAL_CAPABILITIES,
  type ProviderDevice,
  PROVIDER_SCHEMA_VERSION,
  providerRecordSchema,
  providersDirectory,
} from "@argent/tool-server/dist/utils/external-devices.js";

type Finding = {
  level: "error" | "warning";
  message: string;
};

type ProviderReport = {
  deviceCount: number;
  findings: Finding[];
  /** Absent when the descriptor never parsed far enough to have an identity. */
  id?: string;
  name?: string;
  /** Path of the descriptor that was checked. */
  source: string;
};

const KNOWN_CAPABILITIES = new Set<string>(EXTERNAL_CAPABILITIES);
const PROBE_TIMEOUT_MS = 5_000;

function error(message: string): Finding {
  return { level: "error", message };
}

function warn(message: string): Finding {
  return { level: "warning", message };
}

/** Prove something is listening. */
async function isReachable(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    await fetch(url, { method: "GET", signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Check the devices a descriptor declares. The descriptor has already been
 * validated against `providerRecordSchema`, so the shape is known good here.
 * What is left is everything a schema cannot express.
 */
async function checkDevices(devices: ProviderDevice[], findings: Finding[]): Promise<number> {
  if (devices.length === 0) {
    findings.push(
      warn("the device list is empty — nothing to attach to (boot a device and re-run)")
    );
  }

  const seenNativeIds = new Set<string>();

  for (const device of devices) {
    const label = `device '${device.nativeId}'`;

    if (seenNativeIds.has(device.nativeId)) {
      findings.push(error(`${label}: listed more than once`));
    }

    seenNativeIds.add(device.nativeId);

    for (const capability of device.capabilities) {
      if (!KNOWN_CAPABILITIES.has(capability)) {
        findings.push(
          warn(
            `${label}: capability '${capability}' is not in this argent version's vocabulary ` +
              `and will be ignored`
          )
        );
      }
    }

    if (device.capabilities.length === 0) {
      findings.push(
        warn(`${label}: declares no capabilities, so argent can list it but do nothing with it`)
      );
    }

    if (device.simulatorServer) {
      if (!(await isReachable(device.simulatorServer.apiUrl))) {
        findings.push(
          error(
            `${label}: \`simulatorServer.apiUrl\` ${device.simulatorServer.apiUrl} is not listening — ` +
              `argent's liveness probe would drop this device from list-devices`
          )
        );
      }
    }

    if (device.capabilities.includes("simctl")) {
      if (!device.deviceSet) {
        findings.push(
          warn(
            `${label}: declares 'simctl' with no deviceSet — argent will run simctl against the ` +
              `DEFAULT device set, which is correct only if this simulator really lives there`
          )
        );
      } else {
        try {
          fs.accessSync(device.deviceSet, fs.constants.R_OK);
        } catch {
          findings.push(
            error(`${label}: deviceSet '${device.deviceSet}' is not readable by this user`)
          );
        }
      }
    }

    if (device.jsDebugger && !device.capabilities.includes("js-debugger")) {
      findings.push(
        warn(
          `${label}: publishes a jsDebugger socket but does not declare 'js-debugger', so argent ` +
            `will never attach to it`
        )
      );
    }

    if (device.capabilities.includes("js-debugger")) {
      if (!device.jsDebugger) {
        findings.push(
          warn(
            `${label}: declares 'js-debugger' with no jsDebugger socket — argent will connect to ` +
              `metro directly, which evicts any debugger you already have on this runtime ` +
              `(react native allows one per device). Publish a socket you multiplex, or withhold ` +
              `the capability while you are debugging`
          )
        );
      }

      if (device.metroPort === undefined) {
        findings.push(
          warn(
            `${label}: declares 'js-debugger' with no metroPort — argent will fall back to 8081, ` +
              `which is correct only if this device's Metro really listens there`
          )
        );
      } else if (!(await isReachable(`http://127.0.0.1:${device.metroPort}/status`))) {
        findings.push(
          warn(
            `${label}: nothing is answering Metro's /status on port ${device.metroPort} — ` +
              `every debugger-* call for this device would fail until it is`
          )
        );
      }
    }

    if (device.nativeDevtools && !device.capabilities.includes("native-devtools")) {
      findings.push(
        warn(
          `${label}: publishes a nativeDevtools socket but does not declare 'native-devtools', ` +
            `so argent will never attach to it`
        )
      );
    }

    if (device.capabilities.includes("native-devtools")) {
      if (device.platform !== "ios") {
        findings.push(
          error(`${label}: 'native-devtools' is an iOS-only capability in this argent version`)
        );
      } else if (!device.nativeDevtools) {
        findings.push(
          error(
            `${label}: declares 'native-devtools' with no nativeDevtools socket — argent would ` +
              `arm its own injection, overwriting the simulator-wide DYLD_INSERT_LIBRARIES and ` +
              `agent endpoint you set. Re-serve your agent connection, or withhold the capability`
          )
        );
      } else {
        try {
          fs.accessSync(device.nativeDevtools.socketPath, fs.constants.R_OK | fs.constants.W_OK);
        } catch {
          findings.push(
            error(
              `${label}: nativeDevtools socket '${device.nativeDevtools.socketPath}' is not ` +
                `readable and writable by this user, so argent cannot attach to it`
            )
          );
        }
      }
    }

    if (device.platform === "android" && device.capabilities.includes("simctl")) {
      findings.push(error(`${label}: 'simctl' is an iOS-only capability`));
    }
    if (device.platform === "ios" && device.capabilities.includes("adb")) {
      findings.push(error(`${label}: 'adb' is an Android-only capability`));
    }
  }

  return devices.length;
}

async function checkDescriptorFile(file: string, expectedVersion: number): Promise<ProviderReport> {
  const findings: Finding[] = [];
  const report: ProviderReport = { deviceCount: 0, findings, source: file };

  let raw: string;

  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    findings.push(error(`unreadable: ${e instanceof Error ? e.message : String(e)}`));
    return report;
  }

  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(raw);
  } catch (e) {
    findings.push(error(`not valid JSON: ${e instanceof Error ? e.message : String(e)}`));
    return report;
  }

  const version = (parsedJson as { schemaVersion?: unknown } | null)?.schemaVersion;

  if (version !== expectedVersion) {
    findings.push(
      error(
        `schemaVersion is ${JSON.stringify(version)}; argent understands ${expectedVersion} ` +
          `and would skip this provider entirely`
      )
    );
    return report;
  }

  const parsed = providerRecordSchema.safeParse(parsedJson);

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      findings.push(error(`${issue.path.join(".") || "(root)"}: ${issue.message}`));
    }
    return report;
  }

  const record = parsed.data;

  report.id = record.id;
  report.name = record.name;

  if (!record.supportUrl) {
    findings.push(
      warn(
        "no supportUrl — failures on your devices will name you but give the user nowhere to " +
          "report them, so they will land in argent's tracker instead"
      )
    );
  }

  if (!record.workspace) {
    findings.push(
      warn(
        "no workspace — agents cannot tell which project your devices belong to when more than " +
          "one provider instance is running"
      )
    );
  }

  report.deviceCount = await checkDevices(record.devices, findings);

  return report;
}

function printHelp(): void {
  console.log(`
Usage: argent providers check [options]

Validate external device providers against the argent provider contract
(schema version ${PROVIDER_SCHEMA_VERSION}). With no options it checks every descriptor in
${providersDirectory()}.

Options:
  --file <path>            Check a single descriptor instead of every one in
                           the providers directory. Useful in CI, where the
                           descriptor is written to a sandbox.
  --schema-version <n>     Contract version to validate against (default ${PROVIDER_SCHEMA_VERSION}).
  --json                   Emit a machine-readable report on stdout.
  --help, -h               Show this message.

Exits 0 when every checked provider is conformant, 1 when any error was found,
and 2 on a usage error.
`);
}

interface ParsedArgs {
  /**
   * Check only this descriptor, instead of everything in the providers
   * directory.
   */
  file?: string;
  json: boolean;
  schemaVersion: number;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { json: false, schemaVersion: PROVIDER_SCHEMA_VERSION };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;

    if (token === "--json") {
      parsed.json = true;
    } else if (token === "--file") {
      const value = argv[++i];
      if (!value) throw new Error("--file requires a value");
      parsed.file = value;
    } else if (token.startsWith("--file=")) {
      parsed.file = token.slice("--file=".length);
    } else if (token === "--schema-version") {
      const value = argv[++i];
      if (!value) throw new Error("--schema-version requires a value");
      parsed.schemaVersion = Number.parseInt(value, 10);
    } else if (token.startsWith("--schema-version=")) {
      parsed.schemaVersion = Number.parseInt(token.slice("--schema-version=".length), 10);
    } else {
      throw new Error(`Unknown argument: "${token}"`);
    }
  }

  if (!Number.isInteger(parsed.schemaVersion)) {
    throw new Error("--schema-version must be an integer");
  }

  return parsed;
}

function discoverDescriptorFiles(): string[] {
  try {
    return fs
      .readdirSync(providersDirectory())
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => `${providersDirectory()}/${name}`);
  } catch {
    return [];
  }
}

function printHuman(reports: ProviderReport[]): void {
  const color = process.stdout.isTTY;

  const dim = (s: string) => (color ? pc.dim(s) : s);
  const green = (s: string) => (color ? pc.green(s) : s);
  const red = (s: string) => (color ? pc.red(s) : s);
  const yellow = (s: string) => (color ? pc.yellow(s) : s);

  for (const report of reports) {
    const title = report.name ? `${report.name} (${report.id})` : report.source;

    console.log(`\n${title}`);
    console.log(dim(`  source:  ${report.source}`));
    console.log(dim(`  devices: ${report.deviceCount}`));

    if (report.findings.length === 0) {
      console.log(`  ${green("conformant")}`);
      continue;
    }

    for (const finding of report.findings) {
      const tag = finding.level === "error" ? red("error  ") : yellow("warning");
      console.log(`  ${tag} ${finding.message}`);
    }
  }
}

/**
 * `argent providers <subcommand>`. Only `check` exists today; the subcommand
 * layer is here so adding e.g. `providers list` later doesn't change the shape
 * of the command users have already learned.
 */
export async function providers(argv: string[]): Promise<void> {
  const [subcommand, ...rest] = argv;

  if (subcommand === undefined || subcommand === "--help" || subcommand === "-h") {
    printHelp();
    if (subcommand === undefined) process.exit(2);
    return;
  }

  if (subcommand !== "check") {
    console.error(`Unknown subcommand: "${subcommand}"`);
    printHelp();
    process.exit(2);
  }

  if (rest.includes("--help") || rest.includes("-h")) {
    printHelp();
    return;
  }

  let args: ParsedArgs;

  try {
    args = parseArgs(rest);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
    return;
  }

  const reports: ProviderReport[] = [];

  if (args.file) {
    reports.push(await checkDescriptorFile(args.file, args.schemaVersion));
  } else {
    const files = discoverDescriptorFiles();

    if (files.length === 0) {
      const message = `No provider descriptors found in ${providersDirectory()}.`;

      if (args.json) {
        console.log(JSON.stringify({ note: message, ok: true, providers: [] }, null, 2));
      } else {
        console.log(message);
      }

      return;
    }

    for (const file of files) {
      reports.push(await checkDescriptorFile(file, args.schemaVersion));
    }
  }

  /**
   * Two live providers sharing an id is unresolvable at runtime. Argent keeps
   * the first file and ignores the rest, so it is an error rather than a note.
   */
  const byId = new Map<string, ProviderReport[]>();

  for (const report of reports) {
    if (!report.id) continue;
    const bucket = byId.get(report.id) ?? [];
    bucket.push(report);
    byId.set(report.id, bucket);
  }

  for (const [id, bucket] of byId) {
    if (bucket.length < 2) continue;

    for (const report of bucket) {
      report.findings.push(
        error(
          `provider id '${id}' is claimed by ${bucket.length} descriptors ` +
            `(${bucket.map((report) => report.source).join(", ")}); argent keeps only the first`
        )
      );
    }
  }

  const errorCount = reports.reduce(
    (total, report) =>
      total + report.findings.filter((finding) => finding.level === "error").length,
    0
  );

  if (args.json) {
    console.log(
      JSON.stringify(
        { ok: errorCount === 0, providers: reports, schemaVersion: args.schemaVersion },
        null,
        2
      )
    );
  } else {
    printHuman(reports);

    console.log(`\n${reports.length} provider(s) checked, ${errorCount} error(s).`);
  }

  if (errorCount > 0) process.exit(1);
}
