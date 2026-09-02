/**
 * The conformance checker behind `argent providers check`.
 *
 * It exists so a third party implementing the contract can verify their
 * descriptor and `/devices` endpoint against the same validators the
 * tool-server runs at runtime.
 *
 * Everything it reports is either a hard `error` (argent would reject this) or
 * a `warning` (argent accepts it, but it is probably not what you meant). Only
 * errors affect the exit code.
 *
 * {@linkcode parseDescriptorDocument} is the half `argent providers publish`
 * shares, so the two commands cannot disagree about what is publishable.
 */

import * as fs from "node:fs";
import pc from "picocolors";
import {
  EXTERNAL_CAPABILITIES,
  nativeIdPlatform,
  type ProviderDevice,
  type ProviderRecordStrict,
  providerRecordSchema,
} from "@argent/device-providers";

export type Finding = {
  level: "error" | "warning";
  message: string;
};

export type ProviderReport = {
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

export function error(message: string): Finding {
  return { level: "error", message };
}

function warn(message: string): Finding {
  return { level: "warning", message };
}

/** Prove something is listening. */
export async function isReachable(url: string): Promise<boolean> {
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

    /**
     * The tool-server classifies a native id by its shape and drops any device
     * whose declared platform disagrees, because the alternative is handing an
     * adb serial to `xcrun`. It says so on its own stderr, which nobody reading
     * a CI log for this command ever sees, so the device would simply be absent
     * with a green check behind it. Same question, asked where the provider
     * author is looking.
     */
    const shape = nativeIdPlatform(device.nativeId);

    if (shape !== device.platform) {
      findings.push(
        error(
          `${label}: declares platform '${device.platform}' but its nativeId has the shape of ` +
            `${shape === "ios" ? "an iOS udid" : "an android serial"}, so argent would ignore ` +
            `this device entirely`
        )
      );
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

/**
 * Parse and strictly validate a descriptor document: JSON, schema version, then
 * `providerRecordSchema`. Everything a document must survive to be published or
 * checked, and nothing that needs the network or the filesystem.
 *
 * Shared with `argent providers publish` so there is one implementation of the
 * question and the two commands cannot drift apart.
 */
type DescriptorParse =
  | { findings: Finding[]; ok: false }
  | {
      /** The document exactly as the provider wrote it, for publish to forward. */
      document: unknown;
      ok: true;
      /** The same document, validated and typed, for check to report on. */
      record: ProviderRecordStrict;
    };

export function parseDescriptorDocument(raw: string, expectedVersion: number): DescriptorParse {
  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(raw);
  } catch (e) {
    return {
      findings: [error(`not valid JSON: ${e instanceof Error ? e.message : String(e)}`)],
      ok: false,
    };
  }

  const version = (parsedJson as { schemaVersion?: unknown } | null)?.schemaVersion;

  if (version !== expectedVersion) {
    return {
      findings: [
        error(
          `schemaVersion is ${JSON.stringify(version)}; argent understands ${expectedVersion} ` +
            `and would skip this provider entirely`
        ),
      ],
      ok: false,
    };
  }

  const parsed = providerRecordSchema.safeParse(parsedJson);

  if (!parsed.success) {
    return {
      findings: parsed.error.issues.map((issue) =>
        error(`${issue.path.join(".") || "(root)"}: ${issue.message}`)
      ),
      ok: false,
    };
  }

  return { document: parsedJson, ok: true, record: parsed.data };
}

export async function checkDescriptorFile(
  file: string,
  expectedVersion: number
): Promise<ProviderReport> {
  const findings: Finding[] = [];
  const report: ProviderReport = { deviceCount: 0, findings, source: file };

  let raw: string;

  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    findings.push(error(`unreadable: ${e instanceof Error ? e.message : String(e)}`));
    return report;
  }

  const parsed = parseDescriptorDocument(raw, expectedVersion);

  if (!parsed.ok) {
    findings.push(...parsed.findings);
    return report;
  }

  const { record } = parsed;

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

  /**
   * Not an error: plenty of providers legitimately cannot name a process. But
   * it is the only thing that lets a crashed instance's descriptor be cleaned
   * up without a human, so it is worth saying out loud.
   */
  if (record.pid === undefined) {
    findings.push(
      warn(
        "no pid — `argent providers prune` cannot remove this descriptor if your process dies " +
          "without withdrawing, so a crash leaves phantom devices until someone deletes the file"
      )
    );
  }

  report.deviceCount = await checkDevices(record.devices, findings);

  return report;
}

export function printHumanReports(reports: ProviderReport[]): void {
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
