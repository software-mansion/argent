/**
 * Shared parsing for the two headless-boot env vars, so `boot-device` (which
 * skips the GUI attach / passes `-no-window`) and the window-shake animation
 * (which must never script a window that was deliberately never opened) read
 * them identically.
 *
 * Accepted truthy values: "1", "true", "yes" (case-insensitive, trimmed).
 * Anything else - including "false", "no", "0", or empty - is treated as
 * disabled.
 */

const TRUTHY = new Set(["1", "true", "yes"]);

function truthyEnv(name: string): boolean {
  return TRUTHY.has((process.env[name] ?? "").trim().toLowerCase());
}

/**
 * ARGENT_SIMULATOR_NO_WINDOW: force local simulator boots headless (skip the
 * `open -a Simulator.app` GUI attach in bootIos) without the caller having to
 * pass `headless: true` on every boot-device call. Meant for CI/containers and
 * Argent Lens hosts that stream the device via simulator-server and never want
 * the Simulator.app window to pop. `simctl boot` itself is already headless,
 * so this only gates the GUI attach.
 */
export function iosHeadlessFromEnv(): boolean {
  return truthyEnv("ARGENT_SIMULATOR_NO_WINDOW");
}

/**
 * ARGENT_EMULATOR_NO_WINDOW: opt-in `-no-window` for CI/containers/Wayland
 * sessions where the emulator's bundled Qt has no wayland plugin (would
 * SIGABRT). `-no-window` selects qemu-system-x86_64-headless which skips Qt
 * entirely; screencap still works.
 */
export function androidHeadlessFromEnv(): boolean {
  return truthyEnv("ARGENT_EMULATOR_NO_WINDOW");
}
