import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Xcode's `simctl` is a shell wrapper. It reads the installed CoreSimulator
 * framework's `CFBundleVersion`, compares it with an `EXPECTED_VERSION`, and on
 * a mismatch runs `xcodebuild -runFirstLaunch` before exec'ing the real binary.
 * After an Xcode update that install needs an administrator password, and run
 * from a background process it waits for one forever. Every call then hangs
 * and leaves another password request behind.
 *
 * This module answers "would the wrapper start that install?" by reading the
 * same two files the wrapper reads, so asking never triggers a prompt.
 */

/** Where an Xcode app bundle keeps its developer directory. */
const BUNDLED_DEVELOPER_DIR = path.join("/Contents", "Developer");

/** `word` as one shell word, so a path with a space can be pasted into a shell. */
function shellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/** The Xcode argent uses, and the shell word for its own `xcodebuild`. */
function activeXcode(): { xcode: string | null; xcodebuild: string } {
  const developerDir = activeDeveloperDir();
  const xcode = developerDir?.endsWith(BUNDLED_DEVELOPER_DIR)
    ? developerDir.slice(0, -BUNDLED_DEVELOPER_DIR.length)
    : developerDir;
  const xcodebuild = developerDir
    ? shellWord(path.join(developerDir, "usr", "bin", "xcodebuild"))
    : "xcodebuild";
  return { xcode, xcodebuild };
}

/** How to finish the install, for a log line: names the same Xcode and command as the hint. */
export function xcodeInstallInstruction(): string {
  const { xcode, xcodebuild } = activeXcode();
  return (
    `open ${xcode ? `the Xcode at ${xcode}` : "Xcode"} once, ` +
    `or run \`sudo ${xcodebuild} -runFirstLaunch\``
  );
}

/**
 * What the agent is told while `simctl` would start the install. It names the
 * Xcode whose wrapper was read: that wrapper runs its own Xcode's `xcodebuild`,
 * while a plain `sudo xcodebuild` runs the one `xcode-select` points at.
 */
export function xcodeFirstLaunchHint(): string {
  const { xcode, xcodebuild } = activeXcode();
  return (
    (xcode ? `The Xcode at ${xcode}` : "Xcode") +
    " has not finished installing its system components since it was installed or updated. " +
    "Until it has, Xcode's `simctl` waits for an administrator password on every call, so " +
    "`list-devices` does not show local iOS simulators. " +
    `Ask the user to open ${xcode ? "that Xcode" : "Xcode"} once and let it install the ` +
    `components, or to run \`sudo ${xcodebuild} -runFirstLaunch\`, then retry. ` +
    "Do not run that command or `xcrun simctl` yourself."
  );
}

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
 * whatever the directory's name, then `Xcode.app/Contents/Developer` inside it,
 * and it does not trim the value.
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
  const bundled = [
    path.resolve(dir, "Contents", "Developer"),
    path.resolve(dir, "Xcode.app", "Contents", "Developer"),
  ].find(isDirectory);
  return bundled ?? path.resolve(dir);
}

function isDirectory(file: string): boolean {
  try {
    return fs.statSync(file).isDirectory();
  } catch {
    return false;
  }
}

interface WrapperCheck {
  expected: string;
  plistPath: string;
  /**
   * The two checks Xcode's `simctl` has shipped with. Both run the install for
   * an older framework. For a missing one `PlistBuddy` prints an error instead
   * of a version: the `!=` check (Xcode 26) sees a mismatch and runs it, the
   * `version_is_older` check (Xcode 27) sorts the text after any version and
   * does not.
   */
  rule: "older" | "different";
}

/** The install call itself; a message that merely names it does not count. */
const INSTALL_CALL = /^[ \t]*"\$\{DEVELOPER_DIR\}\/usr\/bin\/xcodebuild" -runFirstLaunch\b/m;
const OLDER_RULE = /version_is_older "\$\{CURRENT_VERSION\}" "\$\{EXPECTED_VERSION\}"/;
const DIFFERENT_RULE = /\[\[ "\$\{EXPECTED_VERSION\}" != "\$\{CURRENT_VERSION\}" \]\]/;

/**
 * The version check in a wrapper script. Null when the file cannot be read, and
 * for anything that is not one of the known shapes, literal values included: a
 * path built from a shell variable cannot be read here.
 */
function parseWrapper(file: string): WrapperCheck | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const expected = /^EXPECTED_VERSION="([^"$]+)"$/m.exec(text)?.[1];
  const plistPath = /Print :CFBundleVersion" "(\/[^"$]+)"/.exec(text)?.[1];
  const rule = OLDER_RULE.test(text) ? "older" : DIFFERENT_RULE.test(text) ? "different" : null;
  if (!expected || !plistPath || !rule || !INSTALL_CALL.test(text)) return null;
  return { expected, plistPath, rule };
}

/**
 * `CFBundleVersion` of a plist. "missing" when the file does not exist; null
 * when it exists but no version can be read from it.
 */
function readBundleVersion(plistPath: string): string | "missing" | null {
  let text: string;
  try {
    text = fs.readFileSync(plistPath, "utf8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : null;
  }
  return /<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/.exec(text)?.[1] ?? null;
}

/**
 * Whether dot-separated version `a` is older than `b`, the way the wrapper's
 * `sort --version-sort` orders them after it strips trailing `.0`s: a missing
 * part counts as 0. False when either side is not purely numeric.
 */
function isOlder(a: string, b: string): boolean {
  if (![a, b].every((version) => /^\d+(\.\d+)*$/.test(version))) return false;
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0;
  }
  return false;
}

/**
 * True when the active Xcode's `simctl` would run `xcodebuild -runFirstLaunch`:
 * its framework is older than the wrapper expects, or missing where the
 * wrapper's check treats that as a mismatch. An Xcode update leaves this state
 * behind until the components are installed.
 *
 * False whenever nothing can be concluded (not macOS, no Xcode, an
 * unrecognised wrapper, a version that cannot be read), so an unexpected layout
 * never hides the simulators of a working setup. Also false for a framework
 * newer than expected: the `!=` check runs the install then too, but
 * `xcodebuild -checkFirstLaunchStatus` finds nothing to install (seen on Xcode 26.6).
 *
 * Synchronous and spawn-free. It reads both files on every call, so an install
 * finished mid-session is picked up on the next call.
 */
export function xcodeFirstLaunchPending(): boolean {
  if (process.platform !== "darwin") return false;
  const devDir = activeDeveloperDir();
  if (!devDir) return false;
  const check = parseWrapper(path.join(devDir, "usr", "bin", "simctl"));
  if (!check) return false;
  const installed = readBundleVersion(check.plistPath);
  if (installed === null) return false;
  return installed === "missing" ? check.rule === "different" : isOlder(installed, check.expected);
}

/** Test-only: move the `xcode-select` link and the default Xcode; no argument restores them. */
export function __setXcodeLocationsForTests(next?: typeof XCODE_LOCATIONS): void {
  locations = next ?? XCODE_LOCATIONS;
}
