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
// This runs before the test module graph is imported, so module-level env reads
// observe the cleared state too. On a machine with no override exported the
// loop body never runs, so no suite failure can catch this file being weakened;
// `test/clear-argent-env.test.ts` re-imports it against planted sentinels
// instead.
for (const name of Object.keys(process.env)) {
  if (name.startsWith("ARGENT_")) {
    delete process.env[name];
  }
}

export {};
