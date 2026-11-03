import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Xcode's `simctl` and `devicectl` are shell wrappers. Each reads the installed
 * framework's `CFBundleVersion`, compares it with an `EXPECTED_VERSION`, and on
 * a mismatch runs `xcodebuild -runFirstLaunch` before exec'ing the real binary.
 * After an Xcode update that install needs an administrator password, and run
 * from a background process it waits for one forever. Every call then hangs
 * and leaves another password request behind.
 *
 * This module answers "would the wrapper start that install?" by reading the
 * same two files the wrapper reads, so asking never triggers a prompt.
 */
export type XcodeWrapper = "simctl" | "devicectl";

/** What the agent is told when a wrapper would start the install. */
export const XCODE_FIRST_LAUNCH_HINT =
  "Xcode has not finished installing its system components since it was installed or updated. " +
  "Until it has, Xcode's `simctl` or `devicectl` waits for an administrator password on every " +
  "call, so argent does not run them and local iOS simulators or physical iPhones are " +
  "unavailable. Ask the user to open Xcode once and let it install the components, or to run " +
  "`sudo xcodebuild -runFirstLaunch`, then retry. Do not run it yourself.";

const XCODE_LOCATIONS = {
  /** What `xcode-select -s` writes. */
  selectLink: "/var/db/xcode_select_link",
  /** What `xcode-select -p` answers without the link. */
  defaultDeveloperDir: "/Applications/Xcode.app/Contents/Developer",
};
let locations = XCODE_LOCATIONS;

/**
 * The developer directory `xcrun` would use, resolved the way `xcode-select`
 * does but without spawning it: `DEVELOPER_DIR`, then the link that
 * `xcode-select -s` writes, then the default Xcode location. Like
 * `xcode-select`, it uses `Contents/Developer` of any directory that has one,
 * whatever the directory's name, and it does not trim the value.
 */
function activeDeveloperDir(): string | null {
  let dir = process.env.DEVELOPER_DIR || null;
  if (!dir) {
    try {
      dir = fs.readlinkSync(locations.selectLink);
    } catch {
      dir = fs.existsSync(locations.defaultDeveloperDir) ? locations.defaultDeveloperDir : null;
    }
  }
  if (!dir) return null;
  const bundled = path.resolve(dir, "Contents", "Developer");
  return isDirectory(bundled) ? bundled : path.resolve(dir);
}

function isDirectory(file: string): boolean {
  try {
    return fs.statSync(file).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The two checks Xcode has shipped. Both run the install for an older
 * framework. For a missing one `PlistBuddy` prints an error instead of a
 * version: the `!=` check (Xcode 26's `simctl`, every `devicectl`) sees a
 * mismatch and runs it, the `version_is_older` check (Xcode 27's `simctl`)
 * sorts the text after any version and does not.
 */
type WrapperRule = "older" | "different";

interface WrapperCheck {
  expected: string;
  plistPath: string;
  rule: WrapperRule;
}

/** The install call itself; a message that merely names it does not count. */
const INSTALL_CALL = /^\s*"\$\{DEVELOPER_DIR\}\/usr\/bin\/xcodebuild" -runFirstLaunch\b/m;
const OLDER_RULE = /version_is_older "\$\{CURRENT_VERSION\}" "\$\{EXPECTED_VERSION\}"/;
const DIFFERENT_RULE = /\[\[ "\$\{EXPECTED_VERSION\}" != "\$\{CURRENT_VERSION\}" \]\]/;

/**
 * The version check in a wrapper script. "unrecognised" for anything that is
 * not one of the known shapes, literal values included: a path built from a
 * shell variable cannot be read here. "unreadable" when reading failed, which
 * is worth trying again.
 */
function parseWrapper(file: string): WrapperCheck | "unrecognised" | "unreadable" {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "unrecognised" : "unreadable";
  }
  const expected = /^EXPECTED_VERSION="([^"$]+)"$/m.exec(text)?.[1];
  const plistPath = /Print :CFBundleVersion" "(\/[^"$]+)"/.exec(text)?.[1];
  const rule = OLDER_RULE.test(text) ? "older" : DIFFERENT_RULE.test(text) ? "different" : null;
  if (!expected || !plistPath || !rule || !INSTALL_CALL.test(text)) return "unrecognised";
  return { expected, plistPath, rule };
}

/**
 * `CFBundleVersion` of a plist. "missing" when the file does not exist; null
 * when it exists but no version can be read from it.
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
 * True when the active Xcode's `wrapper` would run `xcodebuild -runFirstLaunch`:
 * its framework is older than the wrapper expects, or missing where the
 * wrapper's check treats that as a mismatch. An Xcode update leaves this state
 * behind until the components are installed.
 *
 * False whenever nothing can be concluded (not macOS, no Xcode, an
 * unrecognised wrapper, a version that cannot be read), so an unexpected layout
 * never blocks a working setup. Also false for a framework newer than expected:
 * the `!=` check runs the install then too, but nothing is missing, so it is
 * not the state that hangs.
 *
 * Synchronous and spawn-free for `simctl` (its plist is XML), so it can guard
 * every argv builder. The answer is cached until one of the two files changes,
 * so an install finished mid-session is picked up on the next call. A failed
 * read is tried again on the next call rather than remembered.
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
  if (check === "unreadable") return false;
  if (check === "unrecognised") {
    cache.set(wrapper, {
      wrapperPath,
      wrapperStamp,
      plistPath: null,
      plistStamp: "",
      pending: false,
    });
    return false;
  }
  const plistStamp = fileStamp(check.plistPath);
  const installed = readBundleVersion(check.plistPath);
  if (installed === null) return false;
  const pending =
    installed === "missing"
      ? check.rule === "different"
      : compareVersions(installed, check.expected) === -1;
  cache.set(wrapper, {
    wrapperPath,
    wrapperStamp,
    plistPath: check.plistPath,
    plistStamp,
    pending,
  });
  return pending;
}

/** Test-only: forget cached answers. */
export function __resetXcodeFirstLaunchCacheForTests(): void {
  cache.clear();
}

/** Test-only: move the `xcode-select` link and the default Xcode; no argument restores them. */
export function __setXcodeLocationsForTests(next?: typeof XCODE_LOCATIONS): void {
  locations = next ?? XCODE_LOCATIONS;
  cache.clear();
}
