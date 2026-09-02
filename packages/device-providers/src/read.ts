/**
 * The discovery half of the contract: turn whatever is in
 * `~/.argent/providers/` into records and devices.
 *
 * Three properties must survive any edit here:
 *
 * - It never unlinks. A stale descriptor belongs to another process and leaving
 *   it costs one refused connection while deleting it is unrecoverable. Pruning
 *   lives in [`write.ts`](./write.ts), where the caller has proven the owning
 *   process is dead.
 * - It never throws. A malformed, stale or hostile file makes the integration
 *   go dark, one `stderr` line per cause, and nothing else.
 * - It never caches. Every lookup re-reads the file, which is what makes
 *   revocation and recovery free.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CAPABILITY_SET,
  type ExternalDevice,
  makeExternalId,
  PROVIDER_SCHEMA_VERSION,
  providerDeviceSchema,
  providerEnvelopeSchema,
  type ProviderRecord,
} from "./contract.js";

/** Set to `1`/`true` to skip provider discovery entirely. */
const DISABLE_ENV = "ARGENT_DISABLE_DEVICE_PROVIDERS";

/**
 * Test / advanced override: comma-separated descriptor paths. When set,
 * `~/.argent/providers/` is not scanned, so a test (or the E2E) can point
 * Argent at a sandboxed descriptor without touching the real home directory.
 */
const OVERRIDE_ENV = "ARGENT_DEVICE_PROVIDERS";

/**
 * Resolved at call time, honoring `HOME` / `USERPROFILE`, so a test can sandbox
 * the feature by moving the home directory.
 *
 * A deliberate copy of `@argent/configuration-core`'s `resolveHomeDir`, so that
 * zod is the only dependency. That package stays the source of truth. A
 * tool-server test asserts the two agree, so drift fails the build rather than
 * silently pointing the writer and the reader at different directories.
 */
function resolveHomeDir(): string {
  const raw = process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME;
  const trimmed = raw?.trim();
  return trimmed ? raw! : os.homedir();
}

/**
 * `~/.argent/providers`: machine-global, shared by every tool-server install.
 */
export function providersDirectory(): string {
  return path.join(resolveHomeDir(), ".argent", "providers");
}

function discoveryDisabled(): boolean {
  const raw = process.env[DISABLE_ENV];
  return raw === "1" || raw?.toLowerCase() === "true";
}

/**
 * One `stderr` line per (path, reason) per process. A provider that keeps
 * rewriting a broken file must not be able to flood the log.
 */
const warnedOnce = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warnedOnce.has(key)) return;
  warnedOnce.add(key);
  process.stderr.write(`[device-providers] ${message}\n`);
}

/** Test seam. Forget the one-shot `stderr` warnings. */
export function __resetProviderWarningsForTesting(): void {
  warnedOnce.clear();
}

/**
 * Parse one descriptor, or `undefined` with at most one `stderr` line saying
 * why. Exported because `argent providers prune` needs the same lenient read:
 * a record it cannot parse is one whose ownership it cannot prove.
 */
export function readProviderFile(file: string): ProviderRecord | undefined {
  let raw: string;

  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    /**
     * Unreadable or removed between `readdir` and read — treat as absent. A
     * provider writes atomically (tmp + rename), so a partial read is a
     * transient worth ignoring rather than reporting.
     */
    return undefined;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    warnOnce(`${file}:json`, `ignoring ${file}: not valid JSON`);
    return undefined;
  }

  /**
   * Version-check before shape validation: a v2 document is allowed to look
   * nothing like v1 and must be skipped quietly rather than reported as
   * malformed.
   */
  const version = (parsed as { schemaVersion?: unknown } | null)?.schemaVersion;

  if (version !== PROVIDER_SCHEMA_VERSION) {
    warnOnce(
      `${file}:version`,
      `ignoring ${file}: unsupported schemaVersion ${JSON.stringify(version)} ` +
        `(this build understands ${PROVIDER_SCHEMA_VERSION})`
    );

    return undefined;
  }

  const result = providerEnvelopeSchema.safeParse(parsed);

  if (!result.success) {
    warnOnce(`${file}:shape`, `ignoring ${file}: ${result.error.issues[0]?.message ?? "invalid"}`);
    return undefined;
  }

  return { ...result.data, sourcePath: file };
}

/**
 * Read every provider descriptor currently on disk.
 *
 * Synchronous and cheap by design. On the common path the directory is absent
 * and this costs one failed `readdir`. Never throws, never writes and never
 * unlinks. A stale file belongs to another process; leaving it costs one
 * refused connection, deleting it is unrecoverable.
 */
export function discoverProviders(): ProviderRecord[] {
  if (discoveryDisabled()) return [];

  const override = process.env[OVERRIDE_ENV];
  let files: string[];

  if (override) {
    files = override
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  } else {
    files = descriptorFiles();
  }

  const byId = new Map<string, ProviderRecord>();

  for (const file of files) {
    const record = readProviderFile(file);
    if (!record) continue;
    /**
     * First file wins on a duplicate id. Two live instances must not share one.
     * If they do, one is stale and we cannot tell which, so pick
     * deterministically (files are sorted) instead of racing.
     */
    if (byId.has(record.id)) {
      warnOnce(`${record.id}:dup`, `ignoring ${file}: duplicate provider id '${record.id}'`);
      continue;
    }

    byId.set(record.id, record);
  }

  return Array.from(byId.values());
}

/**
 * Every `*.json` in the providers directory, sorted. The file list behind
 * {@linkcode discoverProviders}, without the env overrides or the parsing.
 *
 * `argent providers check` and `prune` need the files rather than the records:
 * both have to see a descriptor that failed to parse, one to report it and the
 * other to refuse to touch it.
 */
export function descriptorFiles(): string[] {
  const directory = providersDirectory();

  try {
    return fs
      .readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => path.join(directory, name));
  } catch {
    return [];
  }
}

/**
 * Decide what platform a native id belongs to. Supplied by the caller because
 * the tool-server's classifier knows about device shapes this contract has no
 * business naming and Argent must have exactly one of them.
 *
 * Not [`nativeIdPlatform`](./contract.ts), which this package does own and not
 * redundant with it. That answers which of the two platforms a descriptor may
 * declare, so it has nowhere to put a Vega serial or a Chromium target and
 * calls both `android`. This answers what an id is, so it can disagree with
 * every platform the contract allows, which is the whole point at the one call
 * site, where an id that is neither `ios` nor `android` must be refused rather
 * than routed to `adb`. The two agree wherever both have an answer and
 * `device-info.test.ts` holds them to it.
 */
type ClassifyDevice = (nativeId: string) => string;

/**
 * Validate one raw device entry against the provider that served it. Returns
 * `undefined` (with a one-shot `stderr` line) for anything that fails, so one
 * bad device never costs a provider its whole list.
 */
function adoptDevice(
  record: ProviderRecord,
  raw: unknown,
  classify: ClassifyDevice
): ExternalDevice | undefined {
  const parsed = providerDeviceSchema.safeParse(raw);

  if (!parsed.success) {
    const nativeId = (raw as { nativeId?: unknown })?.nativeId;

    warnOnce(
      `${record.id}:device:${String(nativeId)}`,
      `${record.name}: ignoring device ${JSON.stringify(nativeId)}: ` +
        `${parsed.error.issues[0]?.message ?? "invalid"}`
    );

    return undefined;
  }

  const device = parsed.data;

  /**
   * The claimed platform must agree with the native id's shape, or the device
   * would be routed to the wrong toolchain entirely (e.g. an `adb` serial fed
   * to `xcrun`). Rejecting keeps the caller's classifier the source of truth
   * rather than letting a provider override it.
   */
  const shape = classify(device.nativeId);

  if (shape !== device.platform) {
    warnOnce(
      `${record.id}:platform:${device.nativeId}`,
      `${record.name}: ignoring device '${device.nativeId}': declared platform ` +
        `'${device.platform}' but its id classifies as '${shape}'`
    );

    return undefined;
  }

  const capabilities = new Set(device.capabilities.filter((cap) => CAPABILITY_SET.has(cap)));

  return {
    capabilities,
    ...(device.deviceSet ? { deviceSet: device.deviceSet } : {}),
    id: makeExternalId(record.id, device.nativeId),
    ...(device.jsDebugger ? { jsDebugger: device.jsDebugger } : {}),
    kind: device.kind,
    ...(device.metroPort ? { metroPort: device.metroPort } : {}),
    name: device.name,
    ...(device.nativeDevtools ? { nativeDevtools: device.nativeDevtools } : {}),
    nativeId: device.nativeId,
    platform: device.platform,
    provider: {
      id: record.id,
      name: record.name,
      ...(record.supportUrl ? { supportUrl: record.supportUrl } : {}),
      ...(record.workspace ? { workspace: record.workspace } : {}),
    },
    ...(device.simulatorServer ? { simulatorServer: device.simulatorServer } : {}),
    state: device.state,
  };
}

/**
 * Every device a provider's file currently declares, validated and joined to
 * that provider. Nothing is cached, so nothing can go stale between reads.
 */
export function readProviderDevices(
  record: ProviderRecord,
  classify: ClassifyDevice
): ExternalDevice[] {
  const out: ExternalDevice[] = [];

  for (const raw of record.devices) {
    const device = adoptDevice(record, raw, classify);
    if (device) out.push(device);
  }

  return out;
}
