import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { readConfigObject, updateConfig } from "../src/config.js";
import { getWhatsNewSeenVersion, setWhatsNewSeenVersion } from "../src/whats-new.js";

let homeDir: string;

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-whats-new-"));
});

afterEach(() => {
  fs.rmSync(homeDir, { recursive: true, force: true });
});

describe("whats-new seen version", () => {
  it("is null before anything is recorded", () => {
    expect(getWhatsNewSeenVersion({ homeDir })).toBeNull();
  });

  it("reads back the recorded version", () => {
    setWhatsNewSeenVersion("0.34.0", { homeDir });
    expect(getWhatsNewSeenVersion({ homeDir })).toBe("0.34.0");
  });

  it("lets only the first session claim an update from the same seen version", () => {
    setWhatsNewSeenVersion("0.33.0", { homeDir });
    const snapshot = { homeDir, ifSeen: "0.33.0" };
    expect(setWhatsNewSeenVersion("0.35.0", snapshot)).toBe(true);
    expect(setWhatsNewSeenVersion("0.34.0", snapshot)).toBe(false);
    expect(getWhatsNewSeenVersion({ homeDir })).toBe("0.35.0");
  });

  it("keeps the other notices", () => {
    updateConfig((config) => (config.notices = { first_run_shown: true }), "global", { homeDir });
    setWhatsNewSeenVersion("0.34.0", { homeDir });
    expect(readConfigObject("global", { homeDir }).notices).toEqual({
      first_run_shown: true,
      whats_new_seen: "0.34.0",
    });
  });
});
