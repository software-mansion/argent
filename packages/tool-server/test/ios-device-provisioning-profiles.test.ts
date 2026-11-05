import { afterEach, describe, expect, it } from "vitest";
import {
  __setProfileReaderForTests,
  parseProvisioningProfile,
  teamsCoveringDevice,
} from "../src/utils/ios-device/provisioning-profiles";

const UDID = "00008120-001668913A05A01E";
const FUTURE = Date.now() + 86_400_000;

const PROFILE = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>ExpirationDate</key>
  <date>2027-11-02T10:00:00Z</date>
  <key>Name</key>
  <string>iOS Team Provisioning Profile: *</string>
  <key>ProvisionedDevices</key>
  <array>
    <string>${UDID}</string>
    <string>00008110-001455603CF8801E</string>
  </array>
  <key>TeamIdentifier</key>
  <array>
    <string>TEAMAAAAAA</string>
  </array>
</dict></plist>`;

afterEach(() => __setProfileReaderForTests(null));

describe("parseProvisioningProfile", () => {
  it("reads the team, the devices and the expiry", () => {
    expect(parseProvisioningProfile(PROFILE)).toEqual({
      teamIds: ["TEAMAAAAAA"],
      devices: [UDID, "00008110-001455603CF8801E"],
      expiresAtMs: Date.parse("2027-11-02T10:00:00Z"),
    });
  });

  it("treats a profile with no device list, like a distribution profile, as listing none", () => {
    const profile = parseProvisioningProfile(
      "<dict><key>TeamIdentifier</key><array><string>TEAMAAAAAA</string></array></dict>"
    );
    expect(profile.devices).toEqual([]);
    expect(profile.expiresAtMs).toBe(0);
  });
});

describe("teamsCoveringDevice", () => {
  it("names teams with an unexpired profile listing the device", async () => {
    __setProfileReaderForTests(async () => [
      { teamIds: ["TEAMAAAAAA"], devices: [UDID], expiresAtMs: FUTURE },
      { teamIds: ["TEAMBBBBBB"], devices: ["other"], expiresAtMs: FUTURE },
      { teamIds: ["TEAMCCCCCC"], devices: [UDID], expiresAtMs: Date.now() - 1 },
    ]);
    expect([...(await teamsCoveringDevice(UDID))]).toEqual(["TEAMAAAAAA"]);
  });

  it("knows of no team when the profiles cannot be read", async () => {
    __setProfileReaderForTests(async () => {
      throw new Error("no security tool");
    });
    expect((await teamsCoveringDevice(UDID)).size).toBe(0);
  });
});
