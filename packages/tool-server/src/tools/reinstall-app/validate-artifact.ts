import { promises as fs } from "node:fs";
import { realpath } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FAILURE_CODES } from "@argent/registry";
import { InvalidToolInputError } from "../../utils/capability";
import { configuredAdditionalDeviceSets, deviceSetForUdid } from "../../utils/ios-device-sets";

/**
 * Checks that run BEFORE `reinstall-app` uninstalls anything.
 *
 * The uninstall is unconditional and irreversible — it takes the app's data
 * with it — so an artifact that was never going to install must be rejected
 * while the existing installation is still on the device. Everything here is
 * a local stat or a 4-byte read; nothing touches the device.
 */

type ArtifactTarget = "ios" | "android" | "vega";

function reject(message: string, stage: string): never {
  throw new InvalidToolInputError(message, {
    error_code: FAILURE_CODES.TOOL_INPUT_INVALID,
    failure_stage: stage,
  });
}

/** adb's own filename rule is case-insensitive: `UPPER.APK` installs fine. */
function hasExtension(file: string, extensions: string[]): boolean {
  const lower = file.toLowerCase();
  return extensions.some((ext) => lower.endsWith(ext));
}

/**
 * A zipaligned APK always starts with a local file header, so four bytes are
 * enough to reject a renamed text file, a truncated download or an empty build
 * output — the cases where `adb install` would otherwise fail after the app is
 * already gone.
 */
async function looksLikeZip(file: string): Promise<boolean> {
  let handle;
  try {
    handle = await fs.open(file, "r");
    const buf = Buffer.alloc(4);
    const { bytesRead } = await handle.read(buf, 0, 4, 0);
    return (
      bytesRead === 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04
    );
  } catch {
    // Unreadable for a reason stat did not catch — let the install report it
    // rather than guessing here.
    return true;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Reject an artifact the target platform cannot install. Returns the absolute
 * path so callers use the same resolution the check ran against.
 */
export async function assertInstallableArtifact(
  appPath: string,
  target: ArtifactTarget
): Promise<string> {
  const abs = path.resolve(appPath);

  const stat = await fs.stat(abs).catch(() => null);
  if (!stat) {
    reject(
      `App path "${abs}" does not exist, so there is nothing to install. The existing installation ` +
        `was left untouched. Check the path — iOS expects the .app bundle directory, Android an ` +
        `.apk file, Vega a .vpkg file.`,
      "reinstall_app_path_missing"
    );
  }

  if (target === "ios") {
    // A simulator .app is a flat bundle: Info.plist sits at the root. A macOS
    // .app nests it under Contents/, so this also rejects a desktop build.
    if (!stat.isDirectory()) {
      reject(
        `App path "${abs}" is a file, but an iOS app bundle is a directory (.app). If this is an ` +
          `.ipa or an archive, unpack it and pass the .app inside. The existing installation was ` +
          `left untouched.`,
        "reinstall_app_path_wrong_kind"
      );
    }
    if (!hasExtension(abs, [".app"])) {
      reject(
        `App path "${abs}" is not a .app bundle. The existing installation was left untouched.`,
        "reinstall_app_path_wrong_extension"
      );
    }
    const plist = await fs.stat(path.join(abs, "Info.plist")).catch(() => null);
    if (!plist) {
      reject(
        `App path "${abs}" has no Info.plist at its root, so it is not an iOS app bundle — a macOS ` +
          `.app keeps it under Contents/, and a partially-copied bundle may be missing it. The ` +
          `existing installation was left untouched.`,
        "reinstall_app_path_malformed"
      );
    }
    return abs;
  }

  if (stat.isDirectory()) {
    reject(
      `App path "${abs}" is a directory, but ${target === "android" ? "Android expects a single .apk file" : "Vega expects a single .vpkg file"}. ` +
        `The existing installation was left untouched.`,
      "reinstall_app_path_wrong_kind"
    );
  }

  if (target === "android") {
    if (!hasExtension(abs, [".apk", ".apex"])) {
      reject(
        `App path "${abs}" is not an .apk or .apex — adb rejects any other filename, which would ` +
          `leave the device with no copy of the app. The existing installation was left untouched.`,
        "reinstall_app_path_wrong_extension"
      );
    }
    if (stat.size === 0 || !(await looksLikeZip(abs))) {
      reject(
        `App path "${abs}" is named .apk but is not a zip archive, so it cannot be installed — an ` +
          `APK always starts with a zip header. Check the build output is complete. The existing ` +
          `installation was left untouched.`,
        "reinstall_app_path_malformed"
      );
    }
    return abs;
  }

  if (!hasExtension(abs, [".vpkg"])) {
    reject(
      `App path "${abs}" is not a .vpkg package. The existing installation was left untouched.`,
      "reinstall_app_path_wrong_extension"
    );
  }
  return abs;
}

async function realpathOrSelf(p: string): Promise<string> {
  return realpath(p).catch(() => p);
}

function isInside(parent: string, child: string): boolean {
  // macOS is case-insensitive by default, and path.relative is pure string
  // math, so normalise before comparing.
  const rel = path.relative(parent.toLowerCase(), child.toLowerCase());
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Refuse to install a simulator's app *from inside that same simulator's
 * container*. The uninstall deletes the container, which deletes the source, so
 * the install then fails on a path that no longer exists and the app is gone —
 * the exact iOS case in issue #625.
 *
 * Checked against the device's own set plus every configured additional set,
 * because `deviceSetForUdid` returns null both for "the default set" and for a
 * UDID it has never seen.
 */
export async function assertNotInsideDeviceContainer(
  absAppPath: string,
  udid: string
): Promise<void> {
  const roots = [
    path.join(os.homedir(), "Library", "Developer", "CoreSimulator", "Devices"),
    ...configuredAdditionalDeviceSets(),
  ];
  const own = await deviceSetForUdid(udid).catch(() => null);
  if (own) roots.push(own);

  const target = await realpathOrSelf(absAppPath);

  for (const root of roots) {
    const deviceDir = path.join(root, udid);
    const resolved = await realpathOrSelf(deviceDir);
    if (isInside(resolved, target) || isInside(deviceDir, target)) {
      reject(
        `App path "${absAppPath}" is inside this simulator's own container. Reinstalling uninstalls ` +
          `first, which deletes that container — and with it the bundle being installed from — so ` +
          `the app would be left uninstalled. Point appPath at your build output (the .app in ` +
          `DerivedData or your project) instead. The existing installation was left untouched.`,
        "reinstall_app_path_in_device_container"
      );
    }
  }
}
