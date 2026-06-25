// resolveAvdPath reads `path=` out of an AVD's `<name>.ini`. It now parses the
// file with the `ini` package instead of a `^path=…$`-anchored regex. This
// covers a real failure mode of the old regex: a quoted value (the captured
// string kept its surrounding quotes, so the `startsWith("/")` guard rejected
// an otherwise-valid absolute path).

import { describe, it, expect, afterEach } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveAvdPath } from "../src/utils/adb";

const prevAvdHome = process.env.ANDROID_AVD_HOME;
const created: string[] = [];

afterEach(async () => {
  if (prevAvdHome === undefined) delete process.env.ANDROID_AVD_HOME;
  else process.env.ANDROID_AVD_HOME = prevAvdHome;
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
});
