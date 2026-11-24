/**
 * The e2e-full harness's own logic, which otherwise runs only against devices:
 * phase helpers sourced under bash with `run_tool` stubbed, and run-e2e.sh over
 * a stub argent. Tool-server replies come from packages/tool-server/dist, so
 * `bun run build` has to run first.
 *
 * Run: node --test scripts/e2e-full/harness.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HARNESS = fileURLToPath(new URL(".", import.meta.url));
const TOOL_SERVER_DIST = join(HARNESS, "..", "..", "packages", "tool-server", "dist");
const toolServer = (/** @type {string} */ path) =>
  createRequire(import.meta.url)(join(TOOL_SERVER_DIST, path));

// Stubbed run_tool: replies from $STUB/<tool>.{out,rc}, each call logged to $STUB/calls.
const PRELUDE = `
source "$HARNESS/lib/common.sh"
source "$HARNESS/phases/$PHASE"
run_tool() {
  printf '%s\\t%s\\n' "$1" "\${2:-}" >>"$STUB/calls"
  RT_JSON="$(cat "$STUB/$1.out" 2>/dev/null)"
  RT_RC="$(cat "$STUB/$1.rc" 2>/dev/null || echo 0)"
  RT_ERR=""
  RT_OUT="$RT_JSON
$RT_ERR"
  return "$RT_RC"
}
sleep() { :; }
`;

/**
 * Runs `script` with the phase sourced, returning its stdout, the tool calls it
 * made and the cases it recorded.
 * @param {string} phase file under phases/
 * @param {string} script bash run after the phase is sourced
 * @param {{ replies?: Record<string, { rc?: number, out?: string }>, path?: string }} [opts]
 */
function harness(phase, script, { replies = {}, path } = {}) {
  const stub = mkdtempSync(join(tmpdir(), "e2e-harness-"));
  try {
    for (const [tool, { rc = 0, out = "" }] of Object.entries(replies)) {
      writeFileSync(join(stub, `${tool}.out`), out);
      writeFileSync(join(stub, `${tool}.rc`), String(rc));
    }
    const res = spawnSync("bash", ["-c", PRELUDE + script], {
      encoding: "utf8",
      env: {
        ...process.env,
        ...(path ? { PATH: `${path}:${process.env.PATH}` } : {}),
        HARNESS,
        PHASE: phase,
        STUB: stub,
        E2E_JSONL: join(stub, "results.jsonl"),
      },
    });
    assert.equal(res.status, 0, res.stderr);
    const lines = (/** @type {string} */ file) =>
      existsSync(join(stub, file))
        ? readFileSync(join(stub, file), "utf8").split("\n").filter(Boolean)
        : [];
    return {
      stdout: res.stdout,
      calls: lines("calls").map((line) => {
        const [tool, args] = line.split("\t");
        return { tool, args };
      }),
      results: lines("results.jsonl").map((line) => {
        const { tool, case: name, status, detail } = JSON.parse(line);
        return { tool, case: name, status, detail };
      }),
    };
  } finally {
    rmSync(stub, { recursive: true, force: true });
  }
}

test("_mtime prints only the modification time, whichever stat is installed", () => {
  const dir = mkdtempSync(join(tmpdir(), "e2e-mtime-"));
  try {
    const file = join(dir, "descriptor.json");
    writeFileSync(file, "{}");
    utimesSync(file, 1700000000, 1700000000);
    const fakes = {
      // GNU's -f is --file-system: it reads `%m` as a file, prints the
      // filesystem of the real one and then fails.
      gnu: `case "$1" in
  -c) [ "$2" = %Y ] && echo 1700000000 ;;
  -f) echo "stat: cannot read file system information for '$2': No such file or directory" >&2
      printf '  File: "%s"\\n    ID: 0 Namelen: 255 Type: ext2/ext3\\nBlocks: Total: 100 Free: 50 Available: 40\\n' "$3"
      exit 1 ;;
esac`,
      bsd: `case "$1" in
  -f) [ "$2" = %m ] && echo 1700000000 ;;
  *) echo "stat: illegal option -- \${1#-}" >&2; exit 1 ;;
esac`,
    };
    for (const flavour of ["system", ...Object.keys(fakes)]) {
      let path;
      if (flavour !== "system") {
        path = join(dir, flavour);
        mkdirSync(path);
        writeFileSync(join(path, "stat"), `#!/bin/sh\n${fakes[flavour]}\n`);
        chmodSync(join(path, "stat"), 0o755);
      }
      const { stdout } = harness("60-device-provider.sh", `_mtime "${file}"`, { path });
      assert.equal(stdout, "1700000000\n", `${flavour} stat`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run-e2e.sh hands its tools XDG base directories inside the sandbox HOME", () => {
  const dir = mkdtempSync(join(tmpdir(), "e2e-xdg-"));
  try {
    // A copy, so the run's results/ lands here rather than in the checkout.
    const root = join(dir, "scripts", "e2e-full");
    cpSync(HARNESS, root, { recursive: true, filter: (src) => !src.endsWith("results") });
    // An argent whose every call logs the environment it was started with.
    mkdirSync(join(dir, "pkg", "package", "dist"), { recursive: true });
    writeFileSync(join(dir, "pkg", "package", "package.json"), '{"version":"0.0.0-e2e"}');
    writeFileSync(
      join(dir, "pkg", "package", "dist", "cli.js"),
      `const { appendFileSync } = require("node:fs");
const { env, argv } = process;
appendFileSync(env.E2E_ENV_LOG, JSON.stringify({
  HOME: env.HOME, XDG_CONFIG_HOME: env.XDG_CONFIG_HOME, XDG_CACHE_HOME: env.XDG_CACHE_HOME,
  XDG_DATA_HOME: env.XDG_DATA_HOME, XDG_STATE_HOME: env.XDG_STATE_HOME,
}) + "\\n");
if (argv.slice(2).join(" ") === "server status --json") console.log('{"running":true,"healthy":true}');
`
    );
    const tgz = join(dir, "swmansion-argent-e2e.tgz");
    const tar = spawnSync("tar", ["czf", tgz, "-C", join(dir, "pkg"), "package"]);
    assert.equal(tar.status, 0, String(tar.stderr));

    const home = join(dir, "home");
    const xdg = {
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_CACHE_HOME: join(home, "cache"),
      XDG_DATA_HOME: join(home, "data"),
      XDG_STATE_HOME: join(home, "state"),
    };
    const log = join(dir, "env.jsonl");
    const run = spawnSync(
      "bash",
      [join(root, "run-e2e.sh"), "--tgz", tgz, "--skip-install", "--phase", "validation"],
      {
        encoding: "utf8",
        timeout: 60_000,
        env: { ...process.env, ...xdg, HOME: home, TMPDIR: dir, E2E_ENV_LOG: log },
      }
    );
    assert.ok(existsSync(log), `argent never ran: ${run.stderr}`);
    const seen = readFileSync(log, "utf8").split("\n").filter(Boolean)[0];
    const { HOME, ...dirs } = JSON.parse(seen);
    assert.ok(HOME.startsWith(join(dir, "argent-e2e.")), HOME);
    assert.deepEqual(dirs, {
      XDG_CONFIG_HOME: join(HOME, ".config"),
      XDG_CACHE_HOME: join(HOME, ".cache"),
      XDG_DATA_HOME: join(HOME, ".local", "share"),
      XDG_STATE_HOME: join(HOME, ".local", "state"),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** @typedef {{ platform: string, nativeId: string, capabilities: string }} Device */

/** @type {Device} */
const ANDROID = {
  platform: "android",
  nativeId: "emulator-5554",
  capabilities: '["simulator-server","adb"]',
};
/** @type {Device} */
const IOS = {
  platform: "ios",
  nativeId: "6E3C1F4B-2D8A-4F7E-9B1C-0A5D3E2F4C6B",
  capabilities: '["simulator-server","simctl","ax-service"]',
};

/**
 * What the tool-server's capability gate throws for `capability` on `device`,
 * published with the phase's own descriptor.
 * @param {Device} device
 * @param {string} capability
 */
function denial({ platform, nativeId, capabilities }, capability) {
  const home = mkdtempSync(join(tmpdir(), "e2e-home-"));
  try {
    const kind = platform === "ios" ? "simulator" : "emulator";
    const { stdout: descriptor } = harness(
      "60-device-provider.sh",
      `PROV_API_URL=http://127.0.0.1:1 _descriptor_json ${nativeId} ${platform} ${kind} '${capabilities}'`
    );
    mkdirSync(join(home, ".argent", "providers"), { recursive: true });
    writeFileSync(join(home, ".argent", "providers", "e2eprov.json"), descriptor);
    const gate = spawnSync(
      process.execPath,
      [
        "-e",
        `const { assertExternalCapabilitySync } = require(process.argv[1]);
        try { assertExternalCapabilitySync("e2e", process.argv[2], process.argv[3]); }
        catch (e) { process.stdout.write(e.message); }`,
        join(TOOL_SERVER_DIST, "utils", "external-devices.js"),
        `ext:e2eprov:${nativeId}`,
        capability,
      ],
      { encoding: "utf8", env: { ...process.env, HOME: home } }
    );
    assert.equal(gate.status, 0, gate.stderr);
    assert.ok(gate.stdout, `the gate let ${capability} through`);
    return gate.stdout;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

for (const { device, tool, args, capability } of [
  {
    device: ANDROID,
    tool: "native-profiler-start",
    args: `{"device_id":"ext:e2eprov:${ANDROID.nativeId}"}`,
    capability: "native-profiler",
  },
  {
    device: IOS,
    tool: "native-describe-screen",
    args: `{"udid":"ext:e2eprov:${IOS.nativeId}","bundleId":"com.e2e.denied"}`,
    capability: "native-devtools",
  },
]) {
  test(`capability denial on ${device.platform} passes on the gate's refusal of ${tool}`, () => {
    const { calls, results } = harness(
      "60-device-provider.sh",
      `_assert_capability_denied device-provider ${device.platform} ext:e2eprov:${device.nativeId}`,
      { replies: { [tool]: { rc: 1, out: denial(device, capability) } } }
    );
    assert.deepEqual(calls, [{ tool, args }]);
    assert.deepEqual(
      results.map(({ tool, case: name, status }) => ({ tool, case: name, status })),
      [{ tool, case: `denied: ${capability} not granted`, status: "pass" }]
    );
  });
}

test("capability denial fails when the refusal names another capability", () => {
  const { results } = harness(
    "60-device-provider.sh",
    `_assert_capability_denied device-provider android ext:e2eprov:${ANDROID.nativeId}`,
    { replies: { "native-profiler-start": { rc: 1, out: denial(ANDROID, "native-devtools") } } }
  );
  assert.deepEqual(
    results.map(({ tool, status }) => ({ tool, status })),
    [{ tool: "native-profiler-start", status: "fail" }]
  );
});

const D = '"device_id":"emulator-5554","port":8081';
const APP = '"udid":"emulator-5554","bundleId":"xyz.blueskyweb.app"';
const CAP = `${APP},"port":8081`;

/**
 * view-network-logs' reply, from the tool's own execute over a started capture
 * whose interceptor recorded `entries`.
 * @param {object[]} entries
 */
async function networkLogs(entries) {
  const { networkLogsTool } = toolServer("tools/network/network-logs.js");
  const { jsCapturePayload, setJsCapture } = toolServer("blueprints/network-inspector.js");
  setJsCapture(jsCapturePayload(8081, "emulator-5554"), {
    bundleId: "xyz.blueskyweb.app",
    intent: "started",
    installed: true,
  });
  const evaluate = async () =>
    JSON.stringify({ entries, total: entries.length, interceptorInstalled: true });
  return networkLogsTool.execute(
    { debugger: { cdp: { evaluate } } },
    { device_id: "emulator-5554", port: 8081, pageIndex: "latest" }
  );
}

// Shaped like network-capture-start's and network-capture-stop's results.
const CAPTURE_REPLIES = {
  "network-capture-start": {
    out: JSON.stringify({
      status: "ok",
      layers: [
        { layer: "js", armed: true },
        { layer: "android-native", armed: true },
      ],
    }),
  },
  "network-capture-stop": {
    out: JSON.stringify({
      status: "ok",
      layers: [
        { layer: "js", armed: false, total: 2 },
        { layer: "android-native", armed: false, total: 0 },
      ],
    }),
  },
};

// Shaped like await-network-request's results; `argent run` exits 1 on an unmet wait.
const AWAIT_MATCHED = {
  out: JSON.stringify({
    success: true,
    elapsed: 130,
    match: {
      id: "android-1",
      layer: "android-native",
      method: "GET",
      url: "https://example.com/",
      status: 200,
      state: "complete",
    },
  }),
};
const AWAIT_UNMET = {
  rc: 1,
  out: JSON.stringify({ success: false, elapsed: 15000, cause: "unmet" }),
};

// Shaped like the interceptor's createRecord/setResponse.
const request = (/** @type {number} */ id, /** @type {string} */ url, complete = true) => ({
  id,
  requestId: `rn-net-${id}`,
  state: complete ? "complete" : "pending",
  resourceType: "Fetch",
  request: { url, method: "GET", headers: {} },
  timestamp: 1700000000 + id,
  ...(complete
    ? {
        response: { url, status: 200, statusText: "", headers: {}, mimeType: "application/json" },
        encodedDataLength: 1256,
        durationMs: 120,
      }
    : {}),
});

const NETWORK_CALLS = [
  { tool: "network-capture-start", args: `{${CAP}}` },
  {
    tool: "debugger-evaluate",
    args: `{${D},"expression":"fetch('https://example.com').then(()=>0)"}`,
  },
  {
    tool: "await-network-request",
    args: `{${APP},"url":"example.com","outcome":"any","timeoutMs":15000}`,
  },
  { tool: "view-network-logs", args: `{${D},"pageIndex":"latest"}` },
];
const CAPTURE_STOP_CALL = { tool: "network-capture-stop", args: `{${CAP}}` };

test("network capture opens the newest request view-network-logs lists", async () => {
  const out = await networkLogs([
    request(1, "https://bsky.social/xrpc/app.bsky.feed.getTimeline"),
    request(2, "https://example.com/", false),
  ]);
  const { calls, results } = harness(
    "50-rn-bluesky.sh",
    `_assert_network_capture rn '${D}' '${CAP}' '${APP}'`,
    {
      replies: {
        ...CAPTURE_REPLIES,
        "await-network-request": AWAIT_MATCHED,
        "view-network-logs": { out },
      },
    }
  );
  assert.deepEqual(calls, [
    ...NETWORK_CALLS,
    { tool: "view-network-request-details", args: `{${D},"requestId":"rn-net-2"}` },
    CAPTURE_STOP_CALL,
  ]);
  assert.deepEqual(
    results.map(({ tool, status }) => ({ tool, status })),
    [
      { tool: "network-capture-start", status: "pass" },
      { tool: "await-network-request", status: "pass" },
      { tool: "view-network-logs", status: "pass" },
      { tool: "view-network-request-details", status: "pass" },
      { tool: "network-capture-stop", status: "pass" },
    ]
  );
});

for (const { name, fetchRc, detail } of [
  {
    name: "nothing was captured",
    fetchRc: 0,
    detail: /^no request id in view-network-logs: rc=0: No network traffic captured\./,
  },
  {
    name: "the harness fetch failed",
    fetchRc: 1,
    detail:
      /^debugger-evaluate of the harness fetch failed \(rc=1\), so nothing may have been sent$/,
  },
]) {
  test(`network capture fails when ${name}`, async () => {
    const { calls, results } = harness(
      "50-rn-bluesky.sh",
      `_assert_network_capture rn '${D}' '${CAP}' '${APP}'`,
      {
        replies: {
          ...CAPTURE_REPLIES,
          "debugger-evaluate": { rc: fetchRc },
          "await-network-request": AWAIT_UNMET,
          "view-network-logs": { out: await networkLogs([]) },
        },
      }
    );
    assert.deepEqual(calls, [...NETWORK_CALLS, CAPTURE_STOP_CALL]);
    assert.deepEqual(
      results.map(({ tool, status }) => ({ tool, status })),
      [
        { tool: "network-capture-start", status: "pass" },
        { tool: "await-network-request", status: "fail" },
        { tool: "view-network-logs", status: "pass" },
        { tool: "view-network-request-details", status: "fail" },
        { tool: "network-capture-stop", status: "pass" },
      ]
    );
    assert.match(results[3].detail, detail);
  });
}
