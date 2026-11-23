import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import semver from "semver";
import { getWhatsNewSeenVersion, setWhatsNewSeenVersion } from "@argent/configuration-core";
import { RELEASE_HIGHLIGHTS } from "../src/release-highlights.js";
import { formatWhatsNewNote, highlightsSince, takeWhatsNewNote } from "../src/whats-new.js";

const RELEASES = {
  "0.36.0": ["c1", "c2"],
  "0.35.0": ["b1", "b2", "b3"],
  "0.34.0": ["a1", "a2"],
};

describe("highlightsSince", () => {
  it("lists the releases after the seen version, newest first, up to five items", () => {
    expect(highlightsSince("0.33.0", "0.36.0", RELEASES)).toEqual(["c1", "c2", "b1", "b2", "b3"]);
  });

  it("skips the seen release and the ones newer than the running version", () => {
    expect(highlightsSince("0.34.0", "0.35.0", RELEASES)).toEqual(["b1", "b2", "b3"]);
  });

  it("lists only the running release when no version was recorded", () => {
    expect(highlightsSince(null, "0.35.0", RELEASES)).toEqual(["b1", "b2", "b3"]);
  });

  it("lists nothing for a canary of a release without highlights yet", () => {
    expect(highlightsSince("0.36.0", "0.37.0-next.2", RELEASES)).toEqual([]);
  });

  it("lists nothing when the running version is unknown", () => {
    expect(highlightsSince("0.34.0", "unknown", RELEASES)).toEqual([]);
  });
});

describe("formatWhatsNewNote", () => {
  it("names the version and lists each highlight", () => {
    expect(formatWhatsNewNote("0.35.0", ["b1", "b2"])).toBe(
      "Argent was updated to v0.35.0 before this session. Briefly tell the user what is new, then continue:\n- b1\n- b2"
    );
  });
});

describe("takeWhatsNewNote", () => {
  const savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "argent-mcp-whats-new-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("moves the record forward and returns the note for a newer version", () => {
    setWhatsNewSeenVersion("0.33.0");
    expect(takeWhatsNewNote("0.34.0")).toMatch(/^Argent was updated to v0\.34\.0/);
    expect(getWhatsNewSeenVersion()).toBe("0.34.0");
  });

  it("leaves a newer record alone, so repos on older versions do not repeat the note", () => {
    setWhatsNewSeenVersion("0.34.0");
    expect(takeWhatsNewNote("0.33.0")).toBeUndefined();
    expect(getWhatsNewSeenVersion()).toBe("0.34.0");
    expect(takeWhatsNewNote("0.34.0")).toBeUndefined();
  });
});

describe("release highlights", () => {
  const publishedVersion = (
    JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "..", "..", "argent", "package.json"), "utf8")
    ) as { version: string }
  ).version;

  it.runIf(semver.valid(publishedVersion) && !semver.prerelease(publishedVersion))(
    "has 1 to 5 highlights for the version being published",
    () => {
      const count = RELEASE_HIGHLIGHTS[publishedVersion]?.length ?? 0;
      expect(
        count >= 1 && count <= 5,
        `Add 3-5 highlights for ${publishedVersion} to packages/argent-mcp/src/release-highlights.ts`
      ).toBe(true);
    }
  );
});
