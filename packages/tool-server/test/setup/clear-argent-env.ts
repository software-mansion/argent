// Unit tests assert argent's shipped defaults, so they must not inherit the
// tool-server configuration the developer running them keeps in their shell.
// Every ARGENT_* variable is a user-facing override that changes asserted
// behavior: `ARGENT_EMULATOR_GPU_MODE` replaces the `-gpu` value boot-device
// resolves per platform, `ARGENT_EMULATOR_NO_WINDOW` / `ARGENT_SIMULATOR_NO_WINDOW`
// add `-no-window` and suppress the Simulator.app attach, and `ARGENT_PORT` /
// `ARGENT_HOST` retarget the bind that the startup-telemetry tests inspect. An
// exported override turns those assertions into a property of the machine
// rather than of the code, and the failure reads as a source regression.
//
// Clearing the whole prefix (rather than a hand-maintained list) also covers
// overrides added to src later without a second edit here. A test that
// exercises an override sets it itself, so nothing depends on the ambient value.
//
// This runs before the test module graph is imported, so module-level env reads
// observe the cleared state too.
for (const name of Object.keys(process.env)) {
  if (name.startsWith("ARGENT_")) {
    delete process.env[name];
  }
}
