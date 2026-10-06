// A global install of this alias would put a second `argent` binary on PATH, which
// clashes with @swmansion/argent (the package `argent init` installs globally) and
// hides it from `argent update`. Global installs go to @swmansion/argent instead.
if (process.env.npm_config_global === "true") {
  console.error(
    [
      "",
      "The `argent` package is only an alias for running argent with npx:",
      "",
      "  npx argent init",
      "",
      "To install argent globally, install @swmansion/argent:",
      "",
      "  npm install -g @swmansion/argent",
      "",
    ].join("\n")
  );
  process.exit(1);
}
