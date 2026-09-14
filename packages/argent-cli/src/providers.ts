/**
 * `argent providers <subcommand>` — the provider-facing side of the external
 * device provider contract.
 *
 * Two audiences. Implementers run `check` while building a provider and
 * `publish` / `withdraw` / `prune` from their process instead of writing
 * `~/.argent/providers/<id>.json` by hand. Writing that file directly stays
 * legal and is still the contract of record; what these commands save a Node
 * provider is reimplementing the atomic write, the no-op dedupe and the orphan
 * prune, and they validate with the same install that will read the result.
 * Support gets `list`: what argent sees right now.
 *
 * Only `publish`, `withdraw` and `prune` touch the filesystem. `prune` unlinks
 * something it did not write and only on proof: the descriptor parses, names a
 * pid and that pid is dead.
 *
 * Every subcommand takes `--json` and exits 0 on success, 1 on failure, 2 on a
 * usage error.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import pc from "picocolors";
import {
  descriptorFiles,
  discoverProviders,
  isProcessAlive,
  PROVIDER_ID_SHAPE,
  PROVIDER_SCHEMA_VERSION,
  type ProviderDevice,
  providerDeviceSchema,
  providersDirectory,
  pruneOrphanedProviders,
  type PruneResult,
  ProviderValidationError,
  publishProvider,
  withdrawProvider,
} from "@argent/device-providers";
import {
  checkDescriptorFile,
  error,
  type Finding,
  isReachable,
  parseDescriptorDocument,
  printHumanReports,
  type ProviderReport,
} from "./providers-check.js";

const SUBCOMMANDS = ["check", "list", "prune", "publish", "withdraw"] as const;

type Subcommand = (typeof SUBCOMMANDS)[number];

/**
 * Thrown for anything the user typed wrong; the caller turns it into exit 2.
 */
class UsageError extends Error {}

// ── argument parsing ────────────────────────────────────────────────────────

interface ParsedArgs {
  dryRun: boolean;
  /** Read (or check) a single descriptor rather than the whole directory. */
  file?: string;
  json: boolean;
  /** Positional operands, e.g. the provider id `withdraw` takes. */
  operands: string[];
  pid?: number;
  schemaVersion: number;
  stdin: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    dryRun: false,
    json: false,
    operands: [],
    schemaVersion: PROVIDER_SCHEMA_VERSION,
    stdin: false,
  };

  const valueOf = (token: string, next: string | undefined, flag: string): string => {
    if (token.startsWith(`${flag}=`)) return token.slice(flag.length + 1);
    if (next === undefined) throw new UsageError(`${flag} requires a value`);
    return next;
  };

  /**
   * `Number.parseInt` stops at the first character it cannot read, so it turns
   * `12.5` into `12` and `1junk` into `1`. Both then pass an `isInteger` check
   * as a number the user never asked for. Match the whole value first, so a
   * typo is reported rather than silently rounded into something plausible.
   */
  const wholeInteger = (raw: string, flag: string): number => {
    if (!/^[+-]?\d+$/.test(raw.trim())) {
      throw new UsageError(`${flag} must be an integer, got "${raw}"`);
    }

    return Number.parseInt(raw, 10);
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;

    if (token === "--json") {
      parsed.json = true;
    } else if (token === "--dry-run") {
      parsed.dryRun = true;
    } else if (token === "--stdin") {
      parsed.stdin = true;
    } else if (token === "--file" || token.startsWith("--file=")) {
      parsed.file = valueOf(token, token === "--file" ? argv[++i] : undefined, "--file");
    } else if (token === "--pid" || token.startsWith("--pid=")) {
      const raw = valueOf(token, token === "--pid" ? argv[++i] : undefined, "--pid");
      parsed.pid = wholeInteger(raw, "--pid");

      if (parsed.pid < 1) {
        throw new UsageError(`--pid must be a positive integer, got "${raw}"`);
      }
    } else if (token === "--schema-version" || token.startsWith("--schema-version=")) {
      const raw = valueOf(
        token,
        token === "--schema-version" ? argv[++i] : undefined,
        "--schema-version"
      );

      parsed.schemaVersion = wholeInteger(raw, "--schema-version");
    } else if (token.startsWith("-")) {
      throw new UsageError(`Unknown argument: "${token}"`);
    } else {
      parsed.operands.push(token);
    }
  }

  return parsed;
}

// ── shared output helpers ───────────────────────────────────────────────────

function color(): boolean {
  return process.stdout.isTTY;
}

function dim(s: string): string {
  return color() ? pc.dim(s) : s;
}

/**
 * Report the issues that stopped a write — on `stderr`, where a provider's
 * logs pick them up or as JSON on `stdout` so `--json` output stays parseable.
 */
function reportFailure(json: boolean, source: string, findings: Finding[]): never {
  if (json) {
    console.log(JSON.stringify({ findings, ok: false, source }, null, 2));
  } else {
    for (const finding of findings) {
      console.error(`${color() ? pc.red("error  ") : "error  "} ${finding.message}`);
    }
  }

  process.exit(1);
}

/** Read a descriptor document from `--file` or from stdin under `--stdin`. */
async function readDocument(args: ParsedArgs): Promise<{ raw: string; source: string }> {
  if (args.file && args.stdin) {
    throw new UsageError("--file and --stdin are mutually exclusive");
  }

  if (args.file) {
    try {
      return { raw: fs.readFileSync(args.file, "utf8"), source: args.file };
    } catch (e) {
      throw new UsageError(
        `cannot read ${args.file}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  if (!args.stdin) {
    throw new UsageError("publish needs a descriptor: pass --file <path> or --stdin");
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return { raw: Buffer.concat(chunks).toString("utf8"), source: "<stdin>" };
}

// ── check ───────────────────────────────────────────────────────────────────

async function runCheck(args: ParsedArgs): Promise<void> {
  const reports: ProviderReport[] = [];

  if (args.file) {
    reports.push(await checkDescriptorFile(args.file, args.schemaVersion));
  } else {
    const files = descriptorFiles();

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
    printHumanReports(reports);

    console.log(`\n${reports.length} provider(s) checked, ${errorCount} error(s).`);
  }

  if (errorCount > 0) process.exit(1);
}

// ── publish ─────────────────────────────────────────────────────────────────

/**
 * The vendor behind a provider id, which is its leading segment.
 *
 * Provider ids are `<vendor>-<instance-suffix>` and unique per live instance,
 * so a vendor's crashed window carries a different id from the one publishing
 * now. Matching the whole id would therefore prune only the descriptor about to
 * be overwritten, which is the one case that needs no pruning.
 *
 * The same rule `externalProviderLabel` applies to a device id, from the other
 * end: this starts at a bare provider id, so it has no `ext:` prefix to strip.
 */
function vendorOf(providerId: string): string {
  return providerId.split("-")[0]!;
}

async function runPublish(args: ParsedArgs): Promise<void> {
  const { raw, source } = await readDocument(args);

  const parsed = parseDescriptorDocument(raw, args.schemaVersion);

  if (!parsed.ok) reportFailure(args.json, source, parsed.findings);

  const pid = args.pid ?? parsed.record.pid;

  /**
   * Opportunistic, and why `prune` is load-bearing rather than a convenience.
   * A provider publishing on every device change clears its own crashed
   * instances for free, with no scheduled job. Only `publish` does this.
   * `check` and `list` stay read-only.
   *
   * Scoped to the publishing vendor, which is what "its own" has to mean here.
   * Unfiltered is what `argent providers prune` does, because a user running
   * that by hand means all of them. Reaching the same width from inside another
   * vendor's publish would have one editor delete a competitor's descriptor as
   * a side effect of saving its own, and a dead pid is not a mandate to tidy up
   * after somebody else.
   */
  const pruned = pruneOrphanedProviders({
    filter: (candidate) => vendorOf(candidate.id) === vendorOf(parsed.record.id),
  });

  let result: { changed: boolean; path: string };

  try {
    result = publishProvider(parsed.document, args.pid === undefined ? {} : { pid: args.pid });
  } catch (e) {
    if (e instanceof ProviderValidationError) {
      reportFailure(
        args.json,
        source,
        e.issues.map((issue) => error(issue))
      );
    }
    throw e;
  }

  const warnings: string[] = [];

  if (pid === undefined) {
    warnings.push(
      "no pid recorded — pass --pid <your process id> (or set `pid` in the document) or " +
        "`argent providers prune` cannot clean this up if you crash"
    );
  }

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          changed: result.changed,
          ok: true,
          path: result.path,
          pruned: pruned.map((entry) => entry.path),
          warnings,
        },
        null,
        2
      )
    );
    return;
  }

  console.log(result.path);

  if (!result.changed) console.log(dim("  unchanged — the file was already this document"));

  for (const entry of pruned) {
    console.log(dim(`  pruned ${entry.path} (pid ${entry.pid} is gone)`));
  }

  for (const warning of warnings) {
    console.error(`${color() ? pc.yellow("warning") : "warning"} ${warning}`);
  }
}

// ── withdraw ────────────────────────────────────────────────────────────────

function runWithdraw(args: ParsedArgs): void {
  const [id, ...extra] = args.operands;

  if (!id) throw new UsageError("withdraw needs a provider id: argent providers withdraw <id>");

  if (extra.length > 0)
    throw new UsageError(`withdraw takes one provider id, got ${1 + extra.length}`);

  /**
   * Shape-checked before it reaches a path — `../../` is not a provider id.
   */
  if (!PROVIDER_ID_SHAPE.test(id)) {
    throw new UsageError(`'${id}' is not a valid provider id (${String(PROVIDER_ID_SHAPE)})`);
  }

  const removed = withdrawProvider(id);
  const file = path.join(providersDirectory(), `${id}.json`);

  if (args.json) {
    console.log(JSON.stringify({ ok: true, path: file, removed }, null, 2));
    return;
  }

  console.log(removed ? `Removed ${file}` : `Nothing to remove: ${file} does not exist.`);
}

// ── list ────────────────────────────────────────────────────────────────────

interface DeviceView {
  capabilities: string[];
  id: string;
  name: string;
  nativeId: string;
  platform: string;
  /** Undefined when the device declares no simulator-server to probe. */
  reachable?: boolean;
  state: string;
}

interface ProviderView {
  devices: DeviceView[];
  id: string;
  /** How many device entries argent would refuse outright. */
  invalidDevices: number;
  name: string;
  pid?: number;
  /** Undefined when the descriptor names no pid. */
  processAlive?: boolean;
  source?: string;
  supportUrl?: string;
  workspace?: { name: string; path: string };
}

async function runList(args: ParsedArgs): Promise<void> {
  const views: ProviderView[] = [];

  for (const record of discoverProviders()) {
    const devices: DeviceView[] = [];
    let invalidDevices = 0;

    for (const raw of record.devices) {
      const parsed = providerDeviceSchema.safeParse(raw);

      if (!parsed.success) {
        invalidDevices++;
        continue;
      }

      const device: ProviderDevice = parsed.data;

      devices.push({
        capabilities: device.capabilities,
        id: `ext:${record.id}:${device.nativeId}`,
        name: device.name,
        nativeId: device.nativeId,
        platform: device.platform,
        ...(device.simulatorServer
          ? { reachable: await isReachable(device.simulatorServer.apiUrl) }
          : {}),
        state: device.state,
      });
    }

    views.push({
      devices,
      id: record.id,
      invalidDevices,
      name: record.name,
      ...(record.pid === undefined
        ? {}
        : { pid: record.pid, processAlive: isProcessAlive(record.pid) }),
      ...(record.sourcePath ? { source: record.sourcePath } : {}),
      ...(record.supportUrl ? { supportUrl: record.supportUrl } : {}),
      ...(record.workspace ? { workspace: record.workspace } : {}),
    });
  }

  if (args.json) {
    console.log(
      JSON.stringify({ directory: providersDirectory(), ok: true, providers: views }, null, 2)
    );
    return;
  }

  if (views.length === 0) {
    console.log(`No device providers registered in ${providersDirectory()}.`);
    return;
  }

  for (const view of views) {
    console.log(`\n${view.name} (${view.id})`);

    if (view.source) console.log(dim(`  source:    ${view.source}`));

    if (view.workspace) {
      console.log(dim(`  workspace: ${view.workspace.name} — ${view.workspace.path}`));
    }

    if (view.supportUrl) console.log(dim(`  support:   ${view.supportUrl}`));

    if (view.pid !== undefined) {
      console.log(dim(`  process:   pid ${view.pid} (${view.processAlive ? "alive" : "gone"})`));
    }

    if (view.invalidDevices > 0) {
      console.log(
        dim(`  ${view.invalidDevices} device entr(y|ies) argent would reject — run providers check`)
      );
    }

    if (view.devices.length === 0) {
      console.log(dim("  no devices on offer"));
      continue;
    }

    for (const device of view.devices) {
      const reach =
        device.reachable === undefined ? "" : device.reachable ? "" : "  [server unreachable]";

      console.log(`  ${device.id}${reach}`);
      console.log(dim(`    ${device.name} — ${device.platform}, ${device.state}`));
      console.log(dim(`    capabilities: ${device.capabilities.join(", ") || "(none)"}`));
    }
  }

  console.log(
    `\n${views.length} provider(s), ${views.reduce((n, v) => n + v.devices.length, 0)} device(s).`
  );
}

// ── prune ───────────────────────────────────────────────────────────────────

function runPrune(args: ParsedArgs): void {
  const pruned: PruneResult[] = pruneOrphanedProviders({ dryRun: args.dryRun });

  if (args.json) {
    console.log(JSON.stringify({ dryRun: args.dryRun, ok: true, pruned }, null, 2));
    return;
  }

  if (pruned.length === 0) {
    console.log("Nothing to prune: every descriptor either names a live process or names none.");
    return;
  }

  for (const entry of pruned) {
    const verb = args.dryRun ? "would remove" : "removed";
    console.log(`${verb} ${entry.path} — ${entry.name} (pid ${entry.pid} is gone)`);
  }

  console.log(`\n${pruned.length} orphaned descriptor(s)${args.dryRun ? " found" : " removed"}.`);
}

// ── help + dispatch ─────────────────────────────────────────────────────────

function printHelp(): void {
  console.log(`
Usage: argent providers <subcommand> [options]

Inspect and manage external device providers — third-party processes that
already run a simulator or emulator and offer it to argent by writing a
descriptor into ${providersDirectory()}
(contract schema version ${PROVIDER_SCHEMA_VERSION}).

Subcommands:
  check                    Validate descriptors against the provider contract.
                           With no --file, checks every descriptor on disk.
  publish                  Validate a descriptor and write it to its canonical
                           path, atomically. Also prunes your own vendor's
                           orphaned descriptors.
  withdraw <id>            Remove the descriptor a provider published.
  list                     Show what argent currently sees: providers, devices,
                           capabilities and liveness.
  prune                    Remove descriptors whose declared pid is dead, from
                           every vendor.

Options:
  --file <path>            check: validate this descriptor instead of every one
                           on disk. publish: read the document from here.
  --stdin                  publish: read the document from stdin.
  --pid <n>                publish: record the PROVIDER's process id, so a
                           later prune can remove this descriptor if that
                           process dies. Overrides any pid in the document.
  --dry-run                prune: report what would be removed, remove nothing.
  --schema-version <n>     Contract version to validate against (default ${PROVIDER_SCHEMA_VERSION}).
  --json                   Emit a machine-readable report on stdout.
  --help, -h               Show this message.

Writing ${providersDirectory()}/<id>.json
yourself remains fully supported — it is the contract of record, and a provider
that cannot spawn a Node CLI must do exactly that. These commands exist so a
provider that CAN does not have to reimplement the atomic write, the no-op
dedupe and the orphan prune. Validation gates on this build's contract; fields
this build does not know pass through to the file untouched, so publishing
through an older install than the one reading loses nothing.

To spawn these commands without relying on PATH — which an editor extension
host frequently cannot — read ~/.argent/cli.json, written by \`argent init\`
and \`argent update\` and healed best-effort on every \`argent mcp\` start:

  { "node": "/abs/path/to/node", "cli": "/abs/path/to/dist/cli.js",
    "version": "...", "mode": "global" | "local", "updatedAt": "..." }

Spawn [node, cli, "providers", ...] directly, with no shell. The record is
best-effort: it can go stale, so fall back to \`argent\` on PATH and then to
doing nothing at all.

Exits 0 on success, 1 when the operation failed, and 2 on a usage error.
`);
}

/**
 * `argent providers <subcommand>`. The subcommand layer predates everything
 * but `check`, which is what let the rest arrive without changing the shape
 * of the command users had already learned.
 */
export async function providers(argv: string[]): Promise<void> {
  const [subcommand, ...rest] = argv;

  if (subcommand === undefined || subcommand === "--help" || subcommand === "-h") {
    printHelp();
    if (subcommand === undefined) process.exit(2);
    return;
  }

  if (!(SUBCOMMANDS as readonly string[]).includes(subcommand)) {
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

  /**
   * `withdraw` is the only subcommand with an operand. Accepting one elsewhere
   * would turn `argent providers list acme` into a command that quietly
   * ignored what you asked for.
   */
  if (subcommand !== "withdraw" && args.operands.length > 0) {
    console.error(`Unknown argument: "${args.operands[0]}"`);
    process.exit(2);
  }

  try {
    switch (subcommand as Subcommand) {
      case "check":
        return await runCheck(args);
      case "publish":
        return await runPublish(args);
      case "withdraw":
        return runWithdraw(args);
      case "list":
        return await runList(args);
      case "prune":
        return runPrune(args);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(e.message);
      process.exit(2);
    }

    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
