// The Argent gym: a deterministic text-simulator of devices + apps + screens.
// Each tool has a transition function that mutates the world and returns the
// exact observation the real tool would. The expert policy (expert.ts) drives
// this gym; because observations come from the simulator and tap coordinates
// resolve against real on-screen elements, the resulting trajectories are
// grounded — no hallucinated outputs, no ungrounded coordinates.

import {
  describeSource,
  formatComponentTree,
  formatDescribe,
  formatNetworkLogs,
  round3,
  SCREEN_PX,
  visibleElements,
} from "./format.ts";
import type { ElementDef, ScreenDef, World } from "./types.ts";

const BASE_EPOCH = 1_750_000_000_000;

export interface ToolResult {
  /** String content for the `tool` message. */
  content: string;
  /** True when the real tool auto-attaches a screenshot after running. */
  autoScreenshot?: boolean;
  /** True when this result represents a tool failure (for recovery demos). */
  isError?: boolean;
}

export class GymError extends Error {}

function tick(world: World, ms: number): number {
  world.clock += ms;
  return BASE_EPOCH + world.clock;
}

export function currentScreenDef(world: World): ScreenDef {
  const s = world.app.screens[world.currentScreen];
  if (!s) throw new GymError(`unknown screen ${world.currentScreen}`);
  return s;
}

export function isScrolled(world: World): boolean {
  return world.scrolledScreens.has(world.currentScreen);
}

/** All elements the agent could currently see via a discovery tool. */
export function currentVisible(world: World): ElementDef[] {
  return visibleElements(currentScreenDef(world), isScrolled(world));
}

/** Resolve the element whose frame contains a normalized point. */
export function elementAt(world: World, x: number, y: number): ElementDef | undefined {
  return currentVisible(world).find(
    (e) =>
      x >= e.frame.x && x <= e.frame.x + e.frame.w && y >= e.frame.y && y <= e.frame.y + e.frame.h
  );
}

function json(obj: unknown): string {
  return JSON.stringify(obj);
}

// The post-action screenshot, rendered as the content the image conveys. For a
// text model this is the navigation signal (the user notes screenshots are the
// single most valuable cue): after every action the agent "sees" which screen
// it landed on and the key elements on it. A vision model would receive the
// real PNG here instead (the gym can rasterize the same layout — see
// training/render-screenshot).
export function sceneCaption(world: World): string {
  const screen = currentScreenDef(world);
  const els = currentVisible(world);
  const content = els.filter((e) => e.label && !e.isTab).map((e) => e.label!);
  const tabs = els.filter((e) => e.isTab).map((e) => e.label!);
  const shown = content.slice(0, 8);
  let s = `[screenshot] "${screen.title}" screen`;
  if (shown.length) {
    s += ` showing: ${shown.join(", ")}`;
    if (content.length > shown.length) s += `, …`;
  }
  if (tabs.length) s += ` | bottom tabs: ${tabs.join(", ")}`;
  return s;
}

function screenshotNote(world: World): string {
  return `\n\n${sceneCaption(world)}`;
}

// Track which navigation element a focused text field belongs to.
function setFocus(world: World, field: string | undefined) {
  (world as World & { _focus?: string })._focus = field;
}
function getFocus(world: World): string | undefined {
  return (world as World & { _focus?: string })._focus;
}

export type ToolArgs = Record<string, unknown>;

/**
 * Execute a tool against the world. Throws GymError on genuinely impossible
 * calls (which the expert never makes); returns an `isError` result for the
 * injected, recoverable failures the expert is meant to demonstrate handling.
 */
export function execute(world: World, tool: string, args: ToolArgs): ToolResult {
  switch (tool) {
    case "list-devices":
      return { content: json(listDevices(world)) };

    case "boot-device":
      return bootDevice(world, args);

    case "launch-app":
      return launchApp(world, args);

    case "restart-app": {
      world.currentScreen = world.app.entryScreen;
      world.navStack = [];
      tick(world, 3000);
      return {
        content: json({ restarted: true, bundleId: world.app.bundleId }),
        autoScreenshot: true,
      };
    }

    case "reinstall-app": {
      tick(world, 8000);
      return { content: json({ reinstalled: true, bundleId: world.app.bundleId }) };
    }

    case "open-url":
      return openUrl(world, args);

    case "describe":
      return describe(world);

    case "debugger-status":
      return debuggerStatus(world);

    case "debugger-connect":
      return debuggerConnect(world);

    case "debugger-component-tree":
      return componentTree(world);

    case "debugger-evaluate":
      return { content: json({ value: evalExpr(world, String(args.expression ?? "")) }) };

    case "debugger-inspect-element":
      return inspectElement(world, args);

    case "debugger-reload-metro":
      tick(world, 1200);
      return { content: json({ reloaded: true }) };

    case "gesture-tap":
      return gestureTap(world, args);

    case "gesture-swipe":
      return gestureSwipe(world, args);

    case "gesture-scroll":
      return gestureScroll(world, args);

    case "keyboard":
      return keyboard(world, args);

    case "button":
      return pressButton(world, args);

    case "run-sequence":
      return runSequence(world, args);

    case "screenshot":
      return screenshot(world, args);

    case "screenshot-diff":
      return screenshotDiff(world, args);

    case "react-profiler-start":
      world.reactProfiling = true;
      world.reactProfileStartMs = tick(world, 200);
      return {
        content: json({
          startedAtEpochMs: world.reactProfileStartMs,
          startedAtRelativeMs: 0,
          platform: world.platform,
        }),
      };

    case "native-profiler-start":
      world.nativeProfiling = true;
      tick(world, 200);
      return { content: json({ started: true, platform: world.platform }) };

    case "react-profiler-stop": {
      world.reactProfiling = false;
      const cap = tick(world, 100) - (world.reactProfileStartMs ?? BASE_EPOCH);
      return { content: json({ stopped: true, capturedMs: cap, fiber_renders_captured: 38 }) };
    }

    case "native-profiler-stop":
      world.nativeProfiling = false;
      return { content: json({ stopped: true, capturedMs: 5200 }) };

    case "react-profiler-analyze":
      return { content: reactAnalyzeReport(world) };

    case "native-profiler-analyze":
      return { content: nativeAnalyzeReport(world) };

    case "profiler-combined-report":
      return { content: combinedReport(world) };

    case "react-profiler-status":
      return { content: json({ isRecording: world.reactProfiling }) };

    case "react-profiler-renders":
      return { content: reactRendersReport(world) };

    case "react-profiler-cpu-summary":
      return { content: reactCpuSummary(world) };

    case "react-profiler-fiber-tree":
      return { content: fiberTree(world) };

    case "react-profiler-component-source":
      return { content: componentSource(world, args) };

    case "profiler-cpu-query":
      return { content: cpuQuery(world, args) };

    case "profiler-commit-query":
      return { content: commitQuery(world, args) };

    case "gesture-pinch": {
      const ts = tick(world, 1500);
      return {
        content: json({ pinched: true, timestampMs: ts }) + screenshotNote(world),
        autoScreenshot: true,
      };
    }

    case "rotate": {
      const ts = tick(world, 1000);
      return {
        content:
          json({
            rotated: true,
            orientation: String(args.orientation ?? "Portrait"),
            timestampMs: ts,
          }) + screenshotNote(world),
        autoScreenshot: true,
      };
    }

    case "debugger-log-registry":
      return { content: logRegistry(world) };

    case "native-describe-screen":
      return { content: json(nativeDescribe(world)) };

    case "chromium-tabs":
      return chromiumTabs(world, args);

    case "gather-workspace-data":
      return { content: json(workspaceData(world)) };

    case "flow-start-recording":
      return flowStart(world, args);

    case "flow-add-echo":
      return flowAddEcho(world, args);

    case "flow-add-step":
      return flowAddStep(world, args);

    case "flow-finish-recording":
      return flowFinish(world);

    case "flow-read-prerequisite":
      return flowReadPrereq(world, args);

    case "flow-execute":
      return flowExecute(world, args);

    case "view-network-logs":
      return { content: formatNetworkLogs(world.networkLog) };

    case "view-network-request-details":
      return networkDetails(world, args);

    case "native-network-logs":
      return { content: formatNetworkLogs(world.networkLog) };

    case "stop-all-simulator-servers":
      world.simServerRunning = false;
      return { content: json({ stopped: true, count: 1 }) };

    case "stop-simulator-server":
      world.simServerRunning = false;
      return { content: json({ stopped: true }) };

    case "stop-metro":
      world.metroRunning = false;
      return { content: json({ stopped: true }) };

    default:
      throw new GymError(`gym has no transition for tool '${tool}'`);
  }
}

// ---- individual transitions ----

function listDevices(world: World) {
  return {
    devices: world.devices.map((d) => {
      if (d.platform === "ios") {
        return {
          platform: "ios",
          udid: d.id,
          name: d.name,
          state: d.booted ? "Booted" : "Shutdown",
        };
      }
      if (d.platform === "android") {
        return {
          platform: "android",
          serial: d.id,
          state: d.booted ? "device" : "offline",
          kind: "emulator",
          model: d.name,
          avdName: d.avdName ?? null,
          sdkLevel: d.sdkLevel ?? null,
        };
      }
      return { platform: "chromium", id: d.id, port: d.port, booted: true };
    }),
    avds: world.avds.map((name) => ({ name })),
  };
}

function bootDevice(world: World, args: ToolArgs): ToolResult {
  const dev = world.devices.find((d) => d.id === world.deviceId);
  if (!dev) throw new GymError("boot target not found");
  if (world.inject.bootTimeoutOnce) {
    world.inject.bootTimeoutOnce = false;
    tick(world, 180000);
    return {
      content: json({
        error: "boot timed out waiting for bootCompleted (sys.boot_completed=1)",
        reason: "timeout",
      }),
      isError: true,
    };
  }
  dev.booted = true;
  tick(world, dev.platform === "android" ? 45000 : 6000);
  if (dev.platform === "ios")
    return { content: json({ platform: "ios", udid: dev.id, booted: true }) };
  if (dev.platform === "android")
    return {
      content: json({ platform: "android", serial: dev.id, avdName: dev.avdName, booted: true }),
    };
  return { content: json({ platform: "chromium", id: dev.id, port: dev.port, booted: true }) };
}

function launchApp(world: World, args: ToolArgs): ToolResult {
  world.simServerRunning = true;
  world.launchedBundle = world.app.bundleId;
  world.currentScreen = world.app.entryScreen;
  world.navStack = [];
  tick(world, 3000);
  return {
    content: json({ launched: true, bundleId: world.app.bundleId }) + screenshotNote(world),
    autoScreenshot: true,
  };
}

function openUrl(world: World, args: ToolArgs): ToolResult {
  const url = String(args.url ?? "");
  const target = world.app.urls?.[url];
  if (target) {
    world.launchedBundle = world.app.bundleId;
    world.navStack = [world.currentScreen];
    world.currentScreen = target;
  }
  world.simServerRunning = true;
  tick(world, 2000);
  return { content: json({ opened: true, url }) + screenshotNote(world), autoScreenshot: true };
}

function describe(world: World): ToolResult {
  if (world.inject.describeFailsOnce) {
    world.inject.describeFailsOnce = false;
    return {
      content: json({
        error: "ax-service unavailable: accessibility runtime not responding",
        hint: "the app may still be launching; retry, or fall back to a screenshot",
      }),
      isError: true,
    };
  }
  tick(world, 100);
  return {
    content:
      formatDescribe(world.platform, currentScreenDef(world), isScrolled(world)) +
      screenshotNote(world),
    autoScreenshot: true,
  };
}

function debuggerStatus(world: World): ToolResult {
  if (world.inject.debuggerDropOnce) {
    world.inject.debuggerDropOnce = false;
    return {
      content: json({
        connected: false,
        targets: [],
        hint: "No CDP targets. Ensure the RN app is connected to Metro; try restart-app then retry.",
      }),
      isError: true,
    };
  }
  world.metroRunning = true;
  world.debuggerConnected = true;
  return {
    content: json({
      connected: true,
      logicalDeviceId: world.deviceId,
      loadedScripts: 412,
      enabledDomains: ["Runtime", "Debugger", "Network"],
      sourceMapReady: true,
    }),
  };
}

function debuggerConnect(world: World): ToolResult {
  world.metroRunning = true;
  world.debuggerConnected = true;
  return { content: json({ connected: true, logicalDeviceId: world.deviceId }) };
}

function componentTree(world: World): ToolResult {
  if (!world.debuggerConnected) {
    return {
      content: json({
        error: "No CDP target connected. Run debugger-status / debugger-connect first.",
      }),
      isError: true,
    };
  }
  return {
    content: formatComponentTree(world.platform, currentScreenDef(world), isScrolled(world)),
  };
}

function inspectElement(world: World, args: ToolArgs): ToolResult {
  const screen = currentScreenDef(world);
  const file = `src/screens/${cap(screen.key)}Screen.tsx`;
  return {
    content: json({
      source: `${file}:${24 + (screen.elements.length % 30)}`,
      fragment: `<Pressable onPress={handlePress} testID="${screen.elements[0]?.identifier ?? "el"}">`,
    }),
  };
}

function gestureTap(world: World, args: ToolArgs): ToolResult {
  const x = Number(args.x);
  const y = Number(args.y);
  const el = elementAt(world, x, y);
  // Injected miss: the first nav tap "lands" but nothing changes, forcing the
  // expert to re-discover and retry (teaches the discovery-on-failure rule).
  if (world.inject.tapMissOnce && el?.navigatesTo) {
    world.inject.tapMissOnce = false;
    tick(world, 1500);
    return {
      content: json({ tapped: true, timestampMs: tick(world, 0) }) + screenshotNote(world),
      autoScreenshot: true,
    };
  }
  if (el) {
    if (el.textField) setFocus(world, el.textField);
    if (el.togglesState) world.toggles[el.togglesState] = !world.toggles[el.togglesState];
    if (el.firesRequest) world.networkLog.push(el.firesRequest);
    if (el.navigatesTo) {
      world.navStack.push(world.currentScreen);
      world.currentScreen = el.navigatesTo;
    }
  }
  const ts = tick(world, 1500);
  return {
    content: json({ tapped: true, timestampMs: ts }) + screenshotNote(world),
    autoScreenshot: true,
  };
}

function gestureSwipe(world: World, args: ToolArgs): ToolResult {
  const fromY = Number(args.fromY);
  const toY = Number(args.toY);
  if (fromY > toY) world.scrolledScreens.add(world.currentScreen); // swipe up reveals more
  const ts = tick(world, 1500);
  return {
    content: json({ swiped: true, timestampMs: ts }) + screenshotNote(world),
    autoScreenshot: true,
  };
}

function gestureScroll(world: World, args: ToolArgs): ToolResult {
  const deltaY = Number(args.deltaY ?? 0.5);
  if (deltaY > 0) world.scrolledScreens.add(world.currentScreen);
  const ts = tick(world, 1500);
  return {
    content: json({ scrolled: true, timestampMs: ts }) + screenshotNote(world),
    autoScreenshot: true,
  };
}

function keyboard(world: World, args: ToolArgs): ToolResult {
  const text = args.text != null ? String(args.text) : undefined;
  const focus = getFocus(world);
  if (text && focus) world.fieldValues[focus] = text;
  const ts = tick(world, 300);
  return {
    content: json({ ok: true, timestampMs: ts }) + screenshotNote(world),
    autoScreenshot: true,
  };
}

function pressButton(world: World, args: ToolArgs): ToolResult {
  const button = String(args.button ?? "");
  if ((button === "back" || button === "home") && world.navStack.length) {
    world.currentScreen = world.navStack.pop()!;
  }
  const ts = tick(world, 1500);
  return {
    content: json({ pressed: true, button, timestampMs: ts }) + screenshotNote(world),
    autoScreenshot: true,
  };
}

function runSequence(world: World, args: ToolArgs): ToolResult {
  const steps = (args.steps as Array<{ tool: string; args: ToolArgs }>) ?? [];
  const results: Array<{ tool: string; result: unknown }> = [];
  for (const step of steps) {
    // Re-dispatch through execute with udid injected (mirrors the real tool).
    const stepArgs = { udid: world.deviceId, ...step.args };
    const r = execute(world, step.tool, stepArgs);
    results.push({ tool: step.tool, result: JSON.parse(stripScreenshotNote(r.content)) });
  }
  tick(world, 500);
  return {
    content:
      json({ completed: results.length, total: steps.length, steps: results }) +
      screenshotNote(world),
    autoScreenshot: true,
  };
}

export function stripScreenshotNote(s: string): string {
  return s.replace(/\n\n\[screenshot\][\s\S]*$/, "");
}

function screenshot(world: World, args: ToolArgs): ToolResult {
  const include = args.includeImageInContext !== false;
  const path = `/tmp/argent/shot-${world.clock}.png`;
  if (!include) {
    return { content: json({ image: { path } }) };
  }
  return { content: json({ image: { path } }) + screenshotNote(world) };
}

function screenshotDiff(world: World, args: ToolArgs): ToolResult {
  return {
    content: json({
      changed: true,
      diffPixelRatio: 0.0123,
      diffImage: { path: `/tmp/argent/diff-${world.clock}.png` },
      summary: "1.2% of pixels changed, localized to the region under test.",
    }),
  };
}

function evalExpr(world: World, expr: string): unknown {
  if (/version/i.test(expr)) return "0.81.0";
  if (/length|count/i.test(expr)) return currentVisible(world).length;
  return true;
}

function networkDetails(world: World, args: ToolArgs): ToolResult {
  const id = String(args.requestId ?? "req_1");
  const idx = Math.max(0, Number(id.replace(/\D/g, "")) - 1);
  const r = world.networkLog[idx] ?? world.networkLog[0];
  if (!r) return { content: json({ error: "unknown requestId" }), isError: true };
  return {
    content: json({
      requestId: id,
      state: "complete",
      resourceType: r.resourceType,
      durationMs: r.durationMs,
      encodedDataLength: r.bytes,
      request: {
        url: r.url,
        method: r.method,
        headers: { "content-type": "application/json" },
        postData: r.reqBody,
      },
      response: {
        status: r.status,
        statusText: r.statusText,
        headers: { "content-type": "application/json" },
        mimeType: "application/json",
        body: r.resBody,
      },
    }),
  };
}

function workspaceData(world: World) {
  return {
    is_react_native: world.app.isReactNative,
    is_native_ios: !world.app.isReactNative && world.platform === "ios",
    is_native_android: !world.app.isReactNative && world.platform === "android",
    platforms: world.app.platforms,
    metro_port: world.app.metroPort ?? null,
    bundle_id: world.app.bundleId,
    start_command: world.app.isReactNative ? "npx react-native start" : null,
  };
}

// ---- flow recording / replay ----

function flowStart(world: World, args: ToolArgs): ToolResult {
  world.flowRecording = {
    name: String(args.name ?? "flow"),
    projectRoot: String(args.project_root ?? "/Users/dev/app"),
    prereq: String(args.executionPrerequisite ?? ""),
    steps: [],
  };
  return { content: json({ recording: true, name: world.flowRecording.name }) };
}

function flowAddEcho(world: World, args: ToolArgs): ToolResult {
  if (!world.flowRecording) throw new GymError("no active recording");
  world.flowRecording.steps.push({ kind: "echo", message: String(args.message ?? "") });
  return { content: json({ added: "echo" }) };
}

function flowAddStep(world: World, args: ToolArgs): ToolResult {
  if (!world.flowRecording) throw new GymError("no active recording");
  const command = String(args.command ?? "");
  const parsed =
    typeof args.args === "string" ? safeParse(args.args) : ((args.args as ToolArgs) ?? {});
  // The step runs immediately during recording.
  const r = execute(world, command, parsed);
  world.flowRecording.steps.push({ kind: "tool", name: command, args: parsed });
  return { content: json({ added: command, result: JSON.parse(stripScreenshotNote(r.content)) }) };
}

function flowFinish(world: World): ToolResult {
  if (!world.flowRecording) throw new GymError("no active recording");
  const f = world.flowRecording;
  world.flowsOnDisk[f.name] = { prereq: f.prereq, steps: f.steps };
  const path = `${f.projectRoot}/.argent/flows/${f.name}.yaml`;
  const summary = `${f.steps.length} steps (${f.steps.filter((s) => s.kind === "tool").length} tool, ${f.steps.filter((s) => s.kind === "echo").length} echo)`;
  world.flowRecording = undefined;
  return { content: json({ saved: path, summary }) };
}

function flowReadPrereq(world: World, args: ToolArgs): ToolResult {
  const name = String(args.name ?? "");
  const f = world.flowsOnDisk[name];
  return { content: json({ executionPrerequisite: f?.prereq ?? "" }) };
}

function flowExecute(world: World, args: ToolArgs): ToolResult {
  const name = String(args.name ?? "");
  const f = world.flowsOnDisk[name];
  if (!f) return { content: json({ error: `flow '${name}' not found` }), isError: true };
  if (f.prereq && args.prerequisiteAcknowledged !== true) {
    return {
      content: json({
        notice: `This flow requires: "${f.prereq}". Verify it is met, then call flow-execute again with prerequisiteAcknowledged: true.`,
      }),
    };
  }
  const steps: unknown[] = [];
  for (const s of f.steps) {
    if (s.kind === "echo") {
      steps.push({ kind: "echo", message: s.message });
    } else {
      const r = execute(world, s.name!, s.args ?? {});
      steps.push({
        kind: "tool",
        tool: s.name,
        result: JSON.parse(stripScreenshotNote(r.content)),
      });
    }
  }
  tick(world, 1000);
  return { content: json({ executed: name, steps }) + screenshotNote(world), autoScreenshot: true };
}

// ---- profiler reports (markdown) ----

function reactAnalyzeReport(world: World): string {
  const screen = cap(currentScreenDef(world).key);
  return `# React Profiler Report

## Hot commits (≥16ms)
| # | duration | trigger | root cause |
|---|----------|---------|------------|
| 1 | 41.2ms | scroll | \`${screen}List\` re-renders every row on each scroll frame |
| 2 | 22.8ms | state  | inline \`() => {}\` prop on \`${screen}Row\` breaks memoization |

## Top components by render time
- \`${screen}Row\` — 31 renders, 18.4ms total (normalizedRenderCount: 24)
- \`${screen}List\` — 6 renders, 12.1ms total

## Hint
Wrap \`${screen}Row\` in React.memo and hoist the row press handler. Re-profile to confirm.`;
}

function nativeAnalyzeReport(world: World): string {
  return `# Native Profiler Report (${world.platform})

## CPU hotspots (main thread)
- \`-[RCTImageLoader loadImage:]\` — 14.2% self time
- JSON deserialization in bridge — 9.7%

## UI hangs
- 1 hang of 312ms during list scroll (frame budget exceeded ~19×)

## Memory
- No leaks detected in the captured window.`;
}

function combinedReport(world: World): string {
  return `# Combined Report (React + Native, wall-clock aligned)

A 312ms native UI hang at +4.2s overlaps React commit #1 (41.2ms JS) — the
native image decode is the dominant cost; the JS re-render is secondary.

**Recommendation:** downsize/cache list thumbnails first; memoize rows second.`;
}

// ---- profiler drill-down + inspection transitions ----

function reactRendersReport(world: World): string {
  const s = cap(currentScreenDef(world).key);
  return `# Renders (top components)
| component | renders | total ms | normalizedRenderCount |
|-----------|---------|----------|-----------------------|
| ${s}Row | 31 | 18.4 | 24 |
| ${s}List | 6 | 12.1 | 6 |
| PriceLabel | 31 | 3.2 | 9 |`;
}

function reactCpuSummary(world: World): string {
  return `# CPU summary (JS thread)
- Reconciliation: 41%
- Commit/layout: 22%
- App code (handlers): 19%
- Other: 18%`;
}

function fiberTree(world: World): string {
  const els = currentVisible(world);
  const lines = [`Fiber tree (${currentScreenDef(world).title})`];
  for (const e of els) lines.push(`  ${e.component ?? "View"}${e.label ? ` "${e.label}"` : ""}`);
  return lines.join("\n");
}

function componentSource(world: World, args: ToolArgs): string {
  const name = String(args.component_name ?? "Component");
  return json({
    component: name,
    source: `src/components/${name}.tsx:1`,
    code: `export const ${name} = ({ item }) => {\n  return <Pressable onPress={() => onPress(item.id)}>...</Pressable>;\n};`,
  });
}

function cpuQuery(world: World, args: ToolArgs): string {
  return `# CPU query (mode: ${String(args.mode ?? "hotspots")})
- \`RCTImageLoader.loadImage\` — 14.2% self
- \`JSON.parse\` (bridge) — 9.7% self
- \`${cap(currentScreenDef(world).key)}Row.render\` — 7.1% self`;
}

function commitQuery(world: World, args: ToolArgs): string {
  return `# Commit query (mode: ${String(args.mode ?? "hot")})
Commit #1 — 41.2ms — 32 fibers re-rendered — trigger: scroll`;
}

function logRegistry(world: World): string {
  return json({
    file: `/tmp/argent/logs/${world.deviceId}.log`,
    totalEntries: 1284,
    byLevel: { log: 1102, warn: 156, error: 26 },
    clusters: [
      { pattern: "VirtualizedList: missing keys", count: 48, level: "warn" },
      { pattern: "Failed prop type", count: 12, level: "error" },
    ],
  });
}

function nativeDescribe(world: World) {
  const px = SCREEN_PX[world.platform];
  return {
    status: "ok",
    screenFrame: { x: 0, y: 0, width: px.w, height: px.h },
    elements: currentVisible(world).map((e) => ({
      normalizedFrame: {
        x: round3(e.frame.x),
        y: round3(e.frame.y),
        width: round3(e.frame.w),
        height: round3(e.frame.h),
      },
      normalizedTapPoint: {
        x: round3(e.frame.x + e.frame.w / 2),
        y: round3(e.frame.y + e.frame.h / 2),
      },
      traits: traitsFor(e.role),
      label: e.label,
      identifier: e.identifier,
      viewClassName:
        e.role === "button" ? "UIButton" : e.role === "field" ? "UITextField" : "UIView",
    })),
  };
}

function traitsFor(role: string): string[] {
  switch (role) {
    case "button":
    case "tab":
      return ["button"];
    case "heading":
      return ["header", "staticText"];
    case "text":
      return ["staticText"];
    case "image":
      return ["image"];
    case "link":
      return ["link"];
    case "field":
      return ["searchField"];
    case "switch":
      return ["button", "adjustable"];
    default:
      return [];
  }
}

function chromiumTabs(world: World, args: ToolArgs): ToolResult {
  const action = String(args.action ?? "list");
  if (action === "new") {
    const url = String(args.url ?? "about:blank");
    const target = world.app.urls?.[url];
    if (target) {
      world.navStack.push(world.currentScreen);
      world.currentScreen = target;
    }
    return {
      content:
        json({ opened: true, tabId: "t" + (world.clock % 97), url, active: true }) +
        screenshotNote(world),
      autoScreenshot: true,
    };
  }
  return {
    content: json({
      tabs: [
        {
          tabId: "t1",
          title: world.app.name,
          url: Object.keys(world.app.urls ?? { x: "" })[0],
          active: true,
        },
        { tabId: "t2", title: "Docs", url: "https://docs.example.com", active: false },
      ],
    }),
  };
}

// ---- small helpers ----

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
