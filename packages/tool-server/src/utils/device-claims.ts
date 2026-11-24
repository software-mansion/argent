import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getDeviceClaimProvider } from "@argent/configuration-core";

const execFileAsync = promisify(execFile);

/** Who holds a device, as the `devices.claimProvider` command reports it. */
export type DeviceClaim = { owner?: string; mine: boolean };

/** Kept well under list-devices' per-branch deadline: the listing waits on it. */
const CLAIM_PROVIDER_TIMEOUT_MS = 2_000;
const MAX_OWNER_LENGTH = 200;
const MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * Parse the provider's stdout: `{ "<udid|serial|id>": { "owner": "...", "mine": bool } }`.
 * Anything else means no claims, and a malformed entry is skipped rather than
 * voiding the rest, so one bad lease file cannot hide every other claim.
 */
export function parseDeviceClaims(stdout: string): Map<string, DeviceClaim> {
  const claims = new Map<string, DeviceClaim>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return claims;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return claims;
  for (const [id, entry] of Object.entries(parsed)) {
    if (id === "" || entry === null || typeof entry !== "object") continue;
    const { owner, mine } = entry as { owner?: unknown; mine?: unknown };
    if (typeof mine !== "boolean") continue;
    claims.set(id, {
      ...(typeof owner === "string" && owner !== ""
        ? { owner: owner.slice(0, MAX_OWNER_LENGTH) }
        : {}),
      mine,
    });
  }
  return claims;
}

/**
 * Run the configured claim provider. Unset key, missing file, non-zero exit,
 * timeout or bad output all give an empty map: claims only annotate the
 * listing and must never hide a device or fail list-devices.
 */
export async function readDeviceClaims(
  configured?: string | null
): Promise<Map<string, DeviceClaim>> {
  try {
    const command = configured === undefined ? getDeviceClaimProvider() : configured;
    if (command === null) return new Map();
    const { stdout } = await execFileAsync(command, [], {
      timeout: CLAIM_PROVIDER_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      encoding: "utf8",
    });
    return parseDeviceClaims(stdout);
  } catch {
    return new Map();
  }
}
