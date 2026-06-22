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
import type { ElementDef, FlowStep, ScreenDef, World } from "./types.ts";

const BASE_EPOCH = 1_750_000_000_000;

// Tools that declare an `outputHint` on their ToolDefinition (the only one today
// is screenshot). flow-execute echoes it back on each tool step; everything else
// resolves to undefined and is dropped from the JSON.
const OUTPUT_HINTS: Record<string, string | undefined> = { screenshot: "image" };

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

// Synthetic project root used by tools that report a workspace path.
const PROJECT_ROOT = "/Users/dev/app";

/** The display name of the device the task is operating on. */
function deviceName(world: World): string {
  return world.devices.find((d) => d.id === world.deviceId)?.name ?? world.deviceId;
}

/**
 * The serialized form of an Argent artifact handle — the keys that survive
 * JSON.stringify when a tool returns a file via the registry's ArtifactHandle
 * (packages/registry/src/artifacts.ts). The `__argentArtifact` marker is a real
 * wire key, not a Symbol, so it is part of the ground-truth shape.
 */
function artifact(
  world: World,
  filename: string,
  mimeType: string,
  size: number,
  extra?: { archive?: "tar.gz" }
): Record<string, unknown> {
  return {
    __argentArtifact: true,
    id: `art-${world.clock}-${filename}`,
    filename,
    mimeType,
    size,
    hostPath: `/tmp/argent/artifacts/${filename}`,
    mtimeMs: BASE_EPOCH + world.clock,
    ...(extra?.archive ? { archive: extra.archive } : {}),
  };
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
      return debuggerEvaluate(world, args);

    case "debugger-inspect-element":
      return inspectElement(world, args);

    case "debugger-reload-metro":
      return debuggerReloadMetro(world);

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
          started_at: new Date(world.reactProfileStartMs).toISOString(),
          startedAtEpochMs: world.reactProfileStartMs,
          hermes_version: "0.12.0",
          detected_architecture: "new",
        }),
      };

    case "native-profiler-start": {
      world.nativeProfiling = true;
      tick(world, 200);
      return {
        content: json({
          status: "recording",
          pid: 48213,
          traceFile: `/tmp/argent/profiler/${world.deviceId}.trace`,
        }),
      };
    }

    case "react-profiler-stop": {
      world.reactProfiling = false;
      const cap = tick(world, 100) - (world.reactProfileStartMs ?? BASE_EPOCH);
      return {
        content: json({
          duration_ms: cap,
          sample_count: 1840,
          fiber_renders_captured: 38,
          total_react_commits: 12,
          hot_commit_indices: [0, 4],
          any_compiler_optimized: false,
          fiber_renders_analyzed: 38,
          selection_note: "2 of 12 commits at ≥16ms absolute floor",
        }),
      };
    }

    case "native-profiler-stop":
      world.nativeProfiling = false;
      return {
        content: json({
          traceFile: artifact(world, "capture.trace", "application/octet-stream", 4_812_544, {
            archive: "tar.gz",
          }),
          exportedFiles: {
            cpu: artifact(world, "cpu.json", "application/json", 182_344),
            hangs: artifact(world, "hangs.json", "application/json", 9_204),
          },
          // iOS stop always carries export diagnostics (ExportDiagnostics).
          exportDiagnostics: {
            tocSchemas: ["time-profile", "kdebug"],
            cpuSchemaUsed: "time-profile",
            errors: {},
          },
        }),
      };

    case "react-profiler-analyze":
      return { content: reactAnalyze(world) };

    case "native-profiler-analyze":
      return { content: nativeAnalyze(world) };

    case "profiler-combined-report":
      return { content: combinedReport(world) };

    case "react-profiler-status":
      return {
        content: json({
          hook_exists: true,
          renderer_interface_found: true,
          is_running: world.reactProfiling,
          current_session_id: world.reactProfiling ? `sess_${world.reactProfileStartMs}` : null,
          // Real current_owner is a ProfilerSessionOwner, not a pid/device pair.
          current_owner: world.reactProfiling
            ? {
                sessionId: `sess_${world.reactProfileStartMs}`,
                startedAtEpochMs: world.reactProfileStartMs ?? BASE_EPOCH,
                lastHeartbeatEpochMs: BASE_EPOCH + world.clock,
              }
            : null,
          session_status: world.reactProfiling ? "active" : "stopped",
          note: world.reactProfiling
            ? "A profiling session is currently recording."
            : "No active profiling session.",
        }),
      };

    case "react-profiler-renders":
      return { content: reactRendersReport(world) };

    case "react-profiler-cpu-summary":
      return { content: reactCpuSummary(world) };

    case "react-profiler-fiber-tree":
      return { content: json(fiberTree(world)) };

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
      tick(world, 1000);
      return {
        content:
          json({ orientation: String(args.orientation ?? "Portrait") }) + screenshotNote(world),
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
      return { content: json({ stopped: [`simulator-server:${world.deviceId}`] }) };

    case "stop-simulator-server":
      world.simServerRunning = false;
      return { content: json({ stopped: true, udid: world.deviceId }) };

    case "stop-metro":
      world.metroRunning = false;
      return { content: json({ stopped: true, port: world.app.metroPort ?? 8081, pids: [40217] }) };

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
          runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-2",
        };
      }
      if (d.platform === "android") {
        return {
          platform: "android",
          serial: d.id,
          state: d.booted ? "device" : "offline",
          isEmulator: true,
          kind: "emulator",
          model: d.name,
          avdName: d.avdName ?? null,
          sdkLevel: d.sdkLevel ?? null,
        };
      }
      return {
        platform: "chromium",
        id: d.id,
        port: d.port,
        title: world.app.name,
        url: Object.keys(world.app.urls ?? { "about:blank": "" })[0] ?? "about:blank",
        browser: "Chrome/124.0.0.0",
        state: "Running",
      };
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
  return {
    content: json({
      platform: "chromium",
      id: dev.id,
      port: dev.port,
      pid: 48201,
      appPath: world.app.bundleId,
      booted: true,
    }),
  };
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
      port: world.app.metroPort ?? 8081,
      projectRoot: PROJECT_ROOT,
      deviceName: deviceName(world),
      appName: world.app.name,
      logicalDeviceId: world.deviceId,
      isNewDebugger: false,
      connected: true,
      loadedScripts: 412,
      enabledDomains: ["Runtime", "Debugger", "Network"],
      sourceMapReady: true,
    }),
  };
}

function debuggerConnect(world: World): ToolResult {
  world.metroRunning = true;
  world.debuggerConnected = true;
  return {
    content: json({
      port: world.app.metroPort ?? 8081,
      projectRoot: PROJECT_ROOT,
      deviceName: deviceName(world),
      appName: world.app.name,
      logicalDeviceId: world.deviceId,
      isNewDebugger: false,
      connected: true,
    }),
  };
}

function debuggerReloadMetro(world: World): ToolResult {
  tick(world, 1200);
  return {
    content: json({
      reloaded: true,
      port: world.app.metroPort ?? 8081,
      method: "cdp",
      deviceName: deviceName(world),
      appName: world.app.name,
      logicalDeviceId: world.deviceId,
    }),
  };
}

function debuggerEvaluate(world: World, args: ToolArgs): ToolResult {
  const device = world.devices.find((d) => d.id === world.deviceId);
  // Real debugger-evaluate returns the value under `result`, plus device/app context.
  return {
    content: json({
      result: evalExpr(world, String(args.expression ?? "")),
      deviceName: device?.name ?? world.deviceId,
      appName: world.app.name,
      logicalDeviceId: world.deviceId,
    }),
  };
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
  const x = Number(args.x ?? 0.5);
  const y = Number(args.y ?? 0.5);
  const el = elementAt(world, x, y);
  const compName = el?.component ?? `${cap(screen.key)}Row`;
  const file = `src/screens/${cap(screen.key)}Screen.tsx`;
  const line = 24 + (screen.elements.length % 30);
  return {
    content: json({
      x,
      y,
      items: [
        {
          name: compName,
          source: { file, line, column: 4 },
          code: `<Pressable onPress={handlePress} testID="${el?.identifier ?? screen.elements[0]?.identifier ?? "el"}">`,
        },
      ],
      deviceName: deviceName(world),
      appName: world.app.name,
      logicalDeviceId: world.deviceId,
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
  const key = args.key != null ? String(args.key) : undefined;
  const focus = getFocus(world);
  if (text && focus) world.fieldValues[focus] = text;
  tick(world, 300);
  // Mirror the real keyboard tool: { typed, keys } where `keys` is the number of
  // key presses (one per code point of `text`, plus one for a named `key`).
  const keys = (key ? 1 : 0) + (text ? [...text].length : 0);
  return {
    content: json({ typed: text ?? key ?? "", keys }) + screenshotNote(world),
    autoScreenshot: true,
  };
}

function pressButton(world: World, args: ToolArgs): ToolResult {
  const button = String(args.button ?? "");
  if ((button === "back" || button === "home") && world.navStack.length) {
    world.currentScreen = world.navStack.pop()!;
  }
  tick(world, 1500);
  // Real button tool returns just { pressed: <buttonName> }.
  return {
    content: json({ pressed: button }) + screenshotNote(world),
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
  // The real tool always returns { image: ArtifactHandle }; the flag only
  // controls whether the image bytes are attached to context (the note).
  const content = json({
    image: artifact(world, `shot-${world.clock}.png`, "image/png", 184_320),
  });
  if (!include) {
    return { content };
  }
  return { content: content + screenshotNote(world) };
}

function screenshotDiff(world: World, args: ToolArgs): ToolResult {
  return {
    content: json({
      summary: "1.2% of pixels changed (1843 of 152064), localized to the region under test.",
      diffPath: artifact(world, `diff-${world.clock}.png`, "image/png", 96_240),
      contextDiffPath: artifact(world, `diff-context-${world.clock}.png`, "image/png", 142_880),
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
  // Mirrors the WorkspaceSnapshot returned by workspace-reader.ts. The derived
  // booleans (is_react_native, etc.) the gym used to emit live downstream, not
  // on the snapshot — only the raw filesystem/config facts belong here.
  const rn = world.app.isReactNative;
  const hasIos = world.app.platforms.includes("ios");
  const hasAndroid = world.app.platforms.includes("android");
  return {
    workspace_path: PROJECT_ROOT,
    package_json: {
      name: world.app.id,
      dependencies: rn ? { "react-native": "0.81.0", "react": "19.0.0" } : {},
    } as Record<string, unknown>,
    metro_config_raw: rn ? "module.exports = { transformer: {} };" : null,
    app_json: null,
    eas_json: null,
    tsconfig: { compilerOptions: { strict: true } } as Record<string, unknown>,
    babel_config_raw: rn
      ? "module.exports = { presets: ['module:metro-react-native-babel-preset'] };"
      : null,
    metro_port: world.app.metroPort ?? null,
    has_ios_dir: hasIos,
    has_android_dir: hasAndroid,
    ios_workspace: hasIos ? `ios/${cap(world.app.id)}.xcworkspace` : null,
    ios_has_podfile: hasIos,
    android_has_gradle: hasAndroid,
    lockfile: "package-lock.json" as const,
    env_files: [] as unknown[],
    tool_versions: { "node": "20.11.0", "react-native": rn ? "0.81.0" : null } as Record<
      string,
      string | null
    >,
    scripts_dir_entries: null,
    husky_hooks: null,
    ci_config: null,
    makefile_targets: null,
    lint_staged_config: null,
    config_files_found: rn
      ? ["package.json", "metro.config.js", "babel.config.js", "tsconfig.json"]
      : ["package.json", "tsconfig.json"],
  };
}

// ---- flow recording / replay ----

function flowPath(world: World, name: string): string {
  return `${world.flowRecording?.projectRoot ?? PROJECT_ROOT}/.argent/flows/${name}.flow.yaml`;
}

function flowStart(world: World, args: ToolArgs): ToolResult {
  world.flowRecording = {
    name: String(args.name ?? "flow"),
    projectRoot: String(args.project_root ?? PROJECT_ROOT),
    prereq: String(args.executionPrerequisite ?? ""),
    steps: [],
  };
  const path = flowPath(world, world.flowRecording.name);
  return {
    content: json({
      message: `Started recording "${world.flowRecording.name}" flow. Subsequent tool calls will be appended.`,
      flowFile: `name: ${world.flowRecording.name}\nsteps: []\n`,
      savedTo: path,
    }),
  };
}

function flowAddEcho(world: World, args: ToolArgs): ToolResult {
  if (!world.flowRecording) throw new GymError("no active recording");
  const message = String(args.message ?? "");
  world.flowRecording.steps.push({ kind: "echo", message });
  return {
    content: json({
      message: `Added echo step to "${world.flowRecording.name}".`,
      flowFile: serializeFlow(world.flowRecording),
      savedTo: flowPath(world, world.flowRecording.name),
    }),
  };
}

function flowAddStep(world: World, args: ToolArgs): ToolResult {
  if (!world.flowRecording) throw new GymError("no active recording");
  const command = String(args.command ?? "");
  const parsed =
    typeof args.args === "string" ? safeParse(args.args) : ((args.args as ToolArgs) ?? {});
  // The step runs immediately during recording.
  const r = execute(world, command, parsed);
  world.flowRecording.steps.push({ kind: "tool", name: command, args: parsed });
  return {
    content: json({
      message: `Recorded ${command} step in "${world.flowRecording.name}".`,
      toolResult: JSON.parse(stripScreenshotNote(r.content)),
      flowFile: serializeFlow(world.flowRecording),
      savedTo: flowPath(world, world.flowRecording.name),
    }),
  };
}

function flowFinish(world: World): ToolResult {
  if (!world.flowRecording) throw new GymError("no active recording");
  const f = world.flowRecording;
  world.flowsOnDisk[f.name] = { prereq: f.prereq, steps: f.steps };
  const path = flowPath(world, f.name);
  const summary = f.steps.map((s, i) =>
    s.kind === "echo"
      ? `${i + 1}. echo: ${s.message}`
      : `${i + 1}. tool: ${s.name} ${JSON.stringify(s.args ?? {})}`
  );
  const flowFile = serializeFlow(f);
  const result = {
    message: `Finished recording "${f.name}" flow (${f.steps.length} steps)`,
    path,
    executionPrerequisite: f.prereq,
    steps: f.steps.length,
    summary,
    flowFile,
    savedTo: path,
  };
  world.flowRecording = undefined;
  return { content: json(result) };
}

function flowReadPrereq(world: World, args: ToolArgs): ToolResult {
  const name = String(args.name ?? "");
  const f = world.flowsOnDisk[name];
  return { content: json({ flow: name, executionPrerequisite: f?.prereq ?? "" }) };
}

function flowExecute(world: World, args: ToolArgs): ToolResult {
  const name = String(args.name ?? "");
  const f = world.flowsOnDisk[name];
  if (!f) return { content: json({ error: `flow '${name}' not found` }), isError: true };
  if (f.prereq && args.prerequisiteAcknowledged !== true) {
    return {
      content: json({
        flow: name,
        notice: `This flow requires: "${f.prereq}". Verify it is met, then call flow-execute again with prerequisiteAcknowledged: true.`,
        executionPrerequisite: f.prereq,
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
        // Real flow-run attaches the tool's outputHint (undefined for most tools
        // -> dropped by JSON.stringify) and always the step's args.
        outputHint: OUTPUT_HINTS[s.name!],
        args: s.args ?? {},
      });
    }
  }
  tick(world, 1000);
  return {
    content: json({ flow: name, executionPrerequisite: f.prereq, steps }) + screenshotNote(world),
    autoScreenshot: true,
  };
}

/** Render a recording as the YAML-ish flow file body the real serializer emits. */
function serializeFlow(f: { name: string; steps: FlowStep[] }): string {
  const lines = [`name: ${f.name}`, "steps:"];
  for (const s of f.steps) {
    if (s.kind === "echo") {
      lines.push(`  - echo: ${s.message}`);
    } else {
      lines.push(`  - tool: ${s.name}`, `    args: ${JSON.stringify(s.args ?? {})}`);
    }
  }
  return lines.join("\n") + "\n";
}

// ---- profiler reports (JSON envelopes wrapping a markdown report) ----

// react-profiler-analyze returns a JSON object whose `report` is the markdown.
function reactAnalyze(world: World): string {
  return json({
    report: reactAnalyzeReport(world),
    reportFile: artifact(world, "react-profile-report.md", "text/markdown", 2_148),
    hotCommitsTotal: 2,
    hotCommitsShown: 2,
    sessionFiles: {
      sessionId: `sess_${world.reactProfileStartMs ?? BASE_EPOCH}`,
      cpuProfile: artifact(world, "cpu.cpuprofile", "application/json", 412_880),
      commits: artifact(world, "commits.json", "application/json", 38_204),
    },
  });
}

// native-profiler-analyze returns a JSON object whose `report` is the markdown.
function nativeAnalyze(world: World): string {
  return json({
    report: nativeAnalyzeReport(world),
    reportFile: artifact(world, "native-profile-report.md", "text/markdown", 1_624),
    bottlenecksTotal: 3,
    status: "ok",
    exportErrors: {} as Record<string, string>,
  });
}

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

interface FiberNode {
  name: string;
  tag: number;
  actualDuration: number;
  selfBaseDuration: number;
  children: FiberNode[];
}

// react-profiler-fiber-tree returns parsed JSON: an array of nested fiber nodes
// (the real tool returns { tree: null, message } only when nothing was committed).
function fiberTree(world: World): FiberNode[] | { tree: null; message: string } {
  const els = currentVisible(world);
  const screen = cap(currentScreenDef(world).key);
  const children: FiberNode[] = els.map((e, i) => ({
    name: e.component ?? "View",
    tag: e.role === "text" || e.role === "heading" ? 6 : 5,
    actualDuration: round2(0.8 + (i % 4) * 0.35),
    selfBaseDuration: round2(0.4 + (i % 3) * 0.2),
    children: [],
  }));
  return [
    {
      name: `${screen}Screen`,
      tag: 1,
      actualDuration: round2(12.1),
      selfBaseDuration: round2(2.3),
      children,
    },
  ];
}

function componentSource(world: World, args: ToolArgs): string {
  const name = String(args.component_name ?? "Component");
  return json({
    found: true,
    component: name,
    file: `src/components/${name}.tsx`,
    line: 1,
    col: 0,
    isMemoized: false,
    hasUseCallback: false,
    hasUseMemo: false,
    source: `export const ${name} = ({ item }) => {\n  return <Pressable onPress={() => onPress(item.id)}>...</Pressable>;\n};`,
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
    fileSizeBytes: 248_512,
    clusters: [
      {
        message: "VirtualizedList: missing keys",
        count: 48,
        level: "warn",
        firstId: 12,
        lastId: 1240,
      },
      { message: "Failed prop type", count: 12, level: "error", firstId: 88, lastId: 1101 },
    ],
    deviceName: deviceName(world),
    appName: world.app.name,
    logicalDeviceId: world.deviceId,
  });
}

function nativeDescribe(world: World) {
  const px = SCREEN_PX[world.platform];
  return {
    status: "ok",
    screenFrame: { x: 0, y: 0, width: px.w, height: px.h },
    elements: currentVisible(world).map((e) => ({
      frame: {
        x: Math.round(e.frame.x * px.w),
        y: Math.round(e.frame.y * px.h),
        width: Math.round(e.frame.w * px.w),
        height: Math.round(e.frame.h * px.h),
      },
      tapPoint: {
        x: Math.round((e.frame.x + e.frame.w / 2) * px.w),
        y: Math.round((e.frame.y + e.frame.h / 2) * px.h),
      },
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
  const firstUrl = Object.keys(world.app.urls ?? { "about:blank": "" })[0] ?? "about:blank";
  if (action === "new") {
    const url = String(args.url ?? "about:blank");
    const target = world.app.urls?.[url];
    if (target) {
      world.navStack.push(world.currentScreen);
      world.currentScreen = target;
    }
    const newId = "t" + (3 + (world.clock % 97));
    // Every action returns the full tab list; the freshly opened tab is active.
    return {
      content:
        json({
          tabs: [
            {
              tabId: "t1",
              targetId: "TARGET-1",
              title: world.app.name,
              url: firstUrl,
              active: false,
            },
            {
              tabId: "t2",
              targetId: "TARGET-2",
              title: "Docs",
              url: "https://docs.example.com",
              active: false,
            },
            { tabId: newId, targetId: `TARGET-${newId}`, title: url, url, active: true },
          ],
        }) + screenshotNote(world),
      autoScreenshot: true,
    };
  }
  return {
    content: json({
      tabs: [
        { tabId: "t1", targetId: "TARGET-1", title: world.app.name, url: firstUrl, active: true },
        {
          tabId: "t2",
          targetId: "TARGET-2",
          title: "Docs",
          url: "https://docs.example.com",
          active: false,
        },
      ],
    }),
  };
}

// ---- small helpers ----

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
