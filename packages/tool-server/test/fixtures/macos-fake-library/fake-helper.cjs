// A stand-in for `argent-macos-helper launch` in the macos-foundation tests.
// It runs the fake app (fake-app.cjs) under Node with `argv[0]` set to the
// bundle executable, so `ps -o comm=` names the app as it does for a real one,
// hands it descriptor 3, prints {"pid":N} and exits. It takes the bootstrap as
// `--insert-library` and refuses a DYLD_INSERT_LIBRARIES in its own environment.
"use strict";
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const argv = process.argv.slice(2);
if (argv[0] !== "launch") {
  process.stderr.write(`fake helper: unknown command ${argv[0]}\n`);
  process.exit(2);
}
const opts = {};
let i = 1;
for (; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--") {
    i++;
    break;
  }
  opts[arg.replace(/^--/, "")] = argv[++i];
}
const appArgs = argv.slice(i);
if (process.env.DYLD_INSERT_LIBRARIES !== undefined) {
  process.stderr.write("fake helper: DYLD_INSERT_LIBRARIES reached the helper\n");
  process.exit(2);
}
if (!opts["insert-library"]) {
  process.stderr.write("fake helper: launch needs --insert-library <path>\n");
  process.exit(2);
}
if (appArgs.includes("--helper-fails")) {
  process.stderr.write("fake helper: refused on purpose\n");
  process.exit(1);
}

const out = fs.openSync(opts.stdout, "a");
const err = fs.openSync(opts.stderr, "a");
const child = spawn(process.execPath, [path.join(__dirname, "fake-app.cjs"), ...appArgs], {
  // `--as-launcher`: run under another name, as an app whose executable is a
  // shell script runs as the shell.
  argv0: appArgs.includes("--as-launcher") ? `${opts.exe}.sh` : opts.exe,
  detached: true,
  stdio: ["ignore", out, err, Number(opts.fd)],
  env: process.env,
});
child.unref();
process.stdout.write(JSON.stringify({ pid: child.pid }) + "\n");
