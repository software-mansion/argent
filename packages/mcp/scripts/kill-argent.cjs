#!/usr/bin/env node
// @ts-check
"use strict";

const { execFileSync } = require("child_process");

/**
 * Kill all node processes whose command line contains any of the given path segments.
 * Silently ignores the case where no matching processes exist (pkill exits 1).
 *
 * @param {string | string[]} paths - One or more path substrings to match against running processes.
 * @returns {string[]} The paths for which at least one process was killed.
 */
function killArgentProcesses(paths) {
  const list = Array.isArray(paths) ? paths : [paths];
  const killed = [];

  if (process.platform === "win32") {
    // Windows: use WMIC to find node PIDs whose CommandLine contains the path
    for (const p of list) {
      try {
        const out = execFileSync(
          "wmic",
          ["process", "where", `Name='node.exe' and CommandLine like '%${p.replace(/'/g, "''")}%'`, "get", "ProcessId", "/format:list"],
          { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
        );
        const pids = out.match(/ProcessId=(\d+)/g)?.map((m) => parseInt(m.split("=")[1])) ?? [];
        for (const pid of pids) {
          try {
            execFileSync("taskkill", ["/F", "/PID", String(pid)], { stdio: "pipe" });
          } catch {
            // Process may have already exited
          }
        }
        if (pids.length > 0) killed.push(p);
      } catch {
        // WMIC not available or query failed
      }
    }
  } else {
    // macOS / Linux
    for (const p of list) {
      try {
        execFileSync("pkill", ["-f", p], { stdio: "pipe" });
        killed.push(p);
      } catch {
        // Exit code 1 means no matching processes — not an error
      }
    }
  }

  return killed;
}

module.exports = { killArgentProcesses };
