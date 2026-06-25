import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { argentHomeDir } from "../src/paths.js";
import { snapshotEnv } from "./helpers.js";

describe("paths", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it.each(["", "   "])("treats HOME=%j as missing on POSIX", (home) => {
    const restore = snapshotEnv(["HOME"]);
    try {
      Object.defineProperty(process, "platform", { value: "darwin" });
      process.env.HOME = home;
      expect(argentHomeDir()).toBe(path.join(os.homedir(), ".argent"));
    } finally {
      restore();
    }
  });

  it.each(["", "   "])("treats USERPROFILE=%j as missing on Windows", (userProfile) => {
    const restore = snapshotEnv(["USERPROFILE"]);
    try {
      Object.defineProperty(process, "platform", { value: "win32" });
      process.env.USERPROFILE = userProfile;
      expect(argentHomeDir()).toBe(path.join(os.homedir(), ".argent"));
    } finally {
      restore();
    }
  });
});
