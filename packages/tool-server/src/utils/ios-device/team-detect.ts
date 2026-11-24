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
  /**
   * Certificate kind and key id, e.g. "Apple Development (ABCD123456)". The
   * subject CN also carries the account identity (an Apple ID, often an
   * e-mail), which is dropped here.
   */
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
 * "Apple Development: dev@example.com (ABCD123456)" -> "Apple Development (ABCD123456)".
 * A CN without the expected shape keeps only the text before the colon, or all
 * of it when there is no colon, so no identity leaks through an unusual
 * certificate either.
 */
export function signingLabel(commonName: string): string {
  const match = /^([^:]+):.*\(([A-Za-z0-9]+)\)\s*$/.exec(commonName);
  if (match) return `${match[1].trim()} (${match[2]})`;
  return commonName.split(":")[0]!.trim();
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
    const commonName = subjectValue(cert.subject, "CN");
    const issuedAtMs = Date.parse(cert.validFrom);

    if (!teamId || !commonName || Number.isNaN(issuedAtMs)) {
      continue;
    }

    const label = signingLabel(commonName);

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

/** The phone a team was picked for. */
export interface SigningNotePhone {
  udid: string;
  /** How many of the detected teams have an unexpired profile that lists the phone. */
  coveringTeams: number;
}

function reasonForTeam(teamCount: number, phone: SigningNotePhone | undefined): string {
  const keychain = "signing identities in this Mac's keychain";

  if (!phone) {
    return `the newest of ${teamCount} ${keychain}.`;
  }

  const listsPhone = `a provisioning profile that lists phone ${phone.udid}`;

  if (phone.coveringTeams === 0) {
    return `the newest of ${teamCount} ${keychain}; none has ${listsPhone}.`;
  }

  if (phone.coveringTeams === 1) {
    return `the only one of ${teamCount} ${keychain} with ${listsPhone}.`;
  }

  return `the newest of the ${phone.coveringTeams} ${keychain} with ${listsPhone}.`;
}

/** The agent-facing summary of which team detection picked and why. */
export function buildSigningDetectionNote(
  teams: readonly DetectedSigningTeam[],
  winner: DetectedSigningTeam | undefined = teams[0],
  phone?: SigningNotePhone
): string {
  if (!winner) {
    throw new Error("buildSigningDetectionNote requires at least one detected team");
  }

  const others = teams.filter((team) => team !== winner);

  if (others.length === 0) {
    return (
      `Signing the on-device runner with team ${winner.teamId} (${winner.label}), ` +
      `detected from this Mac's keychain. Set ARGENT_IOS_TEAM_ID in the tool-server's ` +
      `environment to override.`
    );
  }

  return (
    `Signing the on-device runner with team ${winner.teamId} (${winner.label}), ` +
    `${reasonForTeam(teams.length, phone)} ` +
    `Also found: ${others.map(formatTeam).join(", ")}. ` +
    `To sign under a different team, set ARGENT_IOS_TEAM_ID in the tool-server's ` +
    `environment: argent server stop && ARGENT_IOS_TEAM_ID=<team-id> argent server start --detach`
  );
}

/** Pending-note key for a team picked without naming a phone: any phone may read it. */
const ANY_PHONE = "";
const announcedTeams = new Set<string>();
const pendingNotes = new Map<string, string>();

/**
 * Called when a detected (not env-configured) team is used for signing. Logs
 * the outcome once per phone and team, since phones can sign under different
 * teams, and stages the same text for that phone's tool-result note below. Later
 * uses of the same team on that phone stay silent.
 */
export function announceDetectedSigningTeam(
  teams: readonly DetectedSigningTeam[],
  winner: DetectedSigningTeam | undefined = teams[0],
  phone?: SigningNotePhone
): void {
  const key = phone?.udid ?? ANY_PHONE;
  const announcement = `${key}/${winner?.teamId}`;

  if (!winner || announcedTeams.has(announcement)) {
    return;
  }

  announcedTeams.add(announcement);
  const note = buildSigningDetectionNote(teams, winner, phone);
  process.stderr.write(`[ios-device-signing] ${note}\n`);
  const pending = pendingNotes.get(key);
  pendingNotes.set(key, pending ? `${pending}\n${note}` : note);
}

/**
 * Drained by http.ts into the note of the first tool call that targets `udid`
 * and completes after detection resolved (the same module-global channel the
 * screen-recording reminder uses), so the agent driving that phone sees which
 * team signs its runner without any new plumbing. A call on another phone or
 * platform never carries it.
 */
export function consumePendingSigningDetectionNote(udid: string): string | null {
  const notes = [udid, ANY_PHONE].flatMap((key) => {
    const note = pendingNotes.get(key);
    pendingNotes.delete(key);
    return note ? [note] : [];
  });
  return notes.length > 0 ? notes.join("\n") : null;
}

/**
 * Test-only: swap the `security` shellout for a fake (null restores the real
 * one) and clear the memo plus the announce-once state, so no unit test ever
 * reads the developer's actual keychain.
 */
export function __setCertificateListerForTests(lister: CertificateLister | null): void {
  certificateLister = lister ?? listCertificatePem;
  memoizedTeams = null;
  announcedTeams.clear();
  pendingNotes.clear();
}
