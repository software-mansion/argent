import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

/**
 * Read which teams' provisioning profiles on this Mac already list a device, so
 * that the runner signs under a team that can run on it. With several teams in
 * the keychain the newest one may not have the device registered, and building
 * under it then fails with a provisioning error.
 */

const execFileAsync = promisify(execFile);

/** Where Xcode keeps profiles: the first path since Xcode 16, the second before. */
const PROFILE_DIRECTORIES = [
  path.join("Library", "Developer", "Xcode", "UserData", "Provisioning Profiles"),
  path.join("Library", "MobileDevice", "Provisioning Profiles"),
];
const PROFILE_DECODE_TIMEOUT_MS = 5_000;
const PROFILE_MAX_BYTES = 16 * 1024 * 1024;

export interface ProvisioningProfile {
  teamIds: string[];
  devices: string[];
  expiresAtMs: number;
}

function plistStrings(xml: string, key: string): string[] {
  const array = new RegExp(`<key>${key}</key>\\s*<array>([\\s\\S]*?)</array>`).exec(xml)?.[1];
  if (!array) return [];
  return [...array.matchAll(/<string>([^<]+)<\/string>/g)].map((match) => match[1]!);
}

/** Parse a decoded profile's plist. A date that does not parse counts as expired. */
export function parseProvisioningProfile(xml: string): ProvisioningProfile {
  const expiration = /<key>ExpirationDate<\/key>\s*<date>([^<]+)<\/date>/.exec(xml)?.[1];
  const expiresAtMs = expiration ? Date.parse(expiration) : Number.NaN;
  return {
    teamIds: plistStrings(xml, "TeamIdentifier"),
    devices: plistStrings(xml, "ProvisionedDevices"),
    expiresAtMs: Number.isNaN(expiresAtMs) ? 0 : expiresAtMs,
  };
}

async function readInstalledProfiles(): Promise<ProvisioningProfile[]> {
  const files = (
    await Promise.all(
      PROFILE_DIRECTORIES.map(async (directory) => {
        const absolute = path.join(homedir(), directory);
        const names = await fs.readdir(absolute).catch(() => [] as string[]);
        return names
          .filter((name) => name.endsWith(".mobileprovision"))
          .map((name) => path.join(absolute, name));
      })
    )
  ).flat();

  const decoded = await Promise.all(
    files.map((file) =>
      execFileAsync("security", ["cms", "-D", "-i", file], {
        timeout: PROFILE_DECODE_TIMEOUT_MS,
        maxBuffer: PROFILE_MAX_BYTES,
      }).then(
        ({ stdout }) => parseProvisioningProfile(stdout),
        () => null
      )
    )
  );
  return decoded.filter((profile): profile is ProvisioningProfile => profile !== null);
}

type ProfileReader = () => Promise<ProvisioningProfile[]>;
let profileReader: ProfileReader = readInstalledProfiles;

/**
 * The ids of teams with an unexpired profile that lists `udid`. Read afresh each
 * time, since a build under a team can register the device with it. A failure
 * to read profiles means no team is known to cover the device.
 */
export async function teamsCoveringDevice(udid: string): Promise<Set<string>> {
  const profiles = await profileReader().catch(() => [] as ProvisioningProfile[]);
  const now = Date.now();
  return new Set(
    profiles
      .filter((profile) => profile.expiresAtMs > now && profile.devices.includes(udid))
      .flatMap((profile) => profile.teamIds)
  );
}

/** Test-only: swap the profile reader, so no unit test reads this Mac's profiles. */
export function __setProfileReaderForTests(reader: ProfileReader | null): void {
  profileReader = reader ?? readInstalledProfiles;
}
