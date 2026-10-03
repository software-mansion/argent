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

type ArtifactTarget = "ios" | "ios-device" | "android" | "vega";

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
      `App path "${abs}" does not exist; nothing was uninstalled.`,
      "reinstall_app_path_missing"
    );
  }

  // devicectl installs either a signed .app bundle or an .ipa archive.
  if (target === "ios-device" && stat.isFile()) {
    if (!hasExtension(abs, [".ipa"])) {
      reject(
        `App path "${abs}" is a file but not an .ipa (a physical iPhone takes a .app directory or an .ipa); nothing was uninstalled.`,
        "reinstall_app_path_wrong_extension"
      );
    }
    if (stat.size === 0 || !(await looksLikeZip(abs))) {
      reject(
        `App path "${abs}" is not a valid .ipa (not a zip archive); nothing was uninstalled.`,
        "reinstall_app_path_malformed"
      );
    }
    return abs;
  }

  if (target === "ios" || target === "ios-device") {
    // A simulator .app is a flat bundle: Info.plist sits at the root. A macOS
    // .app nests it under Contents/, so this also rejects a desktop build.
    if (!stat.isDirectory()) {
      reject(
        `App path "${abs}" is a file, but an iOS simulator needs a .app bundle directory; nothing was uninstalled.`,
        "reinstall_app_path_wrong_kind"
      );
    }
    if (!hasExtension(abs, [".app"])) {
      reject(
        `App path "${abs}" is not a .app bundle; nothing was uninstalled.`,
        "reinstall_app_path_wrong_extension"
      );
    }
    const plist = await fs.stat(path.join(abs, "Info.plist")).catch(() => null);
    if (!plist) {
      reject(
        `App path "${abs}" has no Info.plist at its root, so it is not an iOS app bundle; nothing was uninstalled.`,
        "reinstall_app_path_malformed"
      );
    }
    return abs;
  }

  if (stat.isDirectory()) {
    reject(
      `App path "${abs}" is a directory, but ${target === "android" ? "Android expects an .apk file" : "Vega expects a .vpkg file"}; nothing was uninstalled.`,
      "reinstall_app_path_wrong_kind"
    );
  }

  if (target === "android") {
    if (!hasExtension(abs, [".apk", ".apex"])) {
      reject(
        `App path "${abs}" is not an .apk or .apex; nothing was uninstalled.`,
        "reinstall_app_path_wrong_extension"
      );
    }
    if (stat.size === 0 || !(await looksLikeZip(abs))) {
      reject(
        `App path "${abs}" is not a valid .apk (not a zip archive); nothing was uninstalled.`,
        "reinstall_app_path_malformed"
      );
    }
    return abs;
  }

  if (!hasExtension(abs, [".vpkg"])) {
    reject(
      `App path "${abs}" is not a .vpkg package; nothing was uninstalled.`,
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
 *
 * `nativeId` is the directory name CoreSimulator uses. It differs from `udid`
 * for a device offered by an external provider, whose argent id is namespaced.
 */
export async function assertNotInsideDeviceContainer(
  absAppPath: string,
  udid: string,
  nativeId: string = udid
): Promise<void> {
  const roots = [
    path.join(os.homedir(), "Library", "Developer", "CoreSimulator", "Devices"),
    ...configuredAdditionalDeviceSets(),
  ];
  const own = await deviceSetForUdid(udid).catch(() => null);
  if (own) roots.push(own);

  const target = await realpathOrSelf(absAppPath);

  for (const root of roots) {
    const deviceDir = path.join(root, nativeId);
    const resolved = await realpathOrSelf(deviceDir);
    if (isInside(resolved, target) || isInside(deviceDir, target)) {
      reject(
        `App path "${absAppPath}" is inside this simulator's own container, which reinstalling deletes; point appPath at your build output (nothing was uninstalled).`,
        "reinstall_app_path_in_device_container"
      );
    }
  }
}
