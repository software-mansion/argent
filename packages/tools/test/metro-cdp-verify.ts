/**
 * CDP Debugger Domain Verification Script
 *
 * Usage: METRO_PORT=8081 npx ts-node test/metro-cdp-verify.ts
 *
 * Requires: a running Metro server with a connected React Native app.
 * Runs through CDP verification steps and reports results.
 */

import { discoverMetro } from "../src/metro/discovery";
import { selectTarget } from "../src/metro/target-selection";
import { CDPClient } from "../src/metro/cdp-client";

const port = parseInt(process.env.METRO_PORT ?? "8081", 10);

interface TestResult {
  name: string;
  passed: boolean;
  details: string;
  data?: unknown;
}

const results: TestResult[] = [];

function record(name: string, passed: boolean, details: string, data?: unknown) {
  results.push({ name, passed, details, data });
  const icon = passed ? "✅" : "❌";
  console.log(`${icon} ${name}: ${details}`);
  if (data) console.log("   ", JSON.stringify(data, null, 2).slice(0, 500));
}

async function run() {
  console.log(`\n🔍 CDP Verification against Metro port ${port}\n`);

  // Test 1: Discovery
  let client: CDPClient;
  try {
    const metro = await discoverMetro(port);
    record(
      "Discovery",
      true,
      `Found Metro at port ${port}, project: ${metro.projectRoot}, ${metro.targets.length} target(s)`
    );

    const selected = selectTarget(metro.targets, port);
    record(
      "Target selection",
      true,
      `Selected: "${selected.target.title}" (${selected.deviceName}), Fusebox: ${selected.isNewDebugger}`
    );

    client = new CDPClient(selected.webSocketUrl);
    await client.connect();
    record("CDP connect", true, `Connected to ${selected.webSocketUrl}`);
  } catch (err: unknown) {
    record("Discovery/Connect", false, (err as Error).message);
    printSummary();
    return;
  }

  // Test 2: Runtime.enable
  try {
    await client.send("Runtime.enable");
    record("Runtime.enable", true, "Enabled");
  } catch (err: unknown) {
    record("Runtime.enable", false, (err as Error).message);
  }

  // Test 3: Runtime.evaluate
  try {
    const val = await client.evaluate("1 + 1");
    record("Runtime.evaluate", val === 2, `1 + 1 = ${val}`, val);
  } catch (err: unknown) {
    record("Runtime.evaluate", false, (err as Error).message);
  }

  // Test 4: Debugger.enable
  let scriptCount = 0;
  try {
    const result = await client.send("Debugger.enable", {
      maxScriptsCacheSize: 100_000_000,
    });
    await new Promise((r) => setTimeout(r, 500));
    scriptCount = client.getLoadedScripts().size;
    record(
      "Debugger.enable",
      true,
      `Enabled, debuggerId in result, ${scriptCount} scripts parsed`,
      result
    );
  } catch (err: unknown) {
    record("Debugger.enable", false, (err as Error).message);
  }

  // Test 5: Debugger.setPauseOnExceptions
  try {
    await client.send("Debugger.setPauseOnExceptions", { state: "none" });
    record("Debugger.setPauseOnExceptions", true, "Set to 'none'");
  } catch (err: unknown) {
    record("Debugger.setPauseOnExceptions", false, (err as Error).message);
  }

  // Test 6: Debugger.setBreakpointByUrl
  let breakpointId: string | null = null;
  try {
    const result = (await client.send("Debugger.setBreakpointByUrl", {
      lineNumber: 10,
      urlRegex: ".*App\\.tsx$",
      columnNumber: 0,
    })) as { breakpointId: string; locations: unknown[] };
    breakpointId = result.breakpointId;
    record(
      "Debugger.setBreakpointByUrl",
      !!result.breakpointId,
      `breakpointId=${result.breakpointId}, locations=${JSON.stringify(result.locations).slice(0, 200)}`,
      result
    );
  } catch (err: unknown) {
    record("Debugger.setBreakpointByUrl", false, (err as Error).message);
  }

  // Test 7: Debugger.removeBreakpoint
  if (breakpointId) {
    try {
      await client.send("Debugger.removeBreakpoint", { breakpointId });
      record("Debugger.removeBreakpoint", true, `Removed ${breakpointId}`);
    } catch (err: unknown) {
      record("Debugger.removeBreakpoint", false, (err as Error).message);
    }
  }

  // Test 8: Debugger.pause + resume
  try {
    await client.send("Debugger.pause");
    record("Debugger.pause", true, "Pause sent");

    const pauseEvent = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("No Debugger.paused event within 3s")), 3000);
      client.events.on("paused", (params) => {
        clearTimeout(timeout);
        resolve(params);
      });
    });
    record(
      "Debugger.paused event",
      true,
      `Received paused event, ${((pauseEvent.callFrames as unknown[]) ?? []).length} call frames`
    );

    await client.send("Debugger.resume");
    record("Debugger.resume", true, "Resume sent");
  } catch (err: unknown) {
    record("Debugger.pause/resume", false, (err as Error).message);
    try { await client.send("Debugger.resume"); } catch { /* try to unfreeze */ }
  }

  // Test 9: Runtime.evaluate while Debugger enabled (not paused)
  try {
    const val = await client.evaluate(
      "Object.keys(window.__REACT_DEVTOOLS_GLOBAL_HOOK__ || {})"
    );
    record(
      "Runtime.evaluate with Debugger enabled",
      true,
      `DevTools hook keys available`,
      val
    );
  } catch (err: unknown) {
    record("Runtime.evaluate with Debugger", false, (err as Error).message);
  }

  // Test 10: Runtime.addBinding
  try {
    await client.addBinding("__radon_lite_test");
    record("Runtime.addBinding", true, "Binding registered");
  } catch (err: unknown) {
    record("Runtime.addBinding", false, (err as Error).message);
  }

  // Test 11: Script URL format inspection
  const scripts = client.getLoadedScripts();
  if (scripts.size > 0) {
    const sample = [...scripts.values()].slice(0, 3).map((s) => ({
      scriptId: s.scriptId,
      url: s.url.slice(0, 120),
      sourceMapURL: s.sourceMapURL?.slice(0, 80),
    }));
    record(
      "Script URL format",
      true,
      `Sample scripts (of ${scripts.size} total)`,
      sample
    );
  }

  await client.disconnect();
  printSummary();
}

function printSummary() {
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log(
    `\n📊 Results: ${passed} passed, ${failed} failed, ${results.length} total\n`
  );

  if (failed > 0) {
    console.log("Failed tests:");
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`  ❌ ${r.name}: ${r.details}`);
    }
  }
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
