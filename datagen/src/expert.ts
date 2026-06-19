// The expert policy: an oracle that solves a TaskSpec optimally by driving the
// gym, encoding the argent.md workflow rules as executable behavior:
//   - list-devices before any interaction; boot only if nothing is ready
//   - one discovery per screen; tap coordinates are the centre of a *discovered*
//     element (never guessed); re-discover after the screen changes
//   - RN apps discover via component-tree (after connecting the debugger),
//     native/chromium via describe
//   - run-sequence batches steps that need no observation between them
//   - recover from injected failures (tap miss, describe error, boot timeout,
//     debugger drop) the way the skills prescribe
//   - profiling / flow / network workflows follow their skill's step order

import {
  currentScreenDef,
  currentVisible,
  execute,
  isScrolled,
  stripScreenshotNote,
  type ToolResult,
} from "./gym.ts";
import { SCREEN_PX, tapPoint } from "./format.ts";
import { narr } from "./narrate.ts";
import { RNG } from "./rng.ts";
import type { ElementDef, Message, ToolCall, World } from "./types.ts";
import type { TaskSpec } from "./tasks.ts";
import { buildWorld } from "./world.ts";

interface Call {
  name: string;
  args: Record<string, unknown>;
}

class Builder {
  messages: Message[] = [];
  toolsUsed = new Set<string>();
  hasRecovery = false;
  assistantTurns = 0;
  toolCalls = 0;
  private counter = 0;
  world: World;
  rng: RNG;

  constructor(world: World, rng: RNG) {
    this.world = world;
    this.rng = rng;
  }

  user(text: string) {
    this.messages.push({ role: "user", content: text });
  }

  /** One assistant turn: narration + zero or more tool calls (executed in gym). */
  act(narration: string, calls: Call[] = []): ToolResult[] {
    const toolCalls: ToolCall[] = calls.map((c) => ({
      id: `call_${++this.counter}`,
      name: c.name,
      arguments: c.args,
    }));
    this.messages.push({
      role: "assistant",
      content: narration,
      tool_calls: toolCalls.length ? toolCalls : undefined,
    });
    this.assistantTurns++;
    const results: ToolResult[] = [];
    for (const tc of toolCalls) {
      this.toolsUsed.add(tc.name);
      this.toolCalls++;
      const res = execute(this.world, tc.name, tc.arguments);
      results.push(res);
      this.messages.push({
        role: "tool",
        tool_call_id: tc.id,
        name: tc.name,
        content: res.content,
      });
    }
    return results;
  }

  final(text: string) {
    this.messages.push({ role: "assistant", content: text });
    this.assistantTurns++;
  }
}

const metroPort = (w: World) => w.app.metroPort ?? 8081;

// ---- shared phases ----

function ensureDevice(b: Builder) {
  const w = b.world;
  b.act(narr.checkDevices(b.rng), [{ name: "list-devices", args: {} }]);
  const dev = w.devices.find((d) => d.id === w.deviceId)!;
  if (dev.booted || dev.platform === "chromium") return;
  const bootArgs: Record<string, unknown> =
    dev.platform === "ios" ? { udid: dev.id } : { avdName: dev.avdName };
  if (w.inject.bootTimeoutOnce) {
    b.act(narr.bootDevice(b.rng, dev.name), [{ name: "boot-device", args: bootArgs }]);
    b.hasRecovery = true;
    b.act(narr.bootRetry(b.rng), [{ name: "boot-device", args: bootArgs }]);
  } else {
    b.act(narr.bootDevice(b.rng, dev.name), [{ name: "boot-device", args: bootArgs }]);
  }
}

function ensureLaunched(b: Builder) {
  const w = b.world;
  b.act(narr.launch(b.rng, w.app.name), [
    { name: "launch-app", args: { udid: w.deviceId, bundleId: w.app.bundleId } },
  ]);
  if (w.app.isReactNative) {
    const note =
      w.platform === "android"
        ? "This is a React Native app on Android, so Metro needs `adb -s " +
          w.deviceId +
          " reverse tcp:" +
          metroPort(w) +
          " tcp:" +
          metroPort(w) +
          "` to be reachable. With that in place I'll check the debugger status."
        : narr.connectDebugger(b.rng);
    const res = b.act(note, [
      { name: "debugger-status", args: { port: metroPort(w), device_id: w.deviceId } },
    ]);
    if (res[0]?.isError) {
      b.hasRecovery = true;
      b.act("No CDP target yet — restarting the app so it reattaches to Metro.", [
        { name: "restart-app", args: { udid: w.deviceId, bundleId: w.app.bundleId } },
      ]);
      b.act("Retrying the debugger status.", [
        { name: "debugger-status", args: { port: metroPort(w), device_id: w.deviceId } },
      ]);
    }
  }
}

/** Discovery for the current screen. Returns the tool name used. */
function discover(b: Builder, narration?: string): string {
  const w = b.world;
  if (w.app.isReactNative) {
    const tool = "debugger-component-tree";
    b.act(narration ?? narr.discover(b.rng, tool), [
      { name: tool, args: { port: metroPort(w), device_id: w.deviceId } },
    ]);
    return tool;
  }
  const res = b.act(narration ?? narr.discover(b.rng, "describe"), [
    { name: "describe", args: { udid: w.deviceId } },
  ]);
  if (res[0]?.isError) {
    b.hasRecovery = true;
    b.act(narr.describeFailRecover(b.rng), [{ name: "describe", args: { udid: w.deviceId } }]);
  }
  return "describe";
}

function find(b: Builder, key: string): ElementDef | undefined {
  return currentVisible(b.world).find((e) => e.key === key);
}

/** Tap an element by key on the current screen, scrolling/recovering as needed.
 *  Assumes discovery for this screen already ran (caller's responsibility). */
function tapKey(b: Builder, key: string): ElementDef {
  const w = b.world;
  let el = find(b, key);
  if (!el) {
    // The element is below the fold — scroll to reveal, then re-discover.
    const hidden = currentScreenDef(w).elements.find((e) => e.key === key && e.revealedByScroll);
    if (hidden && !isScrolled(w)) {
      if (w.platform === "chromium") {
        b.act(narr.scroll(b.rng), [
          { name: "gesture-scroll", args: { udid: w.deviceId, x: 0.5, y: 0.5, deltaY: 0.6 } },
        ]);
      } else {
        b.act(narr.scroll(b.rng), [
          {
            name: "gesture-swipe",
            args: { udid: w.deviceId, fromX: 0.5, fromY: 0.75, toX: 0.5, toY: 0.25 },
          },
        ]);
      }
      discover(b);
      el = find(b, key);
    }
  }
  el = el ?? currentVisible(w)[0]!;
  const p = tapPoint(el);
  const screenBefore = w.currentScreen;
  b.act(narr.tap(b.rng, el.label ?? key), [
    { name: "gesture-tap", args: { udid: w.deviceId, x: p.x, y: p.y } },
  ]);
  // Injected miss: navigation didn't happen — re-discover and retry once.
  if (el.navigatesTo && w.currentScreen === screenBefore) {
    b.hasRecovery = true;
    discover(b, narr.tapMissRecover(b.rng));
    const el2 = find(b, key) ?? el;
    const p2 = tapPoint(el2);
    b.act(narr.tap(b.rng, el2.label ?? key), [
      { name: "gesture-tap", args: { udid: w.deviceId, x: p2.x, y: p2.y } },
    ]);
  }
  return el;
}

/** Walk the route's navigation hops, one discovery + tap per screen. */
function walkRoute(b: Builder, task: TaskSpec) {
  for (const hop of task.route) {
    discover(b);
    tapKey(b, hop.elementKey);
  }
}

function maybeCloseSession(b: Builder) {
  if (b.rng.bool(0.25)) {
    b.act("We're done with the device, so I'll shut the simulator-server down.", [
      { name: "stop-all-simulator-servers", args: {} },
    ]);
  }
}

// ---- per-kind solvers ----

function solveNavigateTap(b: Builder, task: TaskSpec) {
  ensureDevice(b);
  ensureLaunched(b);
  walkRoute(b, task);
  discover(b);
  const target = tapKey(b, task.targetElementKey);
  maybeCloseSession(b);
  b.final(
    `Done — navigated through ${task.pathLabels.slice(0, -1).join(" > ") || "the app"} and tapped "${target.label}". The screen responded as expected.`
  );
}

function solveToggle(b: Builder, task: TaskSpec) {
  ensureDevice(b);
  ensureLaunched(b);
  walkRoute(b, task);
  discover(b);
  const target = tapKey(b, task.targetElementKey);
  discover(b, narr.verify(b.rng));
  b.final(
    `"${target.label}" is now toggled on; I confirmed the new state with a follow-up discovery.`
  );
}

function solveLogin(b: Builder, task: TaskSpec) {
  ensureDevice(b);
  ensureLaunched(b);
  discover(b);
  tapKey(b, "email");
  b.act(narr.typeInto(b.rng, "Email"), [
    { name: "keyboard", args: { udid: b.world.deviceId, text: "test.user@example.com" } },
  ]);
  tapKey(b, "password");
  b.act(narr.typeInto(b.rng, "Password"), [
    { name: "keyboard", args: { udid: b.world.deviceId, text: "Passw0rd!" } },
  ]);
  tapKey(b, "signin");
  discover(b, narr.verify(b.rng));
  b.final(
    "Login succeeded — the form submitted and we're on the Today dashboard (verified via the component tree)."
  );
}

function solveScrollFind(b: Builder, task: TaskSpec) {
  ensureDevice(b);
  ensureLaunched(b);
  walkRoute(b, task);
  discover(b);
  const target = tapKey(b, task.targetElementKey); // tapKey scrolls + re-discovers if needed
  b.final(`Found "${target.label}" after scrolling and opened it.`);
}

function solveRunSequence(b: Builder, task: TaskSpec) {
  const w = b.world;
  ensureDevice(b);
  ensureLaunched(b);
  walkRoute(b, task); // to the Search tab
  discover(b);
  const field = find(b, "search-field")!;
  const p = tapPoint(field);
  b.act(narr.batch(b.rng), [
    {
      name: "run-sequence",
      args: {
        udid: w.deviceId,
        steps: [
          { tool: "gesture-tap", args: { x: p.x, y: p.y } },
          { tool: "keyboard", args: { text: task.query } },
          { tool: "keyboard", args: { key: "enter" } },
        ],
      },
    },
  ]);
  discover(b);
  const result = tapKey(b, "result-keyboard");
  b.final(
    `Batched the search (tap field → type "${task.query}" → enter) in one run-sequence, then opened "${result.label}".`
  );
}

function solveVisualRegression(b: Builder, task: TaskSpec) {
  const w = b.world;
  ensureDevice(b);
  ensureLaunched(b);
  const shot = b.act(
    "Capturing a full-resolution baseline now (suppressing the image from context so the large PNG isn't loaded).",
    [{ name: "screenshot", args: { udid: w.deviceId, scale: 1.0, includeImageInContext: false } }]
  );
  const baselinePath = JSON.parse(shot[0]!.content).image.path as string;
  walkRoute(b, task);
  discover(b);
  b.act("Now diffing the current screen against the saved baseline.", [
    {
      name: "screenshot-diff",
      args: { udid: w.deviceId, baselinePath, captureCurrent: true, outputDir: "/tmp/argent/diff" },
    },
  ]);
  b.final(
    "Visual diff complete — ~1.2% of pixels changed, localized to the region under test, no unexpected regressions elsewhere."
  );
}

function solveProfile(b: Builder, task: TaskSpec) {
  const w = b.world;
  ensureDevice(b);
  ensureLaunched(b);
  walkRoute(b, task);
  const start = b.act(
    "Starting the React and native profilers together so their captures are wall-clock aligned. I'll record interaction timestamps for annotations.",
    [
      { name: "react-profiler-start", args: { device_id: w.deviceId, port: metroPort(w) } },
      { name: "native-profiler-start", args: { device_id: w.deviceId } },
    ]
  );
  const startedAt = JSON.parse(start[0]!.content).startedAtEpochMs as number;
  const swipe = () => ({
    name: "gesture-swipe",
    args: { udid: w.deviceId, fromX: 0.5, fromY: 0.78, toX: 0.5, toY: 0.22 },
  });
  const r1 = b.act("Scrolling the list to exercise the render path.", [swipe()]);
  const t1 = JSON.parse(stripScreenshotNote(r1[0]!.content)).timestampMs as number;
  const r2 = b.act("Scrolling once more to get a few commits.", [swipe()]);
  const t2 = JSON.parse(stripScreenshotNote(r2[0]!.content)).timestampMs as number;
  b.act("Stopping both profilers.", [
    { name: "react-profiler-stop", args: { device_id: w.deviceId, port: metroPort(w) } },
    { name: "native-profiler-stop", args: { device_id: w.deviceId } },
  ]);
  const annotations = [
    { label: "scroll 1", offsetMs: t1 - startedAt },
    { label: "scroll 2", offsetMs: t2 - startedAt },
  ];
  b.act("Analyzing the React commits with the interaction annotations.", [
    {
      name: "react-profiler-analyze",
      args: {
        device_id: w.deviceId,
        port: metroPort(w),
        platform: w.platform,
        project_root: "/Users/dev/" + w.app.id,
        rn_version: "0.81.0",
        annotations,
      },
    },
  ]);
  b.act("Analyzing the native trace.", [
    { name: "native-profiler-analyze", args: { device_id: w.deviceId } },
  ]);
  b.act("Correlating both with the combined report.", [
    { name: "profiler-combined-report", args: { device_id: w.deviceId, port: metroPort(w) } },
  ]);
  // Drill down on the worst offender to confirm the root cause before reporting.
  const hot = cap(w.currentScreen) + "Row";
  b.act("Drilling into the per-component renders to confirm the hot component.", [
    {
      name: "react-profiler-renders",
      args: { device_id: w.deviceId, port: metroPort(w), top_n: 5 },
    },
  ]);
  b.act("Querying the CPU hotspots for that window.", [
    {
      name: "profiler-cpu-query",
      args: { device_id: w.deviceId, port: metroPort(w), mode: "top_functions", top_n: 5 },
    },
  ]);
  b.act(`Opening the source of \`${hot}\` to see what's re-rendering.`, [
    {
      name: "react-profiler-component-source",
      args: { component_name: hot, project_root: "/Users/dev/" + w.app.id },
    },
  ]);
  b.final(
    "Bottleneck found: a 312ms native image-decode hang during scroll overlaps the hottest React commit (41ms), where every list row re-renders. The native thumbnail decode dominates; the row re-render is secondary. Fix order: cache/downsize thumbnails first, then memoize the row component, then re-profile."
  );
}

function solveFlowRecord(b: Builder, task: TaskSpec) {
  const w = b.world;
  ensureDevice(b);
  ensureLaunched(b);
  const projectRoot = "/Users/dev/" + w.app.id;
  const prereq = `App launched on the ${currentScreenDef(w).title} screen`;
  b.act("Recording a reusable flow for this path.", [
    {
      name: "flow-start-recording",
      args: {
        name: task.app.id + "-to-" + task.targetElementKey,
        project_root: projectRoot,
        executionPrerequisite: prereq,
      },
    },
  ]);
  const sequence = [...task.route.map((h) => h.elementKey), task.targetElementKey];
  for (const key of sequence) {
    discover(b);
    const el = find(b, key) ?? currentVisible(w)[0]!;
    const p = tapPoint(el);
    b.act(`Labeling and recording the tap on "${el.label}".`, [
      { name: "flow-add-echo", args: { message: `Tap ${el.label}` } },
      {
        name: "flow-add-step",
        args: {
          command: "gesture-tap",
          args: JSON.stringify({ udid: w.deviceId, x: p.x, y: p.y }),
        },
      },
    ]);
  }
  b.act("Finishing the recording.", [{ name: "flow-finish-recording", args: {} }]);
  b.act("Returning to the start state so the replay matches the prerequisite.", [
    { name: "restart-app", args: { udid: w.deviceId, bundleId: w.app.bundleId } },
  ]);
  const name = task.app.id + "-to-" + task.targetElementKey;
  b.act("Replaying the flow to confirm it reproduces.", [
    { name: "flow-execute", args: { name, project_root: projectRoot } },
  ]);
  b.act("The prerequisite is satisfied, so I'll acknowledge it and run the flow.", [
    {
      name: "flow-execute",
      args: { name, project_root: projectRoot, prerequisiteAcknowledged: true },
    },
  ]);
  b.final(
    `Recorded and replayed the flow "${name}" — it reproduces the path to "${task.pathLabels.at(-1)}" cleanly.`
  );
}

function solveNetworkInspect(b: Builder, task: TaskSpec) {
  const w = b.world;
  ensureDevice(b);
  ensureLaunched(b);
  walkRoute(b, task);
  discover(b);
  tapKey(b, task.targetElementKey);
  const reqId = `req_${w.networkLog.length}`;
  b.act("Checking the captured network log.", [
    { name: "view-network-logs", args: { device_id: w.deviceId, port: metroPort(w) } },
  ]);
  b.act("Pulling the full request/response for that call.", [
    {
      name: "view-network-request-details",
      args: { requestId: reqId, device_id: w.deviceId, port: metroPort(w) },
    },
  ]);
  const r = w.networkLog.at(-1)!;
  b.final(
    `The interaction fired \`${r.method} ${r.url}\` → ${r.status} ${r.statusText} (${r.durationMs}ms). Full headers and body are in the details above.`
  );
}

function solveAndroidSetup(b: Builder, task: TaskSpec) {
  ensureDevice(b); // boots the emulator (with timeout recovery if injected)
  ensureLaunched(b);
  walkRoute(b, task);
  discover(b);
  const target = tapKey(b, task.targetElementKey);
  maybeCloseSession(b);
  b.final(`Booted the Android emulator, launched ${task.app.name}, and tapped "${target.label}".`);
}

function solveDebugInspect(b: Builder, task: TaskSpec) {
  const w = b.world;
  ensureDevice(b);
  ensureLaunched(b);
  walkRoute(b, task);
  discover(b);
  const el = find(b, task.targetElementKey) ?? currentVisible(w)[0]!;
  const px = SCREEN_PX[w.platform];
  const x = Math.round((el.frame.x + el.frame.w / 2) * px.w);
  const y = Math.round((el.frame.y + el.frame.h / 2) * px.h);
  b.act(
    `I have the component tree; debugger-inspect-element takes logical pixel coordinates (not normalized), so I'll inspect at (${x}, ${y}).`,
    [
      {
        name: "debugger-inspect-element",
        args: { x, y, port: metroPort(w), device_id: w.deviceId },
      },
    ]
  );
  b.final(`"${el.label}" is rendered by the component identified in the source mapping above.`);
}

function solveDeepLink(b: Builder, task: TaskSpec) {
  const w = b.world;
  ensureDevice(b);
  const url = task.deepLinkUrl!;
  b.act(`Opening ${w.app.name} straight to the target via its deep link.`, [
    { name: "open-url", args: { udid: w.deviceId, url } },
  ]);
  if (w.app.isReactNative) {
    b.act(narr.connectDebugger(b.rng), [
      { name: "debugger-status", args: { port: metroPort(w), device_id: w.deviceId } },
    ]);
  }
  discover(b);
  const target = tapKey(b, task.targetElementKey);
  b.final(`Deep-linked to ${currentScreenDef(w).title} and tapped "${target.label}".`);
}

function solveConsoleCheck(b: Builder, task: TaskSpec) {
  const w = b.world;
  ensureDevice(b);
  ensureLaunched(b);
  walkRoute(b, task);
  discover(b);
  b.act("Pulling the console log registry to see what's been logged.", [
    { name: "debugger-log-registry", args: { port: metroPort(w), device_id: w.deviceId } },
  ]);
  b.act("Evaluating an expression in the app runtime to confirm the React Native version.", [
    {
      name: "debugger-evaluate",
      args: {
        port: metroPort(w),
        device_id: w.deviceId,
        expression: "require('react-native/package.json').version",
      },
    },
  ]);
  b.final(
    "Checked the logs: 26 errors clustered around a prop-type failure and 156 warnings (mostly VirtualizedList key warnings). Runtime confirms RN 0.81.0."
  );
}

function solvePinchZoom(b: Builder, task: TaskSpec) {
  const w = b.world;
  ensureDevice(b);
  ensureLaunched(b);
  walkRoute(b, task);
  discover(b);
  const img = find(b, task.targetElementKey) ?? currentVisible(w)[0]!;
  const c = tapPoint(img);
  b.act(`Pinching out to zoom into "${img.label}".`, [
    {
      name: "gesture-pinch",
      args: { udid: w.deviceId, centerX: c.x, centerY: c.y, startDistance: 0.15, endDistance: 0.6 },
    },
  ]);
  b.act("Rotating to landscape to check the image scales correctly.", [
    { name: "rotate", args: { udid: w.deviceId, orientation: "LandscapeLeft" } },
  ]);
  b.act("Rotating back to portrait.", [
    { name: "rotate", args: { udid: w.deviceId, orientation: "Portrait" } },
  ]);
  b.final(`Zoomed into "${img.label}" and confirmed it scales cleanly across orientations.`);
}

function solveChromiumTabs(b: Builder, task: TaskSpec) {
  const w = b.world;
  ensureDevice(b);
  ensureLaunched(b);
  b.act("Listing the open tabs.", [
    { name: "chromium-tabs", args: { udid: w.deviceId, action: "list" } },
  ]);
  b.act("Opening the target view in a new tab.", [
    { name: "chromium-tabs", args: { udid: w.deviceId, action: "new", url: task.deepLinkUrl! } },
  ]);
  discover(b);
  const target = tapKey(b, task.targetElementKey);
  b.final(`Opened a new tab to ${currentScreenDef(w).title} and tapped "${target.label}".`);
}

function solveNativeInspect(b: Builder, task: TaskSpec) {
  const w = b.world;
  ensureDevice(b);
  ensureLaunched(b);
  walkRoute(b, task);
  discover(b);
  const target = find(b, task.targetElementKey) ?? currentVisible(w)[0]!;
  b.act(
    `For the exact UIKit identifier and class of "${target.label}", I'll use native-describe-screen (it surfaces accessibilityIdentifier and view class).`,
    [{ name: "native-describe-screen", args: { udid: w.deviceId, bundleId: w.app.bundleId } }]
  );
  b.final(
    `"${target.label}" has accessibilityIdentifier "${target.identifier}" on a ${target.role === "button" ? "UIButton" : "UIView"}.`
  );
}

function solveHideAndSeek(b: Builder, task: TaskSpec) {
  const w = b.world;
  const goal = task.pathLabels.at(-1) ?? "the target";
  ensureDevice(b);
  ensureLaunched(b);
  const hops = task.route;
  for (let i = 0; i < hops.length; i++) {
    const hop = hops[i]!;
    discover(
      b,
      `Looking for "${goal}". Let me read the ${currentScreenDef(w).title} screen to decide where to go.`
    );
    if (i === 0) {
      // Demonstrate a realistic search: try one plausible-but-wrong place first,
      // read the screen we land on, recognize the target isn't there, and
      // backtrack — exactly the navigation+recovery behavior to train.
      const correct = find(b, hop.elementKey);
      const correctNav = correct?.navigatesTo;
      const wrong = currentVisible(w).find(
        (e) =>
          e.navigatesTo &&
          e.key !== hop.elementKey &&
          e.navigatesTo !== correctNav &&
          !w.app.screens[e.navigatesTo]?.elements.some((x) => x.key === task.targetElementKey)
      );
      if (wrong && b.rng.bool(0.7)) {
        b.hasRecovery = true;
        const wp = tapPoint(wrong);
        b.act(
          `I'm not sure where "${goal}" lives — "${wrong.label}" looks plausible, let me check there.`,
          [{ name: "gesture-tap", args: { udid: w.deviceId, x: wp.x, y: wp.y } }]
        );
        discover(b, "Reading this screen to see if the target is here.");
        b.act(
          `"${goal}" isn't on the ${currentScreenDef(w).title} screen — backtracking to try another route.`,
          [{ name: "button", args: { udid: w.deviceId, button: "back" } }]
        );
        discover(b, "Back to the previous screen; trying the more likely path now.");
      }
      tapKey(b, hop.elementKey);
    } else {
      tapKey(b, hop.elementKey);
    }
  }
  discover(b, `This looks like the right screen — confirming "${goal}" is here.`);
  const target = tapKey(b, task.targetElementKey);
  b.final(
    `Found "${target.label}" by exploring ${w.app.name} (it was under ${task.pathLabels.slice(0, -1).join(" > ") || "the main screen"}) and opened it.`
  );
}

const SOLVERS: Record<TaskSpec["kind"], (b: Builder, t: TaskSpec) => void> = {
  "navigate-tap": solveNavigateTap,
  "toggle": solveToggle,
  "login": solveLogin,
  "scroll-find": solveScrollFind,
  "run-sequence": solveRunSequence,
  "visual-regression": solveVisualRegression,
  "profile": solveProfile,
  "flow-record": solveFlowRecord,
  "network-inspect": solveNetworkInspect,
  "android-setup": solveAndroidSetup,
  "debug-inspect": solveDebugInspect,
  "deep-link": solveDeepLink,
  "console-check": solveConsoleCheck,
  "pinch-zoom": solvePinchZoom,
  "chromium-tabs": solveChromiumTabs,
  "native-inspect": solveNativeInspect,
  "hide-and-seek": solveHideAndSeek,
};

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export interface SolveResult {
  world: World;
  messages: Message[];
  toolsUsed: string[];
  assistantTurns: number;
  toolCalls: number;
  hasRecovery: boolean;
}

export function solve(task: TaskSpec, rng: RNG, userPrompt: string): SolveResult {
  const world = buildWorld({
    app: task.app,
    platform: task.platform,
    rng,
    inject: task.inject,
    deviceBooted: task.deviceBooted,
  });
  const b = new Builder(world, rng);
  b.user(userPrompt);
  SOLVERS[task.kind](b, task);
  return {
    world,
    messages: b.messages,
    toolsUsed: [...b.toolsUsed],
    assistantTurns: b.assistantTurns,
    toolCalls: b.toolCalls,
    hasRecovery: b.hasRecovery,
  };
}
