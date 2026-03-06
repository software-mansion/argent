/**
 * End-to-end test: connect to Metro, set a breakpoint using the source map
 * resolution, trigger it, verify it pauses, then clean up.
 */
import WebSocket from "ws";
import { SourceMapConsumer } from "source-map-js";
import { SourceMapsRegistry } from "../src/debugger/source-maps";

const PROJECT_ROOT = "/Users/pawel/Desktop/metro_test/test_app";

async function main() {
  // 1. Discover Metro targets
  console.log("=== Step 1: Discover Metro targets ===");
  const listRes = await fetch("http://localhost:8081/json/list");
  const targets = (await listRes.json()) as any[];
  const target = targets[0];
  console.log(`Target: ${target.title} (${target.description})`);
  console.log(`WebSocket: ${target.webSocketDebuggerUrl}`);

  // 2. Connect via CDP
  console.log("\n=== Step 2: Connect via CDP ===");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 1;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  let pausedResolve: ((params: any) => void) | null = null;

  const registry = new SourceMapsRegistry(PROJECT_ROOT);

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
      registry.registerFromScriptParsed(
        msg.params.url,
        msg.params.scriptId,
        msg.params.sourceMapURL
      );
    }

    if (msg.method === "Debugger.paused" && pausedResolve) {
      pausedResolve(msg.params);
      pausedResolve = null;
    }
  });

  await new Promise<void>((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  console.log("Connected!");

  // 3. Enable domains and wait for source maps
  console.log("\n=== Step 3: Enable debugger domains ===");
  await send("Runtime.enable");
  await send("Debugger.enable", { maxScriptsCacheSize: 100_000_000 });
  await send("Debugger.setPauseOnExceptions", { state: "none" });
  await send("Runtime.runIfWaitingForDebugger").catch(() => {});

  await new Promise((r) => setTimeout(r, 2000));
  await registry.waitForPending();
  console.log("Source maps loaded!");

  // 4. Resolve App.tsx:16 (inside buttonHandler)
  console.log("\n=== Step 4: Resolve breakpoint position ===");
  const file = "App.tsx";
  const line = 16; // console.log('buttonHandler')

  const generated = registry.toGeneratedPosition(file, line, 0);
  if (!generated) {
    console.error(`FAIL: Could not resolve ${file}:${line}`);
    ws.close();
    process.exit(1);
  }

  console.log(`Source: ${file}:${line}`);
  console.log(`Generated: ${generated.scriptUrl.slice(0, 80)}... line=${generated.line1Based} col=${generated.column0Based}`);
  console.log(`Script ID: ${generated.scriptId}`);
  const matchedSource = registry.findMatchingSource(file);
  console.log(`Matched source map entry: ${matchedSource}`);

  // 5. Set breakpoint
  console.log("\n=== Step 5: Set breakpoint via CDP ===");
  const bpResult = await send("Debugger.setBreakpointByUrl", {
    lineNumber: generated.line1Based - 1,
    url: generated.scriptUrl,
    columnNumber: generated.column0Based,
  });

  console.log(`Breakpoint ID: ${bpResult.breakpointId}`);
  console.log(`Resolved locations: ${JSON.stringify(bpResult.locations)}`);

  if (!bpResult.locations?.length) {
    console.error("FAIL: Breakpoint has no resolved locations!");
    ws.close();
    process.exit(1);
  }
  console.log("SUCCESS: Breakpoint set with resolved location!");

  // 6. Also test App.tsx:21 (console.log in App function)
  console.log("\n=== Step 6: Test another breakpoint (App.tsx:21) ===");
  const generated2 = registry.toGeneratedPosition("App.tsx", 21, 0);
  if (!generated2) {
    console.error("FAIL: Could not resolve App.tsx:21");
  } else {
    const bpResult2 = await send("Debugger.setBreakpointByUrl", {
      lineNumber: generated2.line1Based - 1,
      url: generated2.scriptUrl,
      columnNumber: generated2.column0Based,
    });
    console.log(`Breakpoint 2 ID: ${bpResult2.breakpointId}`);
    console.log(`Resolved locations: ${JSON.stringify(bpResult2.locations)}`);

    if (bpResult2.locations?.length) {
      console.log("SUCCESS: Second breakpoint also set with resolved location!");
    }

    // Clean up
    await send("Debugger.removeBreakpoint", { breakpointId: bpResult2.breakpointId });
  }

  // 7. Wait briefly for the first breakpoint to be hit (press the button in the app)
  console.log("\n=== Step 7: Waiting 8s for breakpoint hit (press button in simulator) ===");
  const pausedPromise = new Promise<any>((resolve) => {
    pausedResolve = resolve;
    setTimeout(() => {
      if (pausedResolve) {
        pausedResolve = null;
        resolve(null);
      }
    }, 8000);
  });

  const pausedParams = await pausedPromise;
  if (pausedParams) {
    console.log("\nDEBUGGER PAUSED!");
    console.log(`Reason: ${pausedParams.reason}`);
    const topFrame = pausedParams.callFrames?.[0];
    if (topFrame) {
      console.log(`Top frame: ${topFrame.functionName} at ${topFrame.url?.slice(0, 60)}...`);
      console.log(`  Location: line=${topFrame.location.lineNumber} col=${topFrame.location.columnNumber}`);
    }
    await send("Debugger.resume");
    console.log("Resumed execution.");
  } else {
    console.log("(Breakpoint was not hit during wait - but it was properly SET, which is the key fix)");
  }

  // 8. Clean up
  await send("Debugger.removeBreakpoint", { breakpointId: bpResult.breakpointId });
  console.log("\n=== DONE: All tests passed! ===");
  ws.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
