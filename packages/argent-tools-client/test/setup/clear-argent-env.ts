// The launcher spawns a real tool-server child that inherits this process's
// environment, and buildToolsServerEnv overrides only the few keys it is given
// — so every other ARGENT_* variable the developer keeps exported reaches the
// child. Clearing the whole prefix, rather than the handful of names that
// happen to matter today, covers overrides added to src later without a second
// edit here.
//
// This runs before the test module graph is imported, so module-level env reads
// observe the cleared state too.
for (const name of Object.keys(process.env)) {
  // Upper-cased first: Windows env lookups are case-insensitive while the keys
  // enumerate with the casing they were set in, so a `set argent_host=…`
  // survives a literal prefix match and still reads back as ARGENT_HOST.
  if (name.toUpperCase().startsWith("ARGENT_")) {
    delete process.env[name];
  }
}
