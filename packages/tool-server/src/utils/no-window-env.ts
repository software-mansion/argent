/**
 * The two headless-boot env vars, parsed in one place. `boot-device` reads
 * both; the window-shake animation reads the iOS one, and has to agree with
 * `boot-device` about it or it would script a window that was deliberately
 * never opened.
 *
 * Truthy: "1", "true", "yes" (case-insensitive, trimmed). Anything else,
 * including "false", "no", "0", or empty, is disabled.
 */

const TRUTHY = new Set(["1", "true", "yes"]);

function truthyEnv(name: string): boolean {
  return TRUTHY.has((process.env[name] ?? "").trim().toLowerCase());
}

/**
 * ARGENT_SIMULATOR_NO_WINDOW: force local simulator boots headless without
 * passing `headless: true` on every boot-device call, for CI/containers and
 * Lens hosts that stream the device and never want the window to pop.
 * `simctl boot` is already headless, so this only gates the GUI attach.
 */
export function iosHeadlessFromEnv(): boolean {
  return truthyEnv("ARGENT_SIMULATOR_NO_WINDOW");
}

/**
 * ARGENT_EMULATOR_NO_WINDOW: opt-in `-no-window` for CI/containers/Wayland
 * sessions where the emulator's bundled Qt has no wayland plugin (would
 * SIGABRT). It selects qemu-system-x86_64-headless, which skips Qt; screencap
 * still works.
 */
export function androidHeadlessFromEnv(): boolean {
  return truthyEnv("ARGENT_EMULATOR_NO_WINDOW");
}
