import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hasDefaultBootSnapshot, resolveAvdPath } from "../src/utils/adb";

// Env vars `resolveAvdPath` consults. Snapshot them up-front so a failing
// assertion can't leak ANDROID_* state into adjacent suites (vitest reuses
// workers between files and a stray ANDROID_USER_HOME would silently retarget
// any AVD-aware test that runs next).
const ENV_KEYS = [
  "HOME",
  "ANDROID_USER_HOME",
  "ANDROID_AVD_HOME",
  "ANDROID_SDK_HOME",
  "XDG_CONFIG_HOME",
] as const;
const originalEnv: Record<string, string | undefined> = {};

async function writeAvdIni(root: string, avdName: string, avdPath: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, `${avdName}.ini`),
    [
      "avd.ini.encoding=UTF-8",
      `path=${avdPath}`,
      `path.rel=avd/${avdName}.avd`,
      "target=android-34",
      "",
    ].join("\n")
  );
}

interface SnapshotOptions {
  ramBytes?: number;
  ramMtimeMs?: number;
  snapshotMtimeMs?: number;
  withoutSnapshotPb?: boolean;
  withoutRamBin?: boolean;
}

async function writeDefaultBootSnapshot(
  avdPath: string,
  opts: SnapshotOptions = {}
): Promise<void> {
  const dir = join(avdPath, "snapshots", "default_boot");
  await mkdir(dir, { recursive: true });
  if (!opts.withoutSnapshotPb) {
    const pb = join(dir, "snapshot.pb");
    await writeFile(pb, Buffer.alloc(1024));
    if (opts.snapshotMtimeMs !== undefined) {
      const t = opts.snapshotMtimeMs / 1000;
      await utimes(pb, t, t);
    }
  }
  if (!opts.withoutRamBin) {
    const ram = join(dir, "ram.bin");
    await writeFile(ram, Buffer.alloc(opts.ramBytes ?? 4096));
    if (opts.ramMtimeMs !== undefined) {
      const t = opts.ramMtimeMs / 1000;
      await utimes(ram, t, t);
    }
  }
}

describe("resolveAvdPath", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
    tmpRoot = await mkdtemp(join(tmpdir(), "argent-avd-snapshot-"));
    // Force HOME into the temp tree so a stray ~/.android on the host
    // running the suite cannot accidentally satisfy a lookup.
    process.env.HOME = join(tmpRoot, "home");
    await mkdir(process.env.HOME, { recursive: true });
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
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("resolves the path from $HOME/.android/avd/<name>.ini when no env vars are set", async () => {
    const avdRoot = join(process.env.HOME!, ".android", "avd");
    const avdPath = join(avdRoot, "Pixel_7.avd");
    await mkdir(avdPath, { recursive: true });
    await writeAvdIni(avdRoot, "Pixel_7", avdPath);

    expect(await resolveAvdPath("Pixel_7")).toBe(avdPath);
  });

  it("reads the `path=` line even when the .avd folder lives outside the convention root", async () => {
    // Studio lets users move AVDs onto a faster disk; the `.ini` stays in the
    // convention root but `path=` points at the relocated `.avd`. The old
    // code that assumed `<root>/<name>.avd` would miss the snapshot entirely.
    const iniRoot = join(process.env.HOME!, ".android", "avd");
    const avdPath = join(tmpRoot, "fast-disk", "Pixel_7.avd");
    await mkdir(avdPath, { recursive: true });
    await writeAvdIni(iniRoot, "Pixel_7", avdPath);

    expect(await resolveAvdPath("Pixel_7")).toBe(avdPath);
  });

  it("prefers $ANDROID_USER_HOME/avd over $ANDROID_AVD_HOME and the default HOME path", async () => {
    // Mirror the emulator binary's priority order so the resolver follows the
    // same AVD the binary itself will load. If priority were inverted, our
    // pre-check could read a stale snapshot from $HOME while the binary later
    // loads a different (or absent) snapshot from $ANDROID_USER_HOME.
    const userHomeRoot = join(tmpRoot, "user-home", "avd");
    const avdHomeRoot = join(tmpRoot, "avd-home");
    const homeRoot = join(process.env.HOME!, ".android", "avd");

    await writeAvdIni(userHomeRoot, "Pixel_7", "/from/user-home");
    await writeAvdIni(avdHomeRoot, "Pixel_7", "/from/avd-home");
    await writeAvdIni(homeRoot, "Pixel_7", "/from/home");

    process.env.ANDROID_USER_HOME = join(tmpRoot, "user-home");
    process.env.ANDROID_AVD_HOME = avdHomeRoot;

    expect(await resolveAvdPath("Pixel_7")).toBe("/from/user-home");
  });

  it("falls back to $ANDROID_AVD_HOME when ANDROID_USER_HOME is unset", async () => {
    const avdHomeRoot = join(tmpRoot, "avd-home");
    await writeAvdIni(avdHomeRoot, "Pixel_7", "/from/avd-home");
    process.env.ANDROID_AVD_HOME = avdHomeRoot;

    expect(await resolveAvdPath("Pixel_7")).toBe("/from/avd-home");
  });

  it("honors $XDG_CONFIG_HOME/Android/avd on Linux-style setups", async () => {
    const xdg = join(tmpRoot, "xdg");
    await writeAvdIni(join(xdg, "Android", "avd"), "Pixel_7", "/from/xdg");
    process.env.XDG_CONFIG_HOME = xdg;

    expect(await resolveAvdPath("Pixel_7")).toBe("/from/xdg");
  });

  it("honors the legacy $ANDROID_SDK_HOME/.android/avd path", async () => {
    const sdkHome = join(tmpRoot, "sdk-home");
    await writeAvdIni(join(sdkHome, ".android", "avd"), "Pixel_7", "/from/sdk-home");
    process.env.ANDROID_SDK_HOME = sdkHome;

    expect(await resolveAvdPath("Pixel_7")).toBe("/from/sdk-home");
  });

  it("returns null when no .ini is found in any candidate root", async () => {
    expect(await resolveAvdPath("DoesNotExist")).toBeNull();
  });

  it("trims trailing whitespace from the `path=` value", async () => {
    // Some Studio versions write a trailing \r on Windows; even on macOS/Linux
    // a stray space at end-of-line can slip through hand-edited .inis. We
    // don't want stat() failures because the resolved path has trailing
    // whitespace baked in.
    const avdRoot = join(process.env.HOME!, ".android", "avd");
    await mkdir(avdRoot, { recursive: true });
    await writeFile(
      join(avdRoot, "Pixel_7.ini"),
      ["avd.ini.encoding=UTF-8", "path=  /some/where/Pixel_7.avd  ", ""].join("\n")
    );

    expect(await resolveAvdPath("Pixel_7")).toBe("/some/where/Pixel_7.avd");
  });

  it("rejects a whitespace-only `path=` value as if the .ini were missing", async () => {
    // The non-greedy `(.+?)` in the regex still captures a single space for
    // `path=   ` because it must match at least one character. Without a
    // post-match trim+absolute-path guard, callers would receive " " as a
    // valid path — truthy in JS, so the `if (!avdPath)` short-circuit in
    // `hasDefaultBootSnapshot` would not fire and a downstream stat would
    // silently target the wrong location.
    const avdRoot = join(process.env.HOME!, ".android", "avd");
    await mkdir(avdRoot, { recursive: true });
    await writeFile(
      join(avdRoot, "Pixel_7.ini"),
      ["avd.ini.encoding=UTF-8", "path=   ", ""].join("\n")
    );

    expect(await resolveAvdPath("Pixel_7")).toBeNull();
  });

  it("rejects a relative `path=` value (the emulator binary always writes an absolute path)", async () => {
    // A relative path would `stat` against `process.cwd()` here, silently
    // mis-locating the snapshot to wherever the tool-server happens to have
    // been launched from. Real .ini files always carry an absolute path, so
    // anything else is a corrupt/hand-edited file we should ignore in favor
    // of the next candidate root.
    const avdRoot = join(process.env.HOME!, ".android", "avd");
    await mkdir(avdRoot, { recursive: true });
    await writeFile(
      join(avdRoot, "Pixel_7.ini"),
      ["avd.ini.encoding=UTF-8", "path=relative/Pixel_7.avd", ""].join("\n")
    );

    expect(await resolveAvdPath("Pixel_7")).toBeNull();
  });

  it("falls through to a later candidate when an earlier .ini has a bad path", async () => {
    // The bad-path case should not poison the whole lookup — if a later
    // root has a healthy .ini, we should still find the AVD there.
    const userHomeRoot = join(tmpRoot, "user-home", "avd");
    await writeAvdIni(userHomeRoot, "Pixel_7", "relative/oops");
    const homeRoot = join(process.env.HOME!, ".android", "avd");
    await writeAvdIni(homeRoot, "Pixel_7", "/from/home/Pixel_7.avd");
    process.env.ANDROID_USER_HOME = join(tmpRoot, "user-home");

    expect(await resolveAvdPath("Pixel_7")).toBe("/from/home/Pixel_7.avd");
  });
});

describe("hasDefaultBootSnapshot", () => {
  let tmpRoot: string;
  let avdPath: string;

  beforeEach(async () => {
    for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
    tmpRoot = await mkdtemp(join(tmpdir(), "argent-avd-snapshot-"));
    process.env.HOME = join(tmpRoot, "home");
    const avdRoot = join(process.env.HOME, ".android", "avd");
    avdPath = join(avdRoot, "Pixel_7.avd");
    await mkdir(avdPath, { recursive: true });
    await writeAvdIni(avdRoot, "Pixel_7", avdPath);
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
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("returns true when both ram.bin and snapshot.pb exist and ram.bin is non-empty", async () => {
    await writeDefaultBootSnapshot(avdPath);
    expect(await hasDefaultBootSnapshot("Pixel_7")).toBe(true);
  });

  it("returns true even when snapshot.pb is days newer than ram.bin", async () => {
    // Regression for the cold-boot-every-time bug: the emulator updates
    // `snapshot.pb` on every load (load count, last-loaded timestamp), even
    // with `-no-snapshot-save`. After a few hot-boot sessions the two mtimes
    // drift by hours or days. The old 60s skew guard rejected every such
    // (perfectly valid) snapshot and forced a cold boot. The `-check-
    // snapshot-loadable` probe + `-force-snapshot-load` already validate the
    // restore at spawn time, so the on-disk pre-check must be lenient here.
    const now = Date.now();
    await writeDefaultBootSnapshot(avdPath, {
      ramMtimeMs: now - 4 * 24 * 60 * 60 * 1000, // 4 days old
      snapshotMtimeMs: now,
    });
    expect(await hasDefaultBootSnapshot("Pixel_7")).toBe(true);
  });

  it("returns false when ram.bin is zero-length", async () => {
    // OOM-killed mid-save: tiny `snapshot.pb` survives but `ram.bin` is
    // truncated to zero. `-check-snapshot-loadable` only inspects metadata
    // and would still say "Loadable", so the on-disk pre-check is the line
    // of defense against this class of partial save.
    await writeDefaultBootSnapshot(avdPath, { ramBytes: 0 });
    expect(await hasDefaultBootSnapshot("Pixel_7")).toBe(false);
  });

  it("returns false when ram.bin is missing", async () => {
    await writeDefaultBootSnapshot(avdPath, { withoutRamBin: true });
    expect(await hasDefaultBootSnapshot("Pixel_7")).toBe(false);
  });

  it("returns false when snapshot.pb is missing", async () => {
    await writeDefaultBootSnapshot(avdPath, { withoutSnapshotPb: true });
    expect(await hasDefaultBootSnapshot("Pixel_7")).toBe(false);
  });

  it("returns false when the AVD .ini is missing entirely", async () => {
    expect(await hasDefaultBootSnapshot("DoesNotExist")).toBe(false);
  });

  it("finds the snapshot when the .avd folder is relocated outside the convention root", async () => {
    // The bug's other half: Linux setups (snap-installed Studio, AVDs moved
    // to faster disk) put the `.avd` folder somewhere `<root>/<name>.avd`
    // would never find. Reading `path=` from the `.ini` is what makes the
    // pre-check robust to those layouts.
    const relocated = join(tmpRoot, "fast-disk", "Pixel_7.avd");
    await mkdir(relocated, { recursive: true });
    await writeDefaultBootSnapshot(relocated);
    // Overwrite the ini so it points at the relocated folder instead.
    await writeAvdIni(join(process.env.HOME!, ".android", "avd"), "Pixel_7", relocated);

    expect(await hasDefaultBootSnapshot("Pixel_7")).toBe(true);
  });
});
