import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { X509Certificate } from "node:crypto";

/**
 * Detect Apple signing teams from this Mac's keychain.
 *
 * `ARGENT_IOS_TEAM_ID` stays the only explicit setting; this module is the
 * zero-config fallback behind it. It shells out to `security find-certificate`
 * for the development signing certificates, reads each certificate's team id
 * (subject OU) and human label (subject CN, which carries the Apple ID email),
 * and orders teams by their newest certificate's notBefore.
 */

const execFileAsync = promisify(execFile);

/** One Apple signing team, represented by its newest development certificate. */
export interface DetectedSigningTeam {
  /** Apple Developer Team ID, the certificate subject OU. */
  teamId: string;
  /** Certificate subject CN, e.g. "Apple Development: dev@example.com (ABCD123456)". */
  label: string;
  /** The newest certificate's notBefore, epoch ms. Orders the auto-pick. */
  issuedAtMs: number;
}

/**
 * Certificate common names that mark a development signing identity.
 * "Apple Development" is the current CN; "iPhone Developer" is the legacy one
 * still found in keychains provisioned by older Xcode versions.
 */
const SIGNING_CERT_COMMON_NAMES = ["Apple Development", "iPhone Developer"] as const;

const SECURITY_TIMEOUT_MS = 15_000;

/**
 * PEM dump of every matching certificate. Any failure (no `security` binary,
 * no keychain access, a security version that errors on zero matches) reads as
 * "nothing found": detection is a fallback and must not add its own failure
 * mode on top of the no-certificate error.
 */
async function listCertificatePem(commonName: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "security",
      ["find-certificate", "-c", commonName, "-a", "-p"],
      { timeout: SECURITY_TIMEOUT_MS }
    );
    return stdout;
  } catch {
    return "";
  }
}

const PEM_BLOCK_RE = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

/**
 * Read one RDN value out of the newline-separated subject string
 * `X509Certificate` renders (`UID=...\nCN=...\nOU=...`).
 */
function subjectValue(subject: string, key: string): string | null {
  for (const line of subject.split("\n")) {
    if (line.startsWith(`${key}=`)) {
      return line.slice(key.length + 1).trim() || null;
    }
  }
  return null;
}

/**
 * Parse concatenated PEM output into teams: dedup by team id keeping each
 * team's newest certificate, newest team first, notBefore ties broken by team
 * id so the auto-pick is deterministic. Blocks that do not parse as a
 * certificate, or lack an OU/CN, are skipped rather than fatal.
 */
export function parseSigningTeams(pem: string): DetectedSigningTeam[] {
  const newestByTeam = new Map<string, DetectedSigningTeam>();

  for (const block of pem.match(PEM_BLOCK_RE) ?? []) {
    let cert: X509Certificate;

    try {
      cert = new X509Certificate(block);
    } catch {
      continue;
    }

    const teamId = subjectValue(cert.subject, "OU");
    const label = subjectValue(cert.subject, "CN");
    const issuedAtMs = Date.parse(cert.validFrom);

    if (!teamId || !label || Number.isNaN(issuedAtMs)) {
      continue;
    }

    const known = newestByTeam.get(teamId);

    if (!known || issuedAtMs > known.issuedAtMs) {
      newestByTeam.set(teamId, { teamId, label, issuedAtMs });
    }
  }

  return [...newestByTeam.values()].sort(
    (a, b) => b.issuedAtMs - a.issuedAtMs || (a.teamId < b.teamId ? -1 : 1)
  );
}

type CertificateLister = (commonName: string) => Promise<string>;

let certificateLister: CertificateLister = listCertificatePem;
let memoizedTeams: Promise<DetectedSigningTeam[]> | null = null;

async function runDetection(): Promise<DetectedSigningTeam[]> {
  const pems = await Promise.all(SIGNING_CERT_COMMON_NAMES.map((name) => certificateLister(name)));
  return parseSigningTeams(pems.join("\n"));
}

/** Drop `detection` from the memo unless a newer detection has already replaced it. */
function forgetDetection(detection: Promise<DetectedSigningTeam[]>): void {
  if (memoizedTeams === detection) {
    memoizedTeams = null;
  }
}

/**
 * Detect signing teams. A populated result is memoized for the process
 * lifetime: certificates change through an Xcode sign-in, not mid-session,
 * and the shellout should not tax every signing resolution. An empty result
 * and a rejected detection are dropped from the memo instead, so the next
 * signing resolution reads the keychain again: the no-certificate error tells
 * the user to retry once the certificate exists, and that retry must not need
 * a tool-server restart. Concurrent callers still share one in-flight
 * detection.
 */
export function detectSigningTeams(): Promise<DetectedSigningTeam[]> {
  if (memoizedTeams) {
    return memoizedTeams;
  }

  const detection: Promise<DetectedSigningTeam[]> = runDetection().then(
    (teams) => {
      if (teams.length === 0) {
        forgetDetection(detection);
      }
      return teams;
    },
    (error: unknown) => {
      forgetDetection(detection);
      throw error;
    }
  );

  memoizedTeams = detection;
  return detection;
}

function formatTeam(team: DetectedSigningTeam): string {
  return `${team.teamId} (${team.label})`;
}

/** The agent-facing summary of which team detection picked and why. */
export function buildSigningDetectionNote(teams: readonly DetectedSigningTeam[]): string {
  const [winner, ...others] = teams;

  if (!winner) {
    throw new Error("buildSigningDetectionNote requires at least one detected team");
  }

  if (others.length === 0) {
    return (
      `Signing the on-device runner with team ${winner.teamId} (${winner.label}), ` +
      `detected from this Mac's keychain. Set ARGENT_IOS_TEAM_ID in the tool-server's ` +
      `environment to override.`
    );
  }

  return (
    `Signing the on-device runner with team ${winner.teamId} (${winner.label}), ` +
    `the newest of ${teams.length} signing identities in this Mac's keychain. ` +
    `Also found: ${others.map(formatTeam).join(", ")}. ` +
    `To sign under a different team, set ARGENT_IOS_TEAM_ID in the tool-server's ` +
    `environment: argent server stop && ARGENT_IOS_TEAM_ID=<team-id> argent server start --detach`
  );
}

let announced = false;
let pendingNote: string | null = null;

/**
 * Called when a detected (not env-configured) team is first used for signing.
 * Logs the outcome once and stages the same text for the tool-result note
 * channel below. Subsequent uses of the memoized detection stay silent.
 */
export function announceDetectedSigningTeam(teams: readonly DetectedSigningTeam[]): void {
  if (announced || teams.length === 0) {
    return;
  }

  announced = true;
  const note = buildSigningDetectionNote(teams);
  process.stderr.write(`[ios-device-signing] ${note}\n`);
  pendingNote = note;
}

/**
 * Drained by http.ts into the note of the first tool call completed after
 * detection resolved (the same module-global channel the screen-recording
 * reminder uses), so the agent driving that call sees which team signs the
 * runner without any new plumbing.
 */
export function consumePendingSigningDetectionNote(): string | null {
  const note = pendingNote;
  pendingNote = null;
  return note;
}

/**
 * Test-only: swap the `security` shellout for a fake (null restores the real
 * one) and clear the memo plus the announce-once state, so no unit test ever
 * reads the developer's actual keychain.
 */
export function __setCertificateListerForTests(lister: CertificateLister | null): void {
  certificateLister = lister ?? listCertificatePem;
  memoizedTeams = null;
  announced = false;
  pendingNote = null;
}
