// `ARGENT_*` variables are user-facing overrides: the tools read them ahead of
// their own defaults, so any assertion about a default measures the developer's
// shell unless the variable is cleared first. The machines most likely to
// export one are exactly the machines whose work these tests cover — the
// documented fix for a host whose GL stack or window server misbehaves is
// `ARGENT_EMULATOR_GPU_MODE` / `ARGENT_EMULATOR_NO_WINDOW`, and setting either
// turned this package permanently red.
//
// Cleared suite-wide for the same reason the status-bar stub is: no unit test
// wants the real environment, and per-file guards had already been written
// three separate times without covering it. A test that exercises an override
// sets the variable itself, which still works — this only removes what leaked
// in from outside.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("ARGENT_")) delete process.env[key];
}
