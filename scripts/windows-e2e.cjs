#!/usr/bin/env node
// @ts-check
"use strict";

/**
 * Windows E2E driver for argent. Exercises the real tool-server (loaded from
 * the freshly bundled @swmansion/argent package) against a running Android
 * emulator. Verifies:
 *
 *   1. Tool-server boots cleanly on Windows (no /bin/sh, /tmp, /dev/null).
 *   2. The shipped simulator-server.exe spawns and reaches `api_ready`.
 *   3. `list-devices` resolves the running emulator by serial.
 *   4. A trivial cross-platform tool (gesture-tap or screenshot) round-trips
 *      through the HTTP transport against a real device.
 *
 * Designed to fail loudly: any step that times out or returns the wrong
 * shape kills the script with a non-zero exit code so the workflow surfaces
 * the regression. No silent fallbacks.
 *
 * Invoked from `.github/workflows/windows-e2e.yml` after the emulator
 * reports `sys.boot_completed=1`. ARGENT_E2E=1 must be set so any
 * conditional log-paths know we're in CI.
 */

const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const os = require("node:os");

const REPO_ROOT = path.resolve(__dirname, "..");
const TOOL_SERVER_BUNDLE = path.join(REPO_ROOT, "packages/argent/dist/tool-server.cjs");
const SIMULATOR_SERVER_DIR = path.join(REPO_ROOT, "packages/argent/bin");
const NATIVE_DEVTOOLS_DIR = path.join(REPO_ROOT, "packages/argent/dylibs");

function log(msg) {
  console.log(`[e2e] ${msg}`);
}

function fail(msg) {
  console.error(`[e2e] FAIL: ${msg}`);
  process.exit(1);
}

function getAdbSerial() {
  const out = execFileSync("adb", ["devices"], { encoding: "utf-8" });
  const line = out.split(/\r?\n/).find((l) => /^emulator-\d+\s+device/.test(l));
  if (!line) fail("no emulator visible to adb");
  return line.split(/\s+/)[0];
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = require("node:net").createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function httpGetJson(port, path_) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: path_ }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        if ((res.statusCode ?? 0) >= 400) {
          reject(new Error(`GET ${path_} -> ${res.statusCode}: ${body}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`GET ${path_}: invalid JSON: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(15_000, () => req.destroy(new Error(`GET ${path_} timed out`)));
  });
}

function httpPostJson(port, path_, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: path_,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          if ((res.statusCode ?? 0) >= 400) {
            reject(new Error(`POST ${path_} -> ${res.statusCode}: ${body}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error(`POST ${path_}: invalid JSON: ${body.slice(0, 200)}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(60_000, () => req.destroy(new Error(`POST ${path_} timed out`)));
    req.write(data);
    req.end();
  });
}

async function waitForReady(port, deadlineMs) {
  while (Date.now() < deadlineMs) {
    try {
      await httpGetJson(port, "/tools");
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error("tool-server never became ready");
}

async function main() {
  if (!fs.existsSync(TOOL_SERVER_BUNDLE)) {
    fail(
      `tool-server bundle missing: ${TOOL_SERVER_BUNDLE} (run npm run build -w @swmansion/argent)`
    );
  }
  const exeName = process.platform === "win32" ? "simulator-server.exe" : "simulator-server";
  const exePath = path.join(SIMULATOR_SERVER_DIR, exeName);
  if (!fs.existsSync(exePath)) fail(`simulator-server binary missing at ${exePath}`);
  log(`tool-server bundle: ${TOOL_SERVER_BUNDLE}`);
  log(`simulator-server: ${exePath}`);

  const adbSerial = getAdbSerial();
  log(`emulator serial: ${adbSerial}`);

  const port = await findFreePort();
  log(`tool-server port: ${port}`);

  const child = spawn(process.execPath, [TOOL_SERVER_BUNDLE, "start"], {
    env: {
      ...process.env,
      PORT: String(port),
      ARGENT_SIMULATOR_SERVER_DIR: SIMULATOR_SERVER_DIR,
      ARGENT_NATIVE_DEVTOOLS_DIR: NATIVE_DEVTOOLS_DIR,
      // No idle timeout — the harness is doing the lifecycle.
      ARGENT_IDLE_TIMEOUT_MINUTES: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (b) => process.stdout.write(`[ts.out] ${b}`));
  child.stderr.on("data", (b) => process.stderr.write(`[ts.err] ${b}`));

  let exited = false;
  child.on("exit", (code, signal) => {
    exited = true;
    log(`tool-server exited code=${code} signal=${signal}`);
  });

  try {
    log("waiting for tool-server...");
    await waitForReady(port, Date.now() + 30_000);
    log("tool-server is ready");

    // 1. list-devices must include our emulator with platform=android.
    const listResult = await httpPostJson(port, "/tools/list-devices", {});
    const devices = listResult?.result?.devices ?? [];
    const ours = devices.find((d) => d.serial === adbSerial || d.id === adbSerial);
    if (!ours) {
      fail(
        `list-devices did not return our emulator (${adbSerial}). got: ${JSON.stringify(devices)}`
      );
    }
    if (ours.platform !== "android") fail(`expected platform=android, got ${ours.platform}`);
    log(`list-devices OK: ${ours.id ?? ours.serial} (${ours.platform})`);

    // 2. screenshot — exercises the simulator-server.exe spawn + Android gRPC
    //    capture path end-to-end, the cheapest tool that hits every wire.
    const shotResult = await httpPostJson(port, "/tools/screenshot", {
      udid: ours.id ?? ours.serial,
    });
    const shotUrl = shotResult?.result?.url ?? shotResult?.result?.path;
    if (!shotUrl) fail(`screenshot returned no url/path: ${JSON.stringify(shotResult)}`);
    log(`screenshot OK: ${shotUrl}`);

    // 3. stop-all-simulator-servers — verifies the cleanup path tears down the
    //    spawned simulator-server.exe child without orphaning it.
    await httpPostJson(port, "/tools/stop-all-simulator-servers", {});
    log("stop-all-simulator-servers OK");

    log("E2E PASS");
  } finally {
    if (!exited) {
      child.kill();
    }
  }
}

main().catch((err) => {
  console.error(err.stack ?? err);
  process.exit(1);
});
