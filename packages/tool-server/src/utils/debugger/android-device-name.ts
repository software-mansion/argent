import { ADB_DEVICES_TIMEOUT_MS, adbShell, ENRICH_TIMEOUT_MS, listAndroidSerials } from "../adb";
import { externalNativeId } from "../external-devices";

/**
 * The names a React Native app on this Android device reports to Metro as its
 * `deviceName`: `<model> - <release> - API <sdk>`, or the model alone on a
 * Genymotion device. Undefined when adb cannot read the device, for example
 * when `serial` is not an adb serial.
 */
export async function androidDeviceNames(serial: string): Promise<string[] | undefined> {
  try {
    const out = await adbShell(
      serial,
      [
        'echo "model=$(getprop ro.product.model)"',
        'echo "release=$(getprop ro.build.version.release)"',
        'echo "sdk=$(getprop ro.build.version.sdk)"',
      ].join("; "),
      { timeoutMs: ENRICH_TIMEOUT_MS }
    );
    const fields = new Map<string, string>();
    for (const line of out.split("\n")) {
      const at = line.indexOf("=");
      if (at > 0) fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
    }
    const model = fields.get("model");
    const release = fields.get("release");
    const sdk = fields.get("sdk");
    if (!model || !release || !sdk) return undefined;
    return [`${model} - ${release} - API ${sdk}`, model];
  } catch {
    return undefined;
  }
}

/**
 * Whether adb lists an online device other than `serial`. Emulators built from
 * one system image all report one name, so a name proves the device only when
 * no other device is online. True when adb cannot tell.
 */
export async function otherAndroidDeviceOnline(serial: string): Promise<boolean> {
  // `adb devices` lists a provider's device by its own serial, not by our `ext:` id.
  const own = externalNativeId(serial);
  try {
    const devices = await listAndroidSerials({ devicesTimeoutMs: ADB_DEVICES_TIMEOUT_MS });
    return devices.some((d) => d.state === "device" && d.serial !== own);
  } catch {
    return true;
  }
}
