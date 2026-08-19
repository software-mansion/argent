// The launcher spawns a real tool-server child that inherits this process's
// environment, and buildToolsServerEnv overrides only the few keys it is given
// — so every other ARGENT_* variable the developer keeps exported reaches the
// child. ARGENT_HOST is the one that bites: the fixture binds the host it names
// while the launcher records and health-checks 127.0.0.1, so reuse misses, a
// second server is spawned, and the first is left listening after the run.
//
// Clearing the whole prefix rather than that one name is what covers overrides
// added to src later without a second edit here. ARGENT_HOST is the only one
// that currently changes an outcome: the three other in-process reads
// (ARGENT_TOOLS_URL, ARGENT_AUTH_TOKEN, ARGENT_ARTIFACTS_DIR) are set by the
// tests that exercise them, so exporting all three and dropping this file still
// leaves the suite at 191 passed.
//
// This runs before the test module graph is imported, so module-level env reads
// observe the cleared state too.
for (const name of Object.keys(process.env)) {
  if (name.startsWith("ARGENT_")) {
    delete process.env[name];
  }
}
