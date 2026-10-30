// A copy of the fake app that runs without the argent library, as when the
// user opens the app or Xcode Run starts it, for the take-over tests. The test
// starts it with `argv[0]` set to the bundle executable, so argent finds it.
//
// It starts `/bin/sleep` in its own process group: a signal to the group would
// stop that program too. It writes `{"child": <pid>}` to the report file given
// as its first argument, and appends the name of each SIGTERM it gets to
// `<report>.signals`. `--ignore-term` keeps it running after SIGTERM.
"use strict";
const { spawn } = require("node:child_process");
const fs = require("node:fs");

const report = process.argv[2];
const ignoreTerm = process.argv.includes("--ignore-term");
const child = spawn("/bin/sleep", ["60"], { stdio: "ignore" });
child.unref();
process.on("SIGTERM", () => {
  fs.appendFileSync(`${report}.signals`, "SIGTERM\n");
  if (!ignoreTerm) process.exit(0);
});
setInterval(() => {}, 1 << 30);
fs.writeFileSync(report, JSON.stringify({ child: child.pid }));
