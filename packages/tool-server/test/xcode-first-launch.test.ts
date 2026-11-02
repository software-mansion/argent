/**
 * Issue #1721: Xcode's `simctl`/`devicectl` wrappers start a component install
 * that waits for an administrator password when the framework they wrap is
 * missing or older than they expect. The check reads the same two files the
 * wrapper does, so it can say so without starting anything.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  __resetXcodeFirstLaunchCacheForTests,
  __setXcodeLocationsForTests,
  xcodeFirstLaunchPending,
} from "../src/utils/xcode-first-launch";

// The suite-wide stub pins the answer; this file tests the real check.
vi.unmock("../src/utils/xcode-first-launch");

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
  __setXcodeLocationsForTests();
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

  it("is true for a missing framework where the wrapper's != check runs the install", () => {
    writeWrapper("devicectl", exactRuleWrapper("651.32", plistPath));
    expect(xcodeFirstLaunchPending("devicectl")).toBe(true);
  });

  it("is false for a missing framework where the wrapper's older-than check does not run it", () => {
    // PlistBuddy prints an error instead of a version, which sorts after any version.
    writeWrapper("simctl", olderRuleWrapper("1174.21", plistPath));
    expect(xcodeFirstLaunchPending("simctl")).toBe(false);
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

  describe("reads the Xcode that xcrun uses", () => {
    const otherDevDir = (): string => path.join(root, "Other.app", "Contents", "Developer");

    beforeEach(() => {
      delete process.env.DEVELOPER_DIR;
      writeWrapper("simctl", olderRuleWrapper("1175.5", plistPath));
      writeWrapper("simctl", olderRuleWrapper("1174.21", plistPath), otherDevDir());
      installFramework("1174.21");
    });

    it("the one xcode-select -s chose, named by its app bundle", () => {
      const link = path.join(root, "xcode_select_link");
      fs.symlinkSync(path.join(root, "Xcode.app"), link);
      __setXcodeLocationsForTests({ selectLink: link, defaultDeveloperDir: otherDevDir() });
      expect(xcodeFirstLaunchPending("simctl")).toBe(true);
    });

    it("the one xcode-select -s chose, named by its Developer directory", () => {
      const link = path.join(root, "xcode_select_link");
      fs.symlinkSync(devDir, link);
      __setXcodeLocationsForTests({ selectLink: link, defaultDeveloperDir: otherDevDir() });
      expect(xcodeFirstLaunchPending("simctl")).toBe(true);
    });

    it("the default Xcode when nothing was chosen", () => {
      __setXcodeLocationsForTests({
        selectLink: path.join(root, "no-link"),
        defaultDeveloperDir: devDir,
      });
      expect(xcodeFirstLaunchPending("simctl")).toBe(true);
    });

    it("none when there is no Xcode at all", () => {
      __setXcodeLocationsForTests({
        selectLink: path.join(root, "no-link"),
        defaultDeveloperDir: path.join(root, "no-xcode"),
      });
      expect(xcodeFirstLaunchPending("simctl")).toBe(false);
    });

    it("DEVELOPER_DIR before the one xcode-select -s chose", () => {
      const link = path.join(root, "xcode_select_link");
      fs.symlinkSync(devDir, link);
      __setXcodeLocationsForTests({ selectLink: link, defaultDeveloperDir: devDir });
      process.env.DEVELOPER_DIR = otherDevDir();
      expect(xcodeFirstLaunchPending("simctl")).toBe(false);
    });
  });

  describe("never blocks when it cannot tell", () => {
    it("with no wrapper at the developer directory", () => {
      installFramework("1");
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

    it("with a version check that only tells the user to run the install", () => {
      writeWrapper(
        "simctl",
        olderRuleWrapper("1175.5", plistPath).replace(
          '"${DEVELOPER_DIR}/usr/bin/xcodebuild" -runFirstLaunch >&2',
          'echo "CoreSimulator is out of date. Run sudo xcodebuild -runFirstLaunch" >&2'
        )
      );
      installFramework("1174.21");
      expect(xcodeFirstLaunchPending("simctl")).toBe(false);
    });

    it("with a version check of a shape it does not know", () => {
      writeWrapper(
        "simctl",
        olderRuleWrapper("1175.5", plistPath).replace(
          'version_is_older "${CURRENT_VERSION}" "${EXPECTED_VERSION}"',
          'is_behind "${CURRENT_VERSION}"'
        )
      );
      installFramework("1174.21");
      expect(xcodeFirstLaunchPending("simctl")).toBe(false);
    });

    it("with a plist path built from a shell variable", () => {
      // With the != check a path read literally would look missing, which blocks.
      const wrapper = exactRuleWrapper("651.32", plistPath)
        .replace(`"${plistPath}"`, '"${INFO_PLIST}"')
        .replace("#!/bin/zsh\n", `#!/bin/zsh\nINFO_PLIST="${plistPath}"\n`);
      writeWrapper("devicectl", wrapper);
      installFramework("651.32");
      expect(xcodeFirstLaunchPending("devicectl")).toBe(false);
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

    it.skipIf(process.getuid?.() === 0)(
      "and asks again once a failed wrapper read succeeds",
      () => {
        writeWrapper("simctl", olderRuleWrapper("1175.5", plistPath));
        installFramework("1174.21");
        const wrapperPath = path.join(devDir, "usr", "bin", "simctl");
        fs.chmodSync(wrapperPath, 0o000);
        try {
          expect(xcodeFirstLaunchPending("simctl")).toBe(false);
        } finally {
          fs.chmodSync(wrapperPath, 0o644);
        }
        expect(xcodeFirstLaunchPending("simctl")).toBe(true);
      }
    );

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

/**
 * The fixtures above are hand-written. This holds the check to the wrappers
 * Xcode actually ships, on a Mac that has some: each one runs against a test
 * plist with its install call replaced by an echo, and has to agree with the
 * check in every state the check is meant to block or let through.
 */
const realWrappers =
  realPlatform === "darwin" && fs.existsSync("/Applications")
    ? fs
        .readdirSync("/Applications")
        .filter((name) => /^Xcode.*\.app$/.test(name))
        .flatMap((app) =>
          (["simctl", "devicectl"] as const).map((tool) => ({
            tool,
            file: path.join("/Applications", app, "Contents", "Developer", "usr", "bin", tool),
          }))
        )
        .filter(
          ({ file }) => fs.existsSync(file) && fs.readFileSync(file).includes("-runFirstLaunch")
        )
    : [];

describe.skipIf(realWrappers.length === 0)("agrees with the wrappers installed on this Mac", () => {
  it.each(realWrappers)("$file", ({ tool, file }) => {
    const text = fs.readFileSync(file, "utf8");
    const expected = /^EXPECTED_VERSION="([^"]+)"/m.exec(text)?.[1];
    const realPlist = /Print :CFBundleVersion" "([^"]+)"/.exec(text)?.[1];
    expect(expected, "EXPECTED_VERSION").toBeDefined();
    expect(realPlist, "plist path").toBeDefined();
    const pointed = text.split(realPlist!).join(plistPath);
    writeWrapper(tool, pointed);

    // The probe derives DEVELOPER_DIR from its own path, so even an install call
    // that escaped the replacement would name an xcodebuild that does not exist.
    const probeDir = path.join(root, "probe", "usr", "bin");
    fs.mkdirSync(probeDir, { recursive: true });
    const probe = path.join(probeDir, tool);
    const probeText = pointed
      .replace(
        /^(\s*)"\$\{DEVELOPER_DIR\}\/usr\/bin\/xcodebuild" -runFirstLaunch.*$/m,
        "$1echo WOULD_INSTALL"
      )
      .replace(/^exec .*$/m, "exit 0");
    expect(probeText).not.toContain("-runFirstLaunch");
    fs.writeFileSync(probe, probeText);
    const shell = text.startsWith("#!/bin/zsh") ? "/bin/zsh" : "/bin/bash";
    const wrapperInstalls = () => execFileSync(shell, [probe]).toString().includes("WOULD_INSTALL");

    for (const [state, version] of [
      ["expected", expected!],
      ["older", "1"],
      ["missing", null],
    ] as const) {
      if (version === null) fs.rmSync(plistPath, { force: true });
      else installFramework(version);
      __resetXcodeFirstLaunchCacheForTests();
      expect(xcodeFirstLaunchPending(tool), state).toBe(wrapperInstalls());
    }

    // A newer framework is let through even where the wrapper runs the install.
    installFramework("999999");
    __resetXcodeFirstLaunchCacheForTests();
    expect(xcodeFirstLaunchPending(tool)).toBe(false);
  });
});
