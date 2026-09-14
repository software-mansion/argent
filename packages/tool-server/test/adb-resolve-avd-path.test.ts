// resolveAvdPath reads `path=` out of an AVD's `<name>.ini`. It now parses the
// file with the `ini` package instead of a `^path=…$`-anchored regex. This
// covers a real failure mode of the old regex: a quoted value (the captured
// string kept its surrounding quotes, so the `startsWith("/")` guard rejected
// an otherwise-valid absolute path).

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveAvdPath } from "../src/utils/adb";

// resolveAvdPath consults five roots in priority order; ANDROID_AVD_HOME is
// only the second. Snapshot all of them, plus the pair backing the default
// root: it is os.homedir()/.android/avd, and os.homedir() reads USERPROFILE on
// Windows — where this file also runs (.github/workflows/windows-e2e.yml) — and
// HOME elsewhere. With those pinned, an ambient ANDROID_USER_HOME (the Studio
// >= 4.2 convention, which outranks ANDROID_AVD_HOME) cannot decide these
// answers.
const ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "ANDROID_USER_HOME",
  "ANDROID_AVD_HOME",
  "ANDROID_SDK_HOME",
  "XDG_CONFIG_HOME",
] as const;
const originalEnv: Record<string, string | undefined> = {};
const created: string[] = [];

beforeEach(async () => {
  for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "argent-avd-home-"));
  created.push(home);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.ANDROID_USER_HOME;
  delete process.env.ANDROID_AVD_HOME;
  delete process.env.ANDROID_SDK_HOME;
  delete process.env.XDG_CONFIG_HOME;
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
  await Promise.all(created.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function avdHomeWith(iniName: string, iniBody: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-avd-"));
  created.push(dir);
  await fs.writeFile(path.join(dir, iniName), iniBody);
  process.env.ANDROID_AVD_HOME = dir;
  return dir;
}

describe("resolveAvdPath", () => {
  it("reads a plain absolute path", async () => {
    await avdHomeWith("Pixel.ini", "target=android-34\npath=/data/avd/Pixel.avd\n");
    expect(await resolveAvdPath("Pixel")).toBe("/data/avd/Pixel.avd");
  });

  it("reads a quoted path containing spaces (the regex kept the quotes and rejected it)", async () => {
    await avdHomeWith(
      "MyAvd.ini",
      'target=android-34\npath = "/Users/My Name/.android/avd/MyAvd.avd"\n'
    );
    expect(await resolveAvdPath("MyAvd")).toBe("/Users/My Name/.android/avd/MyAvd.avd");
  });

  it("returns null when no <name>.ini exists in any root", async () => {
    await avdHomeWith("Other.ini", "path=/data/avd/Other.avd\n");
    expect(await resolveAvdPath("Missing")).toBeNull();
  });

  // Windows-only: a drive-absolute path must be accepted. The previous
  // startsWith("/") guard rejected `C:/…`, so on Windows resolveAvdPath always
  // returned null and the snapshot pre-check silently fell back to cold boot.
  // isAbsolute() (win32) accepts it. Skipped off Windows because `C:/…` is not
  // absolute under POSIX path semantics, which is the correct host behaviour.
  it.skipIf(process.platform !== "win32")("accepts a Windows drive-absolute path", async () => {
    await avdHomeWith("Win.ini", "path=C:/Users/ci/.android/avd/Win.avd\n");
    expect(await resolveAvdPath("Win")).toBe("C:/Users/ci/.android/avd/Win.avd");
  });
});
