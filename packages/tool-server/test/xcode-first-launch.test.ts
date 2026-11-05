/**
 * Issue #1721: Xcode's `simctl` wrapper starts a component install that waits
 * for an administrator password when the framework it wraps is older than it
 * expects. Xcode 26's wrapper also starts it when the framework is missing. The
 * check reads the same two files the wrapper does, so it can say so without
 * starting anything.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  __setXcodeLocationsForTests,
  xcodeFirstLaunchHint,
  xcodeFirstLaunchPending,
  xcodeInstallInstruction,
} from "../src/utils/xcode-first-launch";

// The suite-wide stub pins the answer; this file tests the real check.
vi.unmock("../src/utils/xcode-first-launch");

// Passed through, so a test can tell whether the check spawned anything.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

const realPlatform = process.platform;
const realDeveloperDir = process.env.DEVELOPER_DIR;
let root: string;
let devDir: string;
let plistPath: string;

/** The wrapper shape of Xcode 27: runs the install when the framework is older, not when it is missing. */
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

/** The wrapper shape of Xcode 26: runs the install on any mismatch. */
function exactRuleWrapper(expected: string, plist: string): string {
  return [
    "#!/bin/bash",
    `EXPECTED_VERSION="${expected}"`,
    `CURRENT_VERSION="$(/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" "${plist}" 2>&1)"`,
    'if [[ "${EXPECTED_VERSION}" != "${CURRENT_VERSION}" ]]; then',
    '    "${DEVELOPER_DIR}/usr/bin/xcodebuild" -runFirstLaunch >&2',
    "fi",
    'exec "/real/simctl" "${@}"',
    "",
  ].join("\n");
}

function writeWrapper(text: string, dir = devDir): void {
  fs.mkdirSync(path.join(dir, "usr", "bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, "usr", "bin", "simctl"), text);
}

function installFramework(version: string): void {
  fs.writeFileSync(
    plistPath,
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n` +
      `\t<key>CFBundleIdentifier</key>\n\t<string>com.apple.CoreSimulator</string>\n` +
      `\t<key>CFBundleVersion</key>\n\t<string>${version}</string>\n</dict>\n</plist>\n`
  );
}

/** Rewrites the framework plist as a binary one, as Xcode 16 installs CoreSimulator's. */
function convertFrameworkToBinary(): void {
  execFileSync("/usr/bin/plutil", ["-convert", "binary1", plistPath]);
  expect(fs.readFileSync(plistPath).toString("latin1", 0, 6)).toBe("bplist");
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "xcode-first-launch-"));
  devDir = path.join(root, "Xcode.app", "Contents", "Developer");
  plistPath = path.join(root, "Info.plist");
  process.env.DEVELOPER_DIR = devDir;
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
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
    writeWrapper(olderRuleWrapper("1174.21", plistPath));
    installFramework("1174.21");
    expect(xcodeFirstLaunchPending()).toBe(false);
  });

  it("is true after an Xcode update leaves the framework older than the wrapper expects", () => {
    writeWrapper(olderRuleWrapper("1175.5", plistPath));
    installFramework("1174.21");
    expect(xcodeFirstLaunchPending()).toBe(true);
  });

  it("is true for a missing framework where the wrapper's != check runs the install", () => {
    writeWrapper(exactRuleWrapper("1051.55", plistPath));
    expect(xcodeFirstLaunchPending()).toBe(true);
  });

  it("is false for a missing framework where the wrapper's older-than check does not run it", () => {
    // PlistBuddy prints an error instead of a version, which sorts after any version.
    writeWrapper(olderRuleWrapper("1174.21", plistPath));
    expect(xcodeFirstLaunchPending()).toBe(false);
  });

  it("compares numerically and ignores trailing .0 parts, as the wrapper does", () => {
    writeWrapper(olderRuleWrapper("1174.21.0", plistPath));
    installFramework("1174.21");
    expect(xcodeFirstLaunchPending()).toBe(false);
    writeWrapper(olderRuleWrapper("1174.21", plistPath));
    installFramework("1174.21.0");
    expect(xcodeFirstLaunchPending()).toBe(false);
    installFramework("1174.3");
    expect(xcodeFirstLaunchPending()).toBe(true);
    installFramework("1174.100");
    expect(xcodeFirstLaunchPending()).toBe(false);
  });

  // A part one side lacks counts as 0, so 1051.49 is older than 1051.49.1: the
  // wrapper's sort --version-sort puts it first and starts the install.
  it("compares versions with a different number of parts", () => {
    writeWrapper(olderRuleWrapper("1051.49.1", plistPath));
    installFramework("1051.49");
    expect(xcodeFirstLaunchPending()).toBe(true);
    writeWrapper(olderRuleWrapper("1051.49", plistPath));
    installFramework("1051.49.1");
    expect(xcodeFirstLaunchPending()).toBe(false);
  });

  it("is true for an exact-match wrapper whose framework is older", () => {
    writeWrapper(exactRuleWrapper("1051.55", plistPath));
    installFramework("1051.49");
    expect(xcodeFirstLaunchPending()).toBe(true);
  });

  it("is false for an exact-match wrapper whose framework is newer, so an older Xcode stays usable", () => {
    writeWrapper(exactRuleWrapper("1051.55", plistPath));
    installFramework("1174.21");
    expect(xcodeFirstLaunchPending()).toBe(false);
  });

  // Point updates usually keep the length, so neither file changes size.
  it("sees a version change of the same length on the next call, in either file", () => {
    writeWrapper(olderRuleWrapper("1010.17", plistPath));
    installFramework("1010.15");
    expect(xcodeFirstLaunchPending()).toBe(true);
    installFramework("1010.17");
    expect(xcodeFirstLaunchPending()).toBe(false);
    writeWrapper(olderRuleWrapper("1010.19", plistPath));
    expect(xcodeFirstLaunchPending()).toBe(true);
  });

  it("reads an XML plist without spawning anything, with a version or without one", () => {
    writeWrapper(exactRuleWrapper("1175.5", plistPath));
    installFramework("1174.21");
    vi.mocked(execFileSync).mockClear();
    expect(xcodeFirstLaunchPending()).toBe(true);
    fs.writeFileSync(plistPath, "<plist><dict></dict></plist>");
    expect(xcodeFirstLaunchPending()).toBe(false);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  // The wrapper's PlistBuddy reads a binary plist too, and an Xcode update leaves
  // Xcode 16's binary CoreSimulator plist in place until the install.
  describe.skipIf(realPlatform !== "darwin")("with a binary framework plist", () => {
    it.each([
      ["older", "1010.15", true],
      ["at the expected version", "1174.21", false],
      ["newer", "1175.5", false],
    ] as const)(
      "answers as for XML when the framework is %s, under either check",
      (_, version, pending) => {
        for (const wrapper of [olderRuleWrapper, exactRuleWrapper]) {
          writeWrapper(wrapper("1174.21", plistPath));
          installFramework(version);
          expect(xcodeFirstLaunchPending(), `${wrapper.name}, XML`).toBe(pending);
          convertFrameworkToBinary();
          expect(xcodeFirstLaunchPending(), `${wrapper.name}, binary`).toBe(pending);
        }
      }
    );

    it("cannot tell from a corrupt one", () => {
      // With the != check a corrupt plist read as missing would read as pending.
      writeWrapper(exactRuleWrapper("1175.5", plistPath));
      fs.writeFileSync(plistPath, "bplist00 but not a plist");
      expect(xcodeFirstLaunchPending()).toBe(false);
    });
  });

  it("accepts DEVELOPER_DIR naming the app bundle rather than its Developer directory", () => {
    writeWrapper(olderRuleWrapper("1175.5", plistPath));
    installFramework("1174.21");
    process.env.DEVELOPER_DIR = path.join(root, "Xcode.app");
    expect(xcodeFirstLaunchPending()).toBe(true);
  });

  it("accepts DEVELOPER_DIR naming any directory that holds Contents/Developer, as xcrun does", () => {
    writeWrapper(olderRuleWrapper("1175.5", plistPath));
    installFramework("1174.21");
    const link = path.join(root, "Xcode-current");
    fs.symlinkSync(path.join(root, "Xcode.app"), link);
    for (const dir of [link, `${link}/`, `${path.join(root, "Xcode.app")}//`]) {
      process.env.DEVELOPER_DIR = dir;
      expect(xcodeFirstLaunchPending(), dir).toBe(true);
    }
  });

  it("accepts DEVELOPER_DIR naming the folder that holds Xcode.app, as xcrun does", () => {
    writeWrapper(olderRuleWrapper("1175.5", plistPath));
    installFramework("1174.21");
    process.env.DEVELOPER_DIR = root;
    expect(xcodeFirstLaunchPending()).toBe(true);
  });

  it("prefers Contents/Developer, then Xcode.app inside it, then DEVELOPER_DIR itself", () => {
    const holder = path.join(root, "Holder");
    const own = path.join(holder, "Contents", "Developer");
    const inside = path.join(holder, "Xcode.app", "Contents", "Developer");
    const settled = olderRuleWrapper("1174.21", plistPath);
    const unsettled = olderRuleWrapper("1175.5", plistPath);
    installFramework("1174.21");
    process.env.DEVELOPER_DIR = holder;

    writeWrapper(unsettled, own);
    writeWrapper(settled, inside);
    writeWrapper(settled, holder);
    expect(xcodeFirstLaunchPending()).toBe(true);

    fs.rmSync(path.join(holder, "Contents"), { recursive: true });
    writeWrapper(unsettled, inside);
    expect(xcodeFirstLaunchPending()).toBe(true);
  });

  it("passes over a Contents/Developer that is a file, as xcrun does", () => {
    const holder = path.join(root, "Holder");
    writeWrapper(olderRuleWrapper("1175.5", plistPath), holder);
    fs.mkdirSync(path.join(holder, "Contents"));
    fs.writeFileSync(path.join(holder, "Contents", "Developer"), "");
    installFramework("1174.21");
    process.env.DEVELOPER_DIR = holder;
    expect(xcodeFirstLaunchPending()).toBe(true);
  });

  it("does not trim DEVELOPER_DIR, as xcrun does not", () => {
    writeWrapper(olderRuleWrapper("1175.5", plistPath));
    installFramework("1174.21");
    process.env.DEVELOPER_DIR = ` ${devDir}`;
    expect(xcodeFirstLaunchPending()).toBe(false);
  });

  describe("reads the Xcode that xcrun uses", () => {
    const otherDevDir = (): string => path.join(root, "Other.app", "Contents", "Developer");

    beforeEach(() => {
      delete process.env.DEVELOPER_DIR;
      writeWrapper(olderRuleWrapper("1175.5", plistPath));
      writeWrapper(olderRuleWrapper("1174.21", plistPath), otherDevDir());
      installFramework("1174.21");
    });

    it("the one xcode-select -s chose, named by its app bundle", () => {
      const link = path.join(root, "xcode_select_link");
      fs.symlinkSync(path.join(root, "Xcode.app"), link);
      __setXcodeLocationsForTests({ selectLink: link, defaultDeveloperDir: otherDevDir() });
      expect(xcodeFirstLaunchPending()).toBe(true);
    });

    it("the one xcode-select -s chose, named by its Developer directory", () => {
      const link = path.join(root, "xcode_select_link");
      fs.symlinkSync(devDir, link);
      __setXcodeLocationsForTests({ selectLink: link, defaultDeveloperDir: otherDevDir() });
      expect(xcodeFirstLaunchPending()).toBe(true);
    });

    it("the default Xcode when nothing was chosen", () => {
      __setXcodeLocationsForTests({
        selectLink: path.join(root, "no-link"),
        defaultDeveloperDir: devDir,
      });
      expect(xcodeFirstLaunchPending()).toBe(true);
    });

    it("none when there is no Xcode at all", () => {
      __setXcodeLocationsForTests({
        selectLink: path.join(root, "no-link"),
        defaultDeveloperDir: path.join(root, "no-xcode"),
      });
      expect(xcodeFirstLaunchPending()).toBe(false);
    });

    it("DEVELOPER_DIR before the one xcode-select -s chose", () => {
      const link = path.join(root, "xcode_select_link");
      fs.symlinkSync(devDir, link);
      __setXcodeLocationsForTests({ selectLink: link, defaultDeveloperDir: devDir });
      process.env.DEVELOPER_DIR = otherDevDir();
      expect(xcodeFirstLaunchPending()).toBe(false);
    });

    // An empty value would otherwise resolve to the server's working directory,
    // while xcrun treats it as unset and runs the wrapper that starts the install.
    it("the one xcode-select -s chose when DEVELOPER_DIR is empty", () => {
      const link = path.join(root, "xcode_select_link");
      fs.symlinkSync(devDir, link);
      __setXcodeLocationsForTests({ selectLink: link, defaultDeveloperDir: otherDevDir() });
      process.env.DEVELOPER_DIR = "";
      expect(xcodeFirstLaunchPending()).toBe(true);
    });
  });

  describe("reads as not pending when it cannot tell", () => {
    it("with no wrapper at the developer directory", () => {
      installFramework("1");
      expect(xcodeFirstLaunchPending()).toBe(false);
    });

    it("with a script that has no version check", () => {
      writeWrapper('#!/bin/bash\nexec "/real/simctl" "$@"\n');
      expect(xcodeFirstLaunchPending()).toBe(false);
    });

    it("with a framework plist it cannot read a version from", () => {
      writeWrapper(olderRuleWrapper("1175.5", plistPath));
      fs.writeFileSync(plistPath, "<plist><dict></dict></plist>");
      expect(xcodeFirstLaunchPending()).toBe(false);
      // Only the != check tells this apart from a missing framework.
      writeWrapper(exactRuleWrapper("1175.5", plistPath));
      expect(xcodeFirstLaunchPending()).toBe(false);
    });

    it("with a version check that only tells the user to run the install", () => {
      writeWrapper(
        olderRuleWrapper("1175.5", plistPath).replace(
          '"${DEVELOPER_DIR}/usr/bin/xcodebuild" -runFirstLaunch >&2',
          'echo "CoreSimulator is out of date. Run sudo xcodebuild -runFirstLaunch" >&2'
        )
      );
      installFramework("1174.21");
      expect(xcodeFirstLaunchPending()).toBe(false);
    });

    // The whole call, so only its place at the start of a line tells them apart.
    it("with a wrapper that only mentions the install call in a message", () => {
      writeWrapper(
        olderRuleWrapper("1175.5", plistPath).replace(
          '"${DEVELOPER_DIR}/usr/bin/xcodebuild" -runFirstLaunch >&2',
          'echo Run "${DEVELOPER_DIR}/usr/bin/xcodebuild" -runFirstLaunch >&2'
        )
      );
      installFramework("1174.21");
      expect(xcodeFirstLaunchPending()).toBe(false);
    });

    it("with a version check of a shape it does not know", () => {
      writeWrapper(
        olderRuleWrapper("1175.5", plistPath).replace(
          'version_is_older "${CURRENT_VERSION}" "${EXPECTED_VERSION}"',
          'is_behind "${CURRENT_VERSION}"'
        )
      );
      installFramework("1174.21");
      expect(xcodeFirstLaunchPending()).toBe(false);
    });

    it("with a plist path built from a shell variable", () => {
      // With the != check a path read literally would look missing, which reads as pending.
      const wrapper = exactRuleWrapper("1051.55", plistPath)
        .replace(`"${plistPath}"`, '"${INFO_PLIST}"')
        .replace("#!/bin/bash\n", `#!/bin/bash\nINFO_PLIST="${plistPath}"\n`);
      writeWrapper(wrapper);
      installFramework("1051.55");
      expect(xcodeFirstLaunchPending()).toBe(false);
    });

    it("with an absolute plist path that uses a shell variable", () => {
      // With the != check a path read literally would look missing, which reads as pending.
      plistPath = path.join(root, "Frameworks", "Info.plist");
      fs.mkdirSync(path.dirname(plistPath));
      installFramework("1051.55");
      const wrapper = exactRuleWrapper("1051.55", path.join(root, "${FW}", "Info.plist"));
      writeWrapper(wrapper.replace("#!/bin/bash\n", '#!/bin/bash\nFW="Frameworks"\n'));
      expect(xcodeFirstLaunchPending()).toBe(false);
    });

    it("with a relative plist path", () => {
      // With the != check a path read literally would look missing, which reads as pending.
      writeWrapper(exactRuleWrapper("1051.55", "relative/Info.plist"));
      expect(xcodeFirstLaunchPending()).toBe(false);
    });

    it("with an expected version built from a shell variable", () => {
      // With the != check a value read literally plus a missing framework reads as pending.
      writeWrapper(exactRuleWrapper("${FRAMEWORK_VERSION}", plistPath));
      expect(xcodeFirstLaunchPending()).toBe(false);
    });

    it.each(['# EXPECTED_VERSION="1175.5"', 'EXPECTED_VERSION="1175.5" # was 1174.21'])(
      "with an expected version that is not a whole line: %s",
      (line) => {
        writeWrapper(
          olderRuleWrapper("1175.5", plistPath).replace('EXPECTED_VERSION="1175.5"', line)
        );
        installFramework("1174.21");
        expect(xcodeFirstLaunchPending()).toBe(false);
      }
    );

    it("with a framework plist that exists but cannot be read", () => {
      writeWrapper(olderRuleWrapper("1175.5", plistPath));
      fs.mkdirSync(plistPath);
      expect(xcodeFirstLaunchPending()).toBe(false);
      // Only the != check tells this apart from a missing framework.
      writeWrapper(exactRuleWrapper("1175.5", plistPath));
      expect(xcodeFirstLaunchPending()).toBe(false);
    });

    it("with a version that is not purely numeric", () => {
      writeWrapper(olderRuleWrapper("1175.5", plistPath));
      installFramework("1174.21b");
      expect(xcodeFirstLaunchPending()).toBe(false);
    });

    // Number() reads each of these as a number that would make the framework older.
    it.each([
      ["1e3", "2000"],
      ["0x10", "2000"],
      [" 1", "2000"],
      ["+1", "2000"],
      ["-1", "2000"],
      [".1", "2000"],
      ["1.", "2000"],
      ["1..2", "2000"],
      ["2", "1e3"],
      ["2", "0x10"],
      ["2", " 3"],
      ["2", "+3"],
      ["2", "3."],
      ["2", "3..1"],
    ])("with installed version %j and expected version %j", (installed, expected) => {
      writeWrapper(olderRuleWrapper(expected, plistPath));
      installFramework(installed);
      expect(xcodeFirstLaunchPending()).toBe(false);
    });

    it("off macOS", () => {
      writeWrapper(olderRuleWrapper("1175.5", plistPath));
      installFramework("1174.21");
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      expect(xcodeFirstLaunchPending()).toBe(false);
    });
  });
});

// The wrapper runs its own Xcode's xcodebuild, so the agent must be told which
// Xcode that is: a plain `sudo xcodebuild` runs the one xcode-select points at.
describe("xcodeFirstLaunchHint", () => {
  const xcodebuildIn = (developerDir: string) =>
    path.join(developerDir, "usr", "bin", "xcodebuild");

  it("says which Xcode, why simulators are missing, and what to ask the user", () => {
    expect(xcodeFirstLaunchHint()).toBe(
      `The Xcode at ${path.join(root, "Xcode.app")} has not finished installing its system ` +
        "components since it was installed or updated. Until it has, Xcode's `simctl` waits for " +
        "an administrator password on every call, so `list-devices` does not show local iOS " +
        "simulators. Tools that need `simctl` fail until then. Ask the user to " +
        "open that Xcode once and let it install the components, or " +
        `to run \`sudo ${xcodebuildIn(devDir)} -runFirstLaunch\`, then retry. Do not run that ` +
        "command or `xcrun simctl` yourself."
    );
  });

  it("names a developer directory that is not inside an app bundle", () => {
    const plain = path.join(root, "Developer");
    fs.mkdirSync(plain);
    process.env.DEVELOPER_DIR = plain;
    const hint = xcodeFirstLaunchHint();
    expect(hint).toContain(`The Xcode at ${plain} has not finished`);
    expect(hint).toContain(`\`sudo ${xcodebuildIn(plain)} -runFirstLaunch\``);
  });

  it("names the Xcode inside the folder DEVELOPER_DIR names", () => {
    fs.mkdirSync(devDir, { recursive: true });
    process.env.DEVELOPER_DIR = root;
    const hint = xcodeFirstLaunchHint();
    expect(hint).toContain(`The Xcode at ${path.join(root, "Xcode.app")} has not finished`);
    expect(hint).toContain(`\`sudo ${xcodebuildIn(devDir)} -runFirstLaunch\``);
  });

  it("quotes a path with a space, so the command can be pasted into a shell", () => {
    const app = path.join(root, "Xcode Beta.app");
    fs.mkdirSync(path.join(app, "Contents", "Developer"), { recursive: true });
    process.env.DEVELOPER_DIR = app;
    const hint = xcodeFirstLaunchHint();
    expect(hint).toContain(`The Xcode at ${app} has not finished`);
    expect(hint).toContain(
      `\`sudo '${xcodebuildIn(path.join(app, "Contents", "Developer"))}' -runFirstLaunch\``
    );
  });

  it("escapes a quote in the path, so the quoted command still pastes", () => {
    const app = path.join(root, "Team's Xcode.app");
    const developer = path.join(app, "Contents", "Developer");
    fs.mkdirSync(developer, { recursive: true });
    process.env.DEVELOPER_DIR = app;
    expect(xcodeFirstLaunchHint()).toContain(
      `\`sudo '${xcodebuildIn(developer).replace("'", "'\\''")}' -runFirstLaunch\``
    );
  });

  it("falls back to the bare command when no developer directory resolves", () => {
    delete process.env.DEVELOPER_DIR;
    __setXcodeLocationsForTests({
      selectLink: path.join(root, "no-such-link"),
      defaultDeveloperDir: path.join(root, "no-such-dir"),
    });
    const hint = xcodeFirstLaunchHint();
    expect(hint).toContain("Xcode has not finished");
    expect(hint).toContain("open Xcode once");
    expect(hint).toContain("`sudo xcodebuild -runFirstLaunch`");
  });
});

describe("xcodeInstallInstruction", () => {
  it("names the Xcode app and its own xcodebuild", () => {
    expect(xcodeInstallInstruction()).toBe(
      `open the Xcode at ${path.join(root, "Xcode.app")} once, ` +
        `or run \`sudo ${path.join(devDir, "usr", "bin", "xcodebuild")} -runFirstLaunch\``
    );
  });

  it.each([
    ["with a trailing slash", () => `${devDir}/`],
    ["as a relative path", () => path.relative(process.cwd(), devDir)],
  ])("names the Xcode app for a Developer directory given %s", (_, developerDir) => {
    process.env.DEVELOPER_DIR = developerDir();
    expect(xcodeInstallInstruction()).toBe(
      `open the Xcode at ${path.join(root, "Xcode.app")} once, ` +
        `or run \`sudo ${path.join(devDir, "usr", "bin", "xcodebuild")} -runFirstLaunch\``
    );
  });

  // Each reaches its own candidate of the developer directory, not the fallback.
  it.each([
    ["the app bundle", () => path.relative(process.cwd(), path.join(root, "Xcode.app"))],
    ["the folder that holds Xcode.app", () => path.relative(process.cwd(), root)],
  ])("names the Xcode app for a relative DEVELOPER_DIR naming %s", (_, developerDir) => {
    fs.mkdirSync(devDir, { recursive: true });
    process.env.DEVELOPER_DIR = developerDir();
    expect(xcodeInstallInstruction()).toBe(
      `open the Xcode at ${path.join(root, "Xcode.app")} once, ` +
        `or run \`sudo ${path.join(devDir, "usr", "bin", "xcodebuild")} -runFirstLaunch\``
    );
  });

  it("falls back to the bare command when no developer directory resolves", () => {
    delete process.env.DEVELOPER_DIR;
    __setXcodeLocationsForTests({
      selectLink: path.join(root, "no-such-link"),
      defaultDeveloperDir: path.join(root, "no-such-dir"),
    });
    expect(xcodeInstallInstruction()).toBe(
      "open Xcode once, or run `sudo xcodebuild -runFirstLaunch`"
    );
  });
});

/**
 * `xcode-select -p` honours DEVELOPER_DIR and resolves it the way `xcrun`
 * does. Each case puts a pending wrapper only in the directory it names and a
 * settled one in every other candidate, so the check agrees only when it reads
 * the same directory.
 */
describe.skipIf(realPlatform !== "darwin")("reads the directory xcode-select names", () => {
  const app = (): string => path.join(root, "Xcode.app");
  const inRoot = (name: string): string => path.join(root, name);
  const cases: [string, () => string][] = [
    ["an app bundle", app],
    ["an app bundle with trailing slashes", () => `${app()}//`],
    [
      "a symlink to an app bundle, named without .app",
      () => {
        fs.symlinkSync(app(), inRoot("Xcode-current"));
        return inRoot("Xcode-current");
      },
    ],
    ["a directory with both usr/bin and Contents/Developer", () => inRoot("Both")],
    ["a directory whose Contents/Developer is a file", () => inRoot("FileDev")],
    ["a Developer directory with a trailing slash", () => `${devDir}/`],
    ["a relative path", () => path.relative(process.cwd(), app())],
    ["the folder that holds Xcode.app", () => root],
    ["that folder with a trailing slash", () => `${root}/`],
    ["a folder with usr/bin and Xcode.app", () => inRoot("Holder")],
    ["a folder with Contents/Developer and Xcode.app", () => inRoot("Bundle")],
    ["a folder whose Xcode.app is a symlink", () => inRoot("Linked")],
    ["a folder with an Xcode of another name", () => inRoot("Beta")],
    ["a folder whose Xcode.app has no Contents/Developer", () => inRoot("Hollow")],
  ];

  it.each(cases)("%s", (_name, name) => {
    installFramework("1174.21");
    const settled = olderRuleWrapper("1174.21", plistPath);
    const nested = (dir: string, ...parts: string[]): string =>
      path.join(inRoot(dir), ...parts, "Contents", "Developer");
    for (const dir of [
      devDir,
      app(),
      root,
      inRoot("Both"),
      nested("Both"),
      inRoot("FileDev"),
      inRoot("Holder"),
      nested("Holder", "Xcode.app"),
      inRoot("Bundle"),
      nested("Bundle"),
      nested("Bundle", "Xcode.app"),
      inRoot("Linked"),
      nested("Target.app"),
      inRoot("Beta"),
      nested("Beta", "Xcode-beta.app"),
      inRoot("Hollow"),
    ]) {
      writeWrapper(settled, dir);
    }
    fs.mkdirSync(path.join(inRoot("FileDev"), "Contents"));
    fs.writeFileSync(path.join(inRoot("FileDev"), "Contents", "Developer"), "");
    fs.symlinkSync(inRoot("Target.app"), path.join(inRoot("Linked"), "Xcode.app"));
    fs.mkdirSync(path.join(inRoot("Hollow"), "Xcode.app"));

    const value = name();
    const named = execFileSync("/usr/bin/xcode-select", ["-p"], {
      env: { ...process.env, DEVELOPER_DIR: value },
    })
      .toString()
      .replace(/\n$/, "");
    writeWrapper(olderRuleWrapper("1175.5", plistPath), path.resolve(named));
    process.env.DEVELOPER_DIR = value;
    expect(xcodeFirstLaunchPending()).toBe(true);
  });
});

/**
 * The fixtures above are hand-written. This holds the check to the wrappers
 * Xcode actually ships, on a Mac that has some: each one runs against a test
 * plist with its install call replaced by an echo, and has to agree with the
 * check on an expected, an older and a missing framework.
 */
const realWrappers =
  realPlatform === "darwin" && fs.existsSync("/Applications")
    ? fs
        .readdirSync("/Applications")
        .filter((name) => /^Xcode.*\.app$/.test(name))
        .map((app) => path.join("/Applications", app, "Contents/Developer/usr/bin/simctl"))
        .filter((file) => fs.existsSync(file) && fs.readFileSync(file).includes("-runFirstLaunch"))
    : [];

describe.skipIf(realWrappers.length === 0)("agrees with the wrappers installed on this Mac", () => {
  it.each(realWrappers)("%s", (file) => {
    const text = fs.readFileSync(file, "utf8");
    const expected = /^EXPECTED_VERSION="([^"]+)"/m.exec(text)?.[1];
    const realPlist = /Print :CFBundleVersion" "([^"]+)"/.exec(text)?.[1];
    expect(expected, "EXPECTED_VERSION").toBeDefined();
    expect(realPlist, "plist path").toBeDefined();
    const pointed = text.split(realPlist!).join(plistPath);
    writeWrapper(pointed);

    // The probe derives DEVELOPER_DIR from its own path, so even an install call
    // that escaped the replacement would name an xcodebuild that does not exist.
    const probeDir = path.join(root, "probe", "usr", "bin");
    fs.mkdirSync(probeDir, { recursive: true });
    const probe = path.join(probeDir, "simctl");
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
      expect(xcodeFirstLaunchPending(), state).toBe(wrapperInstalls());
      if (version === null) continue;
      convertFrameworkToBinary();
      expect(xcodeFirstLaunchPending(), `${state}, binary`).toBe(wrapperInstalls());
    }

    // A newer framework does not read as pending even where the wrapper runs the install.
    installFramework("999999");
    expect(xcodeFirstLaunchPending()).toBe(false);
  });
});
