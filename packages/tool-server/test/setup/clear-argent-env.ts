// Unit tests assert argent's shipped defaults, so they must not inherit the
// tool-server configuration the developer running them keeps in their shell.
// An exported ARGENT_* override turns those assertions into a property of the
// machine rather than of the code, and the failure reads as a source
// regression. `ARGENT_AUTH_TOKEN` reaches furthest: it puts every HTTP route
// behind a bearer check, so most of the HTTP suite fails on status code alone.
// `ARGENT_EMULATOR_GPU_MODE` replaces the `-gpu` value boot-device resolves per
// platform, `ARGENT_EMULATOR_NO_WINDOW` / `ARGENT_SIMULATOR_NO_WINDOW` add
// `-no-window` and suppress the Simulator.app attach, and `ARGENT_PORT` /
// `ARGENT_HOST` retarget the bind `bind-failure-telemetry.test.ts` inspects.
//
// Clearing the whole prefix (rather than a hand-maintained list) also covers
// overrides added to src later without a second edit here. A test that
// exercises an override sets it itself, so nothing depends on the ambient value.
//
// Non-prefixed overrides need an explicit list too: ADB_SERVER_SOCKET beats the
// fixture port in adb-server.test.ts, and SDK/AVD/Xcode paths can select the
// developer's installation instead of a fixture. Leave the rest of the host
// environment alone, including HOME, USERPROFILE, PATH, CI and
// ELECTRON_RUN_AS_NODE (which controls how an Electron-hosted child runs).
// Tests that change those variables must restore them themselves.
//
// This runs before the test module graph is imported, so module-level env reads
// observe the cleared state too. On a machine with no override exported the
// loop body never runs, so no suite failure can catch this file being weakened;
// `test/clear-argent-env.test.ts` re-imports it against planted sentinels
// instead.
export const CLEARED_ENV_VARS = [
  "ADB_SERVER_SOCKET",
  "ANDROID_ADB_SERVER_ADDRESS",
  "ANDROID_ADB_SERVER_PORT",
  "ANDROID_HOME",
  "ANDROID_SDK_ROOT",
  "LOCALAPPDATA",
  "ANDROID_USER_HOME",
  "ANDROID_AVD_HOME",
  "XDG_CONFIG_HOME",
  "ANDROID_SDK_HOME",
  "DEVELOPER_DIR",
  "WRAP_STDIO_DISABLED",
];

for (const name of CLEARED_ENV_VARS) {
  delete process.env[name];
}

for (const name of Object.keys(process.env)) {
  // Upper-cased first: Windows env lookups are case-insensitive while the keys
  // enumerate with the casing they were set in, so a `set argent_host=…`
  // survives a literal prefix match and still reads back as ARGENT_HOST.
  if (name.toUpperCase().startsWith("ARGENT_")) {
    delete process.env[name];
  }
}
