/**
 * Issue #1721: Xcode's `simctl`/`devicectl` wrappers start a component install
 * that waits for an administrator password when the framework they wrap is
 * missing or older than they expect. The check reads the same two files the
 * wrapper does, so it can say so without starting anything.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  __resetXcodeFirstLaunchCacheForTests,
  xcodeFirstLaunchPending,
} from "../src/utils/xcode-first-launch";

const realPlatform = process.platform;
const realDeveloperDir = process.env.DEVELOPER_DIR;
let root: string;
let devDir: string;
let plistPath: string;

/** The `simctl` wrapper shape of Xcode 27: runs the install when the framework is missing or older. */
function olderRuleWrapper(expected: string, plist: string): string {
  return [
    "#!/bin/bash",
    `EXPECTED_VERSION="${expected}"`,
    `CURRENT_VERSION="$(/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" "${plist}" 2>/dev/null)"`,
    'if [[ -z "${CURRENT_VERSION}" ]] || version_is_older "${CURRENT_VERSION}" "${EXPECTED_VERSION}"; then',
    '    "${DEVELOPER_DIR}/usr/bin/xcodebuild" -runFirstLaunch >&2',
    "fi",
    'exec "/real/simctl" "${@}"',
    "",
  ].join("\n");
}

/** The shape of Xcode 26's `simctl` and of `devicectl`: runs the install on any mismatch. */
function exactRuleWrapper(expected: string, plist: string): string {
  return [
    "#!/bin/zsh",
    `EXPECTED_VERSION="${expected}"`,
    `CURRENT_VERSION="$(/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" "${plist}" 2>&1)"`,
    'if [[ "${EXPECTED_VERSION}" != "${CURRENT_VERSION}" ]]; then',
    '    "${DEVELOPER_DIR}/usr/bin/xcodebuild" -runFirstLaunch',
    "fi",
    'exec "/real/devicectl" "${@}"',
    "",
  ].join("\n");
}

function writeWrapper(tool: "simctl" | "devicectl", text: string, dir = devDir): void {
  fs.mkdirSync(path.join(dir, "usr", "bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, "usr", "bin", tool), text);
}

/** Replace the plist the way an installer does: a new file renamed over the old one. */
function installFramework(version: string): void {
  const next = `${plistPath}.next`;
  fs.writeFileSync(
    next,
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n` +
      `\t<key>CFBundleIdentifier</key>\n\t<string>com.apple.CoreSimulator</string>\n` +
      `\t<key>CFBundleVersion</key>\n\t<string>${version}</string>\n</dict>\n</plist>\n`
  );
  fs.renameSync(next, plistPath);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "xcode-first-launch-"));
  devDir = path.join(root, "Xcode.app", "Contents", "Developer");
  plistPath = path.join(root, "Info.plist");
  process.env.DEVELOPER_DIR = devDir;
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  __resetXcodeFirstLaunchCacheForTests();
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
  if (realDeveloperDir === undefined) delete process.env.DEVELOPER_DIR;
  else process.env.DEVELOPER_DIR = realDeveloperDir;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("xcodeFirstLaunchPending", () => {
  it("is false when the installed framework is the expected version", () => {
    writeWrapper("simctl", olderRuleWrapper("1174.21", plistPath));
    installFramework("1174.21");
    expect(xcodeFirstLaunchPending("simctl")).toBe(false);
  });

  it("is true after an Xcode update leaves the framework older than the wrapper expects", () => {
    writeWrapper("simctl", olderRuleWrapper("1175.5", plistPath));
    installFramework("1174.21");
    expect(xcodeFirstLaunchPending("simctl")).toBe(true);
  });

  it("is true when the framework is not installed at all", () => {
    writeWrapper("simctl", olderRuleWrapper("1174.21", plistPath));
    expect(xcodeFirstLaunchPending("simctl")).toBe(true);
  });

  it("compares numerically and ignores trailing .0 parts, as the wrapper does", () => {
    writeWrapper("simctl", olderRuleWrapper("1174.21.0", plistPath));
    installFramework("1174.21");
    expect(xcodeFirstLaunchPending("simctl")).toBe(false);
    writeWrapper("simctl", olderRuleWrapper("1174.21", plistPath));
    installFramework("1174.21.0");
    expect(xcodeFirstLaunchPending("simctl")).toBe(false);
    installFramework("1174.3");
    expect(xcodeFirstLaunchPending("simctl")).toBe(true);
    installFramework("1174.100");
    expect(xcodeFirstLaunchPending("simctl")).toBe(false);
  });

  it("is true for an exact-match wrapper whose framework is older", () => {
    writeWrapper("devicectl", exactRuleWrapper("651.32", plistPath));
    installFramework("518.33");
    expect(xcodeFirstLaunchPending("devicectl")).toBe(true);
  });

  it("is false for an exact-match wrapper whose framework is newer, so an older Xcode stays usable", () => {
    writeWrapper("simctl", exactRuleWrapper("1051.55", plistPath));
    installFramework("1174.21");
    expect(xcodeFirstLaunchPending("simctl")).toBe(false);
  });

  it("checks each wrapper against its own framework", () => {
    const corePlist = path.join(root, "CoreDevice.plist");
    writeWrapper("simctl", olderRuleWrapper("1174.21", plistPath));
    writeWrapper("devicectl", exactRuleWrapper("651.32", corePlist));
    installFramework("1174.21");
    expect(xcodeFirstLaunchPending("simctl")).toBe(false);
    expect(xcodeFirstLaunchPending("devicectl")).toBe(true);
  });

  it("notices an install finished mid-session without a restart", () => {
    writeWrapper("simctl", olderRuleWrapper("1175.5", plistPath));
    installFramework("1174.21");
    expect(xcodeFirstLaunchPending("simctl")).toBe(true);
    installFramework("1175.5");
    expect(xcodeFirstLaunchPending("simctl")).toBe(false);
  });

  it("notices a wrapper replaced by an Xcode update without a restart", () => {
    writeWrapper("simctl", olderRuleWrapper("1174.21", plistPath));
    installFramework("1174.21");
    expect(xcodeFirstLaunchPending("simctl")).toBe(false);
    const next = path.join(devDir, "usr", "bin", "simctl.next");
    fs.writeFileSync(next, olderRuleWrapper("1175.5", plistPath));
    fs.renameSync(next, path.join(devDir, "usr", "bin", "simctl"));
    expect(xcodeFirstLaunchPending("simctl")).toBe(true);
  });

  it("accepts DEVELOPER_DIR naming the app bundle rather than its Developer directory", () => {
    writeWrapper("simctl", olderRuleWrapper("1175.5", plistPath));
    installFramework("1174.21");
    process.env.DEVELOPER_DIR = path.join(root, "Xcode.app");
    expect(xcodeFirstLaunchPending("simctl")).toBe(true);
  });

  describe("never blocks when it cannot tell", () => {
    it("with no wrapper at the developer directory", () => {
      installFramework("1");
      expect(xcodeFirstLaunchPending("simctl")).toBe(false);
    });

    it("with a binary where the wrapper would be", () => {
      writeWrapper("simctl", "Ïúíþ binary");
      expect(xcodeFirstLaunchPending("simctl")).toBe(false);
    });

    it("with a script that has no version check", () => {
      writeWrapper("simctl", '#!/bin/bash\nexec "/real/simctl" "$@"\n');
      expect(xcodeFirstLaunchPending("simctl")).toBe(false);
    });

    it("with a framework plist it cannot read a version from", () => {
      writeWrapper("simctl", olderRuleWrapper("1175.5", plistPath));
      fs.writeFileSync(plistPath, "<plist><dict></dict></plist>");
      expect(xcodeFirstLaunchPending("simctl")).toBe(false);
    });

    it("with a version check that no longer starts the install", () => {
      writeWrapper(
        "simctl",
        olderRuleWrapper("1175.5", plistPath).replace(
          '"${DEVELOPER_DIR}/usr/bin/xcodebuild" -runFirstLaunch >&2',
          'echo "CoreSimulator is out of date" >&2'
        )
      );
      installFramework("1174.21");
      expect(xcodeFirstLaunchPending("simctl")).toBe(false);
    });

    it("with a framework plist that exists but cannot be read", () => {
      writeWrapper("simctl", olderRuleWrapper("1175.5", plistPath));
      fs.mkdirSync(plistPath);
      expect(xcodeFirstLaunchPending("simctl")).toBe(false);
    });

    // Root reads a mode-000 file anyway, so the failed read cannot be staged.
    it.skipIf(process.getuid?.() === 0)("and asks again once a failed read succeeds", () => {
      writeWrapper("simctl", olderRuleWrapper("1175.5", plistPath));
      installFramework("1174.21");
      fs.chmodSync(plistPath, 0o000);
      try {
        expect(xcodeFirstLaunchPending("simctl")).toBe(false);
      } finally {
        fs.chmodSync(plistPath, 0o644);
      }
      // Same file, same stamp: only a remembered failure would answer false here.
      expect(xcodeFirstLaunchPending("simctl")).toBe(true);
    });

    it("with a version that is not purely numeric", () => {
      writeWrapper("simctl", olderRuleWrapper("1175.5", plistPath));
      installFramework("1174.21b");
      expect(xcodeFirstLaunchPending("simctl")).toBe(false);
    });

    it("off macOS", () => {
      writeWrapper("simctl", olderRuleWrapper("1175.5", plistPath));
      installFramework("1174.21");
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      expect(xcodeFirstLaunchPending("simctl")).toBe(false);
    });
  });

  it.skipIf(realPlatform !== "darwin")("reads a binary plist, as CoreDevice ships", () => {
    writeWrapper("devicectl", exactRuleWrapper("651.32", plistPath));
    installFramework("518.33");
    execFileSync("/usr/bin/plutil", ["-convert", "binary1", plistPath]);
    expect(fs.readFileSync(plistPath).subarray(0, 8).toString("latin1")).toBe("bplist00");
    expect(xcodeFirstLaunchPending("devicectl")).toBe(true);
  });
});
