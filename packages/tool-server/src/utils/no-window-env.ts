/**
 * The two headless-boot env vars, parsed in one place: `boot-device` reads
 * both, and the window-shake animation reads the iOS one, which has to agree
 * with `boot-device` or it would script a window that was never opened.
 */

const TRUTHY = new Set(["1", "true", "yes"]);

function truthyEnv(name: string): boolean {
  return TRUTHY.has((process.env[name] ?? "").trim().toLowerCase());
}

/**
 * ARGENT_SIMULATOR_NO_WINDOW: host-wide `headless: true` for local simulator
 * boots, for CI/containers and Lens hosts that only stream the device.
 * `simctl boot` is already headless, so this only gates the GUI attach.
 */
export function iosHeadlessFromEnv(): boolean {
  return truthyEnv("ARGENT_SIMULATOR_NO_WINDOW");
}

/**
 * ARGENT_EMULATOR_NO_WINDOW: opt-in `-no-window` for CI/containers/Wayland
 * sessions where the emulator's bundled Qt has no wayland plugin (would
 * SIGABRT). Selects qemu-system-x86_64-headless; screencap still works.
 */
export function androidHeadlessFromEnv(): boolean {
  return truthyEnv("ARGENT_EMULATOR_NO_WINDOW");
}
