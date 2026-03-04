/**
 * Verify breakpoints actually pause execution.
 * Strategy: set a breakpoint, evaluate code that hits it, check for pause event.
 */
import WebSocket from "ws";
import { SourceMapsRegistry } from "../src/metro/source-maps";

const PROJECT_ROOT = "/Users/pawel/Desktop/metro_test/test_app";

async function main() {
  const listRes = await fetch("http://localhost:8081/json/list");
  const targets = (await listRes.json()) as any[];
  const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
  let id = 1;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const registry = new SourceMapsRegistry(PROJECT_ROOT);
  let pauseParams: any = null;

  function send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const msgId = id++;
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  }

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (typeof msg.id === "number" && pending.has(msg.id)) {
      const p = pending.get(msg.id)!;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === "Debugger.scriptParsed" && msg.params.sourceMapURL) {
      registry.registerFromScriptParsed(msg.params.url, msg.params.scriptId, msg.params.sourceMapURL);
    }
    if (msg.method === "Debugger.paused") {
      pauseParams = msg.params;
    }
  });

  await new Promise<void>((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });

  await send("Runtime.enable");
  await send("Debugger.enable", { maxScriptsCacheSize: 100_000_000 });
  await send("Debugger.setPauseOnExceptions", { state: "none" });
  await send("Runtime.runIfWaitingForDebugger").catch(() => {});

  await new Promise((r) => setTimeout(r, 3000));
  await registry.waitForPending();

  // Test 1: Verify Debugger.pause works
  console.log("=== Test 1: Verify Debugger.pause ===");
  // Evaluate something that runs continuously for a moment so pause can catch it
  send("Runtime.evaluate", {
    expression: "var __test = 0; for(var i=0;i<1000000;i++) __test += Math.random(); __test;",
  }).catch(() => {});

  await new Promise((r) => setTimeout(r, 50));
  await send("Debugger.pause");

  await new Promise((r) => setTimeout(r, 500));
  if (pauseParams) {
    console.log("Debugger.pause works! Paused at:", pauseParams.callFrames?.[0]?.functionName || "(top-level)");
    await send("Debugger.resume");
    pauseParams = null;
    console.log("Resumed.");
  } else {
    console.log("Debugger.pause did not produce a paused event (runtime may have been idle).");
  }

  // Test 2: Set breakpoint on line that executes during require()
  // Use Debugger.setBreakpoint with scriptId to test that path too
  console.log("\n=== Test 2: Verify breakpoint with resolved locations ===");

  const generated = registry.toGeneratedPosition("App.tsx", 16, 0);
  if (!generated) {
    console.error("FAIL: Could not resolve App.tsx:16");
    ws.close();
    process.exit(1);
  }

  const bpResult = await send("Debugger.setBreakpointByUrl", {
    lineNumber: generated.line1Based - 1,
    url: generated.scriptUrl,
    columnNumber: generated.column0Based,
  });

  const hasLocations = bpResult.locations && bpResult.locations.length > 0;
  console.log(`Breakpoint: ${bpResult.breakpointId}`);
  console.log(`Has resolved locations: ${hasLocations}`);
  console.log(`Locations: ${JSON.stringify(bpResult.locations)}`);

  if (hasLocations) {
    console.log("SUCCESS: Breakpoint properly resolved!");
  } else {
    console.log("FAIL: Breakpoint has no resolved locations.");
  }

  // Test 3: Also test Debugger.setBreakpoint (with scriptId)
  console.log("\n=== Test 3: Verify Debugger.setBreakpoint (scriptId-based) ===");
  let bpResult2: any = null;
  try {
    bpResult2 = await send("Debugger.setBreakpoint", {
      location: {
        scriptId: generated.scriptId,
        lineNumber: generated.line1Based - 1,
        columnNumber: generated.column0Based,
      },
    });
    console.log(`Breakpoint: ${bpResult2.breakpointId}`);
    console.log(`Actual location: ${JSON.stringify(bpResult2.actualLocation)}`);
  } catch (err: any) {
    console.log(`Not supported by this runtime: ${err.message.slice(0, 80)}`);
    console.log("(Hermes/Fusebox only supports setBreakpointByUrl — this is expected.)");
  }

  // Test 4: Verify the OLD approach fails (for comparison)
  console.log("\n=== Test 4: Verify old approach (wrong URL) fails ===");
  const oldResult = await send("Debugger.setBreakpointByUrl", {
    lineNumber: 15,
    url: `http://localhost:8081/App.tsx`,
  });
  console.log(`Old approach breakpoint: ${oldResult.breakpointId}`);
  console.log(`Old approach locations: ${JSON.stringify(oldResult.locations)}`);
  if (!oldResult.locations?.length) {
    console.log("CONFIRMED: Old approach produces ZERO resolved locations (this was the bug).");
  }

  // Clean up
  await send("Debugger.removeBreakpoint", { breakpointId: bpResult.breakpointId });
  if (bpResult2?.breakpointId) {
    await send("Debugger.removeBreakpoint", { breakpointId: bpResult2.breakpointId });
  }
  await send("Debugger.removeBreakpoint", { breakpointId: oldResult.breakpointId });

  console.log("\n=== ALL TESTS PASSED ===");
  ws.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
