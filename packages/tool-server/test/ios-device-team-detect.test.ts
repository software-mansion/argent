import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __setCertificateListerForTests,
  announceDetectedSigningTeam,
  buildSigningDetectionNote,
  consumePendingSigningDetectionNote,
  detectSigningTeams,
  parseSigningTeams,
  type DetectedSigningTeam,
  signingLabel,
} from "../src/utils/ios-device/team-detect";
import {
  NO_TEAM_PEM,
  TEAM_A_PEM,
  TEAM_B_OLDER_PEM,
  TEAM_B_PEM,
  TIE_A_PEM,
  TIE_B_PEM,
} from "./fixtures/signing-certs";

// Every case pins the lister seam, so this suite never reads the developer's
// real keychain; the seam reset also clears the memo and the announce-once
// state between cases.
beforeEach(() => __setCertificateListerForTests(async () => ""));
afterEach(() => __setCertificateListerForTests(null));

describe("signingLabel", () => {
  it("keeps the certificate kind and key id and drops the account identity", () => {
    expect(signingLabel("Apple Development: alice@example.com (ALICEKEY01)")).toBe(
      "Apple Development (ALICEKEY01)"
    );
    expect(signingLabel("iPhone Developer: Alice Example (ALICEKEY01)")).toBe(
      "iPhone Developer (ALICEKEY01)"
    );
  });

  it("falls back to the kind alone when the CN has no key id", () => {
    expect(signingLabel("Apple Development: alice@example.com")).toBe("Apple Development");
    expect(signingLabel("Apple Development")).toBe("Apple Development");
  });
});

describe("parseSigningTeams", () => {
  it("reads team id (OU), the redacted label (CN) and notBefore out of a PEM block", () => {
    const teams = parseSigningTeams(TEAM_A_PEM);

    expect(teams).toEqual([
      {
        teamId: "ABCDE12345",
        label: "Apple Development (ALICEKEY01)",
        issuedAtMs: Date.parse("2024-01-15T12:00:00Z"),
      },
    ]);
  });

  it("orders distinct teams newest certificate first", () => {
    // TEAM_A (2024) deliberately precedes TEAM_B (2025) in the input, so the
    // order below can only come from the notBefore sort.
    const teams = parseSigningTeams([TEAM_A_PEM, TEAM_B_PEM].join("\n"));

    expect(teams.map((t) => t.teamId)).toEqual(["FGHIJ67890", "ABCDE12345"]);
  });

  it("dedups by team id, keeping the team's newest certificate", () => {
    // The older FGHIJ67890 certificate comes last, so "newest wins" cannot be
    // an accident of insertion order.
    const teams = parseSigningTeams([TEAM_B_OLDER_PEM, TEAM_B_PEM].join("\n"));

    expect(teams).toHaveLength(1);
    expect(teams[0]).toMatchObject({
      teamId: "FGHIJ67890",
      label: "Apple Development (BOBKEY0002)",
    });
  });

  it("breaks a shared notBefore deterministically by team id", () => {
    const forward = parseSigningTeams([TIE_A_PEM, TIE_B_PEM].join("\n"));
    const reversed = parseSigningTeams([TIE_B_PEM, TIE_A_PEM].join("\n"));

    expect(forward.map((t) => t.teamId)).toEqual(["TIEAA11111", "TIEBB22222"]);
    expect(reversed.map((t) => t.teamId)).toEqual(["TIEAA11111", "TIEBB22222"]);
  });

  it("skips blocks that do not parse and certificates without a team OU", () => {
    const garbageBlock =
      "-----BEGIN CERTIFICATE-----\nnot base64 at all!!\n-----END CERTIFICATE-----";
    const teams = parseSigningTeams([garbageBlock, NO_TEAM_PEM, TEAM_A_PEM].join("\n"));

    expect(teams.map((t) => t.teamId)).toEqual(["ABCDE12345"]);
  });

  it("returns [] for empty output and for text without PEM blocks", () => {
    expect(parseSigningTeams("")).toEqual([]);
    expect(parseSigningTeams("security: no matches found")).toEqual([]);
  });
});

describe("detectSigningTeams", () => {
  it("queries the current and the legacy common name and merges both", async () => {
    const lister = vi.fn(async (commonName: string) => {
      if (commonName === "Apple Development") return TEAM_B_PEM;
      if (commonName === "iPhone Developer") return TEAM_A_PEM;
      return "";
    });
    __setCertificateListerForTests(lister);

    const teams = await detectSigningTeams();

    expect(lister.mock.calls.map(([cn]) => cn)).toEqual(["Apple Development", "iPhone Developer"]);
    expect(teams.map((t) => t.teamId)).toEqual(["FGHIJ67890", "ABCDE12345"]);
  });

  it("memoizes a populated result for the process lifetime until the test seam resets it", async () => {
    const lister = vi.fn(async () => TEAM_A_PEM);
    __setCertificateListerForTests(lister);

    const first = await detectSigningTeams();
    const second = await detectSigningTeams();

    expect(second).toBe(first);
    // Two common names, one shellout each; the second detect hits the memo.
    expect(lister).toHaveBeenCalledTimes(2);

    __setCertificateListerForTests(lister);
    await detectSigningTeams();
    expect(lister).toHaveBeenCalledTimes(4);
  });

  it("re-detects after an empty result instead of caching it for the process lifetime", async () => {
    // The lister reads `pem` on every call, so the keychain gains a
    // certificate between the two detections without a seam reset (which
    // would clear the memo and hide the bug).
    let pem = "";
    const lister = vi.fn(async () => pem);
    __setCertificateListerForTests(lister);

    expect(await detectSigningTeams()).toEqual([]);
    expect(lister).toHaveBeenCalledTimes(2);

    pem = TEAM_A_PEM;
    const teams = await detectSigningTeams();

    expect(teams.map((t) => t.teamId)).toEqual(["ABCDE12345"]);
    expect(lister).toHaveBeenCalledTimes(4);
    // Once populated, the memo holds again.
    expect(await detectSigningTeams()).toBe(teams);
    expect(lister).toHaveBeenCalledTimes(4);
  });

  it("does not memoize a rejected detection", async () => {
    let pem: string | null = null;
    const lister = vi.fn(async () => {
      if (pem === null) throw new Error("keychain unavailable");
      return pem;
    });
    __setCertificateListerForTests(lister);

    await expect(detectSigningTeams()).rejects.toThrow("keychain unavailable");
    expect(lister).toHaveBeenCalledTimes(2);

    pem = TEAM_A_PEM;
    const teams = await detectSigningTeams();

    expect(teams.map((t) => t.teamId)).toEqual(["ABCDE12345"]);
    expect(lister).toHaveBeenCalledTimes(4);
  });
});

const ONE_TEAM: DetectedSigningTeam[] = [
  {
    teamId: "ABCDE12345",
    label: "Apple Development (ALICEKEY01)",
    issuedAtMs: Date.parse("2024-01-15T12:00:00Z"),
  },
];

const THREE_TEAMS: DetectedSigningTeam[] = [
  {
    teamId: "FGHIJ67890",
    label: "Apple Development (BOBKEY0002)",
    issuedAtMs: Date.parse("2025-06-01T09:00:00Z"),
  },
  ...ONE_TEAM,
  {
    teamId: "KLMNO13579",
    label: "Apple Development (CAROLKEY01)",
    issuedAtMs: Date.parse("2023-02-02T00:00:00Z"),
  },
];

describe("buildSigningDetectionNote", () => {
  it("names the single detected team and the override variable", () => {
    expect(buildSigningDetectionNote(ONE_TEAM)).toBe(
      "Signing the on-device runner with team ABCDE12345 " +
        "(Apple Development (ALICEKEY01)), detected from this Mac's " +
        "keychain. Set ARGENT_IOS_TEAM_ID in the tool-server's environment to override."
    );
  });

  it("lists the losing teams and the exact restart command when several exist", () => {
    expect(buildSigningDetectionNote(THREE_TEAMS)).toBe(
      "Signing the on-device runner with team FGHIJ67890 " +
        "(Apple Development (BOBKEY0002)), the newest of 3 signing " +
        "identities in this Mac's keychain. Also found: ABCDE12345 " +
        "(Apple Development (ALICEKEY01)), KLMNO13579 " +
        "(Apple Development (CAROLKEY01)). To sign under a different " +
        "team, set ARGENT_IOS_TEAM_ID in the tool-server's environment: " +
        "argent server stop && ARGENT_IOS_TEAM_ID=<team-id> argent server start --detach"
    );
  });
});

describe("announceDetectedSigningTeam", () => {
  it("logs once to stderr and stages the note for exactly one drain", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      announceDetectedSigningTeam(ONE_TEAM);
      announceDetectedSigningTeam(ONE_TEAM);

      expect(write).toHaveBeenCalledTimes(1);
      expect(write.mock.calls[0]?.[0]).toBe(
        `[ios-device-signing] ${buildSigningDetectionNote(ONE_TEAM)}\n`
      );
      expect(consumePendingSigningDetectionNote()).toBe(buildSigningDetectionNote(ONE_TEAM));
      expect(consumePendingSigningDetectionNote()).toBeNull();
    } finally {
      write.mockRestore();
    }
  });

  it("ignores an empty detection instead of announcing nothing", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      announceDetectedSigningTeam([]);

      expect(write).not.toHaveBeenCalled();
      expect(consumePendingSigningDetectionNote()).toBeNull();
    } finally {
      write.mockRestore();
    }
  });
});
