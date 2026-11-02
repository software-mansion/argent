import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Xcode's `simctl` and `devicectl` are shell wrappers. Each compares the
 * installed framework's `CFBundleVersion` with an `EXPECTED_VERSION` and, on a
 * mismatch, runs `xcodebuild -runFirstLaunch` before exec'ing the real binary.
 * After an Xcode update that install needs an administrator password, and run
 * from a background process it waits for one forever. Every `simctl` or
 * `devicectl` call then hangs and leaves another password request behind.
 *
 * This module answers "would the wrapper start that install?" by reading the
 * same two files the wrapper reads, so asking never triggers a prompt.
 */
export type XcodeWrapper = "simctl" | "devicectl";

/** What the agent is told when a wrapper would start the install. */
export const XCODE_FIRST_LAUNCH_HINT =
  "Xcode has not finished installing its system components since it was installed or updated, " +
  "so iOS simulators and devices are unavailable: every `simctl` and `devicectl` call would " +
  "wait for an administrator password. Ask the user to open Xcode once and let it install " +
  "them, or to run `sudo xcodebuild -runFirstLaunch`, then retry. Do not run it yourself.";

const SELECT_LINK = "/var/db/xcode_select_link";
const DEFAULT_DEVELOPER_DIR = "/Applications/Xcode.app/Contents/Developer";
/** The wrappers are about 1.5 KB; a binary at this path is not one. */
const WRAPPER_READ_BYTES = 8192;

/**
 * The developer directory `xcrun` would use, resolved the way `xcode-select`
 * does but without spawning it: `DEVELOPER_DIR`, then the link that
 * `xcode-select -s` writes, then the default Xcode location.
 */
function activeDeveloperDir(): string | null {
  let dir = process.env.DEVELOPER_DIR?.trim() || null;
  if (!dir) {
    try {
      dir = fs.readlinkSync(SELECT_LINK);
    } catch {
      dir = fs.existsSync(DEFAULT_DEVELOPER_DIR) ? DEFAULT_DEVELOPER_DIR : null;
    }
  }
  if (!dir) return null;
  return /\.app\/?$/.test(dir) ? path.join(dir, "Contents", "Developer") : dir;
}

interface WrapperCheck {
  expected: string;
  plistPath: string;
}

/** The version check in a wrapper script, or null when the file is not a wrapper we recognise. */
function parseWrapper(file: string): WrapperCheck | null {
  let text: string;
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(WRAPPER_READ_BYTES);
      text = buf.toString("utf8", 0, fs.readSync(fd, buf, 0, WRAPPER_READ_BYTES, 0));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  if (!text.includes("-runFirstLaunch")) return null;
  const expected = /^EXPECTED_VERSION="([^"]+)"/m.exec(text)?.[1];
  const plistPath = /Print :CFBundleVersion" "([^"]+)"/.exec(text)?.[1];
  return expected && plistPath ? { expected, plistPath } : null;
}

/**
 * `CFBundleVersion` of a plist. "missing" only when the file does not exist,
 * which the wrapper treats as an install to run; null when it exists but
 * cannot be read, which must not block anything.
 */
function readBundleVersion(plistPath: string): string | "missing" | null {
  let raw: Buffer;
  try {
    raw = fs.readFileSync(plistPath);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : null;
  }
  if (raw.subarray(0, 8).toString("latin1") !== "bplist00") {
    return (
      /<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/.exec(raw.toString("utf8"))?.[1] ??
      null
    );
  }
  // CoreDevice ships a binary plist.
  try {
    const out = execFileSync(
      "/usr/bin/plutil",
      ["-extract", "CFBundleVersion", "raw", "-o", "-", plistPath],
      {
        timeout: 5_000,
        stdio: ["ignore", "pipe", "ignore"],
      }
    );
    return out.toString("utf8").trim() || null;
  } catch {
    return null;
  }
}

/**
 * -1, 0 or 1, comparing dot-separated numbers the way the wrapper's
 * `sort --version-sort` does after it strips trailing `.0`s: a missing part
 * counts as 0. Null when either side is not purely numeric.
 */
function compareVersions(a: string, b: string): number | null {
  const parse = (v: string): number[] | null => {
    const parts = v.split(".").map(Number);
    return parts.every(Number.isInteger) ? parts : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

/** Changes whenever the file is rewritten or replaced. */
function fileStamp(file: string): string {
  try {
    const st = fs.statSync(file);
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return "missing";
  }
}

interface CachedAnswer {
  wrapperPath: string;
  wrapperStamp: string;
  plistPath: string | null;
  plistStamp: string;
  pending: boolean;
}

const cache = new Map<XcodeWrapper, CachedAnswer>();

/**
 * True when the active Xcode's `wrapper` would run `xcodebuild -runFirstLaunch`
 * because its framework is missing or older than the wrapper expects, which is
 * what an Xcode update leaves behind until the components are installed.
 *
 * False when the versions match, and when nothing can be concluded (not macOS,
 * no Xcode, an unrecognised wrapper, a version that cannot be read), so an
 * unexpected layout never blocks a working setup. Also false when the installed framework is newer: the older
 * wrappers compare with `!=` and run the install then too, but nothing is
 * missing, so it is not the state that hangs.
 *
 * Synchronous and spawn-free for `simctl` (its plist is XML), so it can guard
 * every argv builder. The answer is cached until one of the two files changes,
 * so an install finished mid-session is picked up on the next call.
 */
export function xcodeFirstLaunchPending(wrapper: XcodeWrapper): boolean {
  if (process.platform !== "darwin") return false;
  const devDir = activeDeveloperDir();
  if (!devDir) return false;
  const wrapperPath = path.join(devDir, "usr", "bin", wrapper);
  const wrapperStamp = fileStamp(wrapperPath);
  const hit = cache.get(wrapper);
  if (
    hit &&
    hit.wrapperPath === wrapperPath &&
    hit.wrapperStamp === wrapperStamp &&
    (hit.plistPath === null || hit.plistStamp === fileStamp(hit.plistPath))
  ) {
    return hit.pending;
  }

  const check = parseWrapper(wrapperPath);
  const plistPath = check?.plistPath ?? null;
  const plistStamp = plistPath ? fileStamp(plistPath) : "";
  const installed = check ? readBundleVersion(check.plistPath) : null;
  const pending =
    installed === "missing" ||
    (check !== null && installed !== null && compareVersions(installed, check.expected) === -1);
  // A read that failed is retried on the next call rather than remembered.
  if (!check || installed !== null) {
    cache.set(wrapper, { wrapperPath, wrapperStamp, plistPath, plistStamp, pending });
  }
  return pending;
}

/** Test-only: forget cached answers. */
export function __resetXcodeFirstLaunchCacheForTests(): void {
  cache.clear();
}
