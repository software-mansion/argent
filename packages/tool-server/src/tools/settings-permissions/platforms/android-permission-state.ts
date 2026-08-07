import { adbShell, shellQuote } from "../../../utils/adb";

/**
 * Reads back what the package manager actually holds for a package, so a
 * permission change can be reported on evidence rather than on an exit code.
 *
 * On Android 16 (API 36) granting a permission an app does not declare succeeds
 * silently — the command exits 0, nothing is recorded, and the caller is told it
 * was applied (#616). The exit code stopped being evidence, so the state has to
 * be read.
 *
 * Every field here is tri-state on purpose: a section that was not found is
 * `undefined`, never an empty collection. That distinction is load-bearing.
 * "The package declares nothing" and "we could not read what it declares" lead
 * to opposite conclusions, and conflating them would demote every permission on
 * any package whose layout we failed to parse.
 */

export interface PackagePermissionState {
  /** Permissions the manifest declares. Undefined when the section was absent. */
  requested?: ReadonlySet<string>;
  /** Runtime grant state for user 0. Undefined when no runtime block was found. */
  runtime?: ReadonlyMap<string, boolean>;
}

export type PermissionVerdict =
  /** Observed in the state the action asked for. */
  | { kind: "confirmed" }
  /** Observed NOT to be in that state, with a reason worth showing the caller. */
  | { kind: "contradicted"; detail: string }
  /** Nothing could be read. Callers must fall back to the command's own verdict. */
  | { kind: "unknown" };

function indentOf(line: string): number {
  let i = 0;
  while (i < line.length && line[i] === " ") i++;
  return i;
}

/** Blank lines carry no indent, so they must never terminate a section. */
function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

/**
 * Lines belonging to a header: everything indented deeper, up to the next line
 * at or above the header's own indent. Blank lines are skipped rather than
 * treated as indent 0, which would truncate a section at its first gap.
 */
function sectionBody(lines: string[], headerIndex: number): string[] {
  const headerIndent = indentOf(lines[headerIndex]!);
  const body: string[] = [];
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (isBlank(line)) continue;
    if (indentOf(line) <= headerIndent) break;
    body.push(line);
  }
  return body;
}

/** Index of the first line whose trimmed text equals `header`, at any indent. */
function findHeader(lines: string[], header: string, from = 0, until = Infinity): number {
  for (let i = from; i < Math.min(lines.length, until); i++) {
    if (lines[i]!.trim() === header) return i;
  }
  return -1;
}

/** Index of the next line at indent 0 — the boundary of a top-level section. */
function nextTopLevel(lines: string[], from: number): number {
  for (let i = from; i < lines.length; i++) {
    if (!isBlank(lines[i]!) && indentOf(lines[i]!) === 0) return i;
  }
  return lines.length;
}

/**
 * Entry names are the text before the first colon. Android 10-13 annotate
 * restricted entries (`NAME: restricted=true`), so the colon cannot be assumed
 * absent even in the declaration list.
 */
function entryName(line: string): string {
  const trimmed = line.trim();
  const colon = trimmed.indexOf(":");
  return (colon === -1 ? trimmed : trimmed.slice(0, colon)).trim();
}

/** A section that parses to nothing is treated as unread, not as "declares nothing". */
function setOrUndefined(values: string[]): ReadonlySet<string> | undefined {
  return values.length > 0 ? new Set(values) : undefined;
}

function parseRuntimeRows(body: string[]): ReadonlyMap<string, boolean> | undefined {
  const rows = new Map<string, boolean>();
  for (const line of body) {
    const match = /^\s*([A-Za-z0-9_.]+):\s*granted=(true|false)/.exec(line);
    if (match) rows.set(match[1]!, match[2] === "true");
  }
  return rows.size > 0 ? rows : undefined;
}

/**
 * The runtime block for user 0.
 *
 * `User 0:` appears with a trailing payload inside a package block
 * (`User 0: ceDataInode=…`) and bare inside a shared-user block, so it is matched
 * as a prefix. Only user 0 is read: grant/revoke target the system user and the
 * tool never selects another, so a row from a different user could only ever
 * demote something wrongly.
 */
function runtimeForUserZero(lines: string[], from: number, until: number): string[] | null {
  for (let i = from; i < Math.min(lines.length, until); i++) {
    if (!lines[i]!.trim().startsWith("User 0:")) continue;
    const userBody = sectionBody(lines, i);
    const offset = i + 1;
    const runtimeIdx = findHeader(
      lines,
      "runtime permissions:",
      offset,
      offset + userBody.length + 1
    );
    if (runtimeIdx !== -1) return sectionBody(lines, runtimeIdx);
  }
  return null;
}

/**
 * Parse the package-manager dump for one package.
 *
 * Anything unrecognised yields `undefined` fields rather than empty ones — see
 * the note on the interface.
 */
export function parsePackagePermissionState(
  dump: string,
  bundleId: string
): PackagePermissionState {
  // adb on Windows inserts CR; every match below is on trimmed text, but the
  // split has to tolerate both endings.
  const lines = dump.split(/\r?\n/);

  // Matched by equality: a per-package dump also contains top-level
  // `Permissions:` sections, and a loose match would select the wrong one.
  const packagesIdx = findHeader(lines, "Packages:");
  if (packagesIdx === -1) return {};

  const packagesEnd = nextTopLevel(lines, packagesIdx + 1);
  // Scoped to the first block under `Packages:`, which excludes the duplicate
  // that `Hidden system packages:` prints for a system app.
  const marker = `Package [${bundleId}] (`;
  let blockIdx = -1;
  for (let i = packagesIdx + 1; i < packagesEnd; i++) {
    if (lines[i]!.trim().startsWith(marker)) {
      blockIdx = i;
      break;
    }
  }
  if (blockIdx === -1) return {};

  const blockBody = sectionBody(lines, blockIdx);
  const blockEnd = blockIdx + 1 + blockBody.length;

  const requestedIdx = findHeader(lines, "requested permissions:", blockIdx + 1, blockEnd);
  const requested =
    requestedIdx === -1
      ? undefined
      : setOrUndefined(sectionBody(lines, requestedIdx).map(entryName));

  let runtimeBody = runtimeForUserZero(lines, blockIdx + 1, blockEnd);

  // A package with `android:sharedUserId` keeps its runtime state in a separate
  // top-level `Shared users:` section, keyed by the shared-user name rather than
  // the package name. Without this, ~1 in 6 packages on a stock image — Maps,
  // Calendar, Settings among them — would read as "no runtime state" and fall
  // back to trusting the exit code, leaving #616 unfixed exactly where it is
  // most likely to be hit.
  if (!runtimeBody) {
    const sharedName = /sharedUser=SharedUserSetting\{\S+\s+(\S+?)\/\d+\}/.exec(
      lines.slice(blockIdx, blockEnd).join("\n")
    )?.[1];
    if (sharedName) {
      const sharedIdx = findHeader(lines, "Shared users:");
      if (sharedIdx !== -1) {
        const sharedEnd = nextTopLevel(lines, sharedIdx + 1);
        const sharedMarker = `SharedUser [${sharedName}] (`;
        for (let i = sharedIdx + 1; i < sharedEnd; i++) {
          if (!lines[i]!.trim().startsWith(sharedMarker)) continue;
          const sharedBody = sectionBody(lines, i);
          runtimeBody = runtimeForUserZero(lines, i + 1, i + 1 + sharedBody.length);
          break;
        }
      }
    }
  }

  return {
    ...(requested && { requested }),
    ...(runtimeBody && { runtime: parseRuntimeRows(runtimeBody) }),
  };
}

/**
 * Read the package's permission state. Never throws: a failed read leaves the
 * command's own verdict in place, which is the behaviour every caller had before
 * verification existed.
 */
export async function readPackagePermissionState(
  udid: string,
  bundleId: string
): Promise<PackagePermissionState> {
  try {
    const out = await adbShell(udid, `dumpsys package ${shellQuote(bundleId)}`);
    return parsePackagePermissionState(out, bundleId);
  } catch {
    return {};
  }
}

/**
 * Does the observed state agree that this permission was changed as asked?
 *
 * `grant` targets granted; `deny` and `reset` both target not-granted. The
 * question is whether the permission is now in the requested state — not whether
 * anything changed — because denying an already-denied permission is a perfectly
 * good outcome for the caller who asked for it.
 */
export function verifyPermission(
  state: PackagePermissionState,
  permission: string,
  action: "grant" | "deny" | "reset"
): PermissionVerdict {
  const target = action === "grant";

  // A runtime row is the strongest evidence and outranks the declaration list:
  // a permission split into the app by the platform can hold real state while
  // reading as undeclared.
  const granted = state.runtime?.get(permission);
  if (granted !== undefined) {
    return granted === target
      ? { kind: "confirmed" }
      : {
          kind: "contradicted",
          detail: `the package manager still reports it as ${granted ? "granted" : "not granted"}`,
        };
  }

  if (state.requested) {
    if (!state.requested.has(permission)) {
      return { kind: "contradicted", detail: "the app's manifest does not declare it" };
    }
    if (state.runtime) {
      return {
        kind: "contradicted",
        detail: "it is declared but is not a runtime-changeable permission on this device",
      };
    }
  }

  return { kind: "unknown" };
}
