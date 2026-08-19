// The launcher spawns a real tool-server child that inherits this process's
// environment, and buildToolsServerEnv overrides only the few keys it is given
// — so every other ARGENT_* variable the developer keeps exported reaches the
// child. ARGENT_HOST is the one that bites: the fixture binds the host it names
// while the launcher records and health-checks 127.0.0.1, so reuse misses, a
// second server is spawned, and the first is left listening after the run.
// ARGENT_TOOLS_URL, ARGENT_AUTH_TOKEN, ARGENT_ARTIFACTS_DIR and
// ARGENT_IDLE_TIMEOUT_MINUTES are read in-process and retarget assertions the
// same way.
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
