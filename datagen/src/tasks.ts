// Task taxonomy + generator. A TaskSpec is a fully-resolved, walkable task in a
// concrete world (archetype + platform + a real route through the screen graph)
// plus an optional injected failure for recovery demonstrations.

import { ARCHETYPES } from "./archetypes/index.ts";
import { elementByKey, reachableScreens, routeToScreen, screenLabel, type Hop } from "./graph.ts";
import type { RNG } from "./rng.ts";
import type { AppArchetype, ElementDef, InjectionPlan, Platform } from "./types.ts";

export type TaskKind =
  | "navigate-tap"
  | "toggle"
  | "login"
  | "scroll-find"
  | "run-sequence"
  | "visual-regression"
  | "profile"
  | "flow-record"
  | "network-inspect"
  | "android-setup"
  | "debug-inspect"
  | "deep-link"
  | "console-check"
  | "pinch-zoom"
  | "chromium-tabs"
  | "native-inspect";

export interface TaskSpec {
  kind: TaskKind;
  app: AppArchetype;
  platform: Platform;
  difficulty: "easy" | "medium" | "hard";
  targetScreen: string;
  targetElementKey: string;
  route: Hop[];
  pathLabels: string[];
  inject: InjectionPlan;
  deviceBooted: boolean;
  field?: string;
  query?: string;
  deepLinkUrl?: string;
}

interface ElemRef {
  screen: string;
  el: ElementDef;
}

/** Elements worth tapping as a task target (avoid static headings/text/images). */
function isActionable(el: ElementDef): boolean {
  return Boolean(
    el.navigatesTo ||
    el.togglesState ||
    el.textField ||
    ["button", "tab", "switch", "field", "link"].includes(el.role)
  );
}

/** Actionable, non-tab targets on a screen, falling back to any non-tab element. */
function targetCandidates(app: AppArchetype, screen: string): ElementDef[] {
  const els = app.screens[screen]!.elements.filter((e) => !e.isTab);
  const actionable = els.filter(isActionable);
  return actionable.length ? actionable : els;
}

function allElements(app: AppArchetype): ElemRef[] {
  const reach = new Set(reachableScreens(app));
  const out: ElemRef[] = [];
  for (const [screen, def] of Object.entries(app.screens)) {
    if (!reach.has(screen)) continue;
    for (const el of def.elements) out.push({ screen, el });
  }
  return out;
}

function pathLabelsFor(app: AppArchetype, route: Hop[]): string[] {
  return route.map((h) => {
    const el = elementByKey(app, h.screen, h.elementKey);
    return el?.label ?? h.elementKey;
  });
}

function pickPlatform(rng: RNG, app: AppArchetype, force?: Platform): Platform {
  if (force && app.platforms.includes(force)) return force;
  return rng.pick(app.platforms);
}

function maybeInject(rng: RNG, plan: InjectionPlan, p: number): InjectionPlan {
  // Roughly `p` of trajectories get exactly one recovery scenario.
  if (!rng.bool(p)) return {};
  return plan;
}

const TASK_WEIGHTS: [TaskKind, number][] = [
  ["navigate-tap", 22],
  ["toggle", 10],
  ["login", 9],
  ["scroll-find", 10],
  ["run-sequence", 7],
  ["visual-regression", 7],
  ["profile", 9],
  ["flow-record", 7],
  ["network-inspect", 7],
  ["android-setup", 6],
  ["debug-inspect", 6],
  ["deep-link", 6],
  ["console-check", 6],
  ["pinch-zoom", 5],
  ["chromium-tabs", 4],
  ["native-inspect", 5],
];

function pickKind(rng: RNG): TaskKind {
  const total = TASK_WEIGHTS.reduce((a, [, w]) => a + w, 0);
  let r = rng.int(total);
  for (const [k, w] of TASK_WEIGHTS) {
    if (r < w) return k;
    r -= w;
  }
  return "navigate-tap";
}

/** Generate one fully-resolved task, or null if the sampled kind has no fit. */
export function generateTask(rng: RNG): TaskSpec | null {
  const kind = pickKind(rng);
  switch (kind) {
    case "toggle":
      return buildToggle(rng);
    case "login":
      return buildLogin(rng);
    case "scroll-find":
      return buildScrollFind(rng);
    case "run-sequence":
      return buildRunSequence(rng);
    case "visual-regression":
      return buildVisualRegression(rng);
    case "profile":
      return buildProfile(rng);
    case "flow-record":
      return buildFlowRecord(rng);
    case "network-inspect":
      return buildNetworkInspect(rng);
    case "android-setup":
      return buildAndroidSetup(rng);
    case "debug-inspect":
      return buildDebugInspect(rng);
    case "deep-link":
      return buildDeepLink(rng);
    case "console-check":
      return buildConsoleCheck(rng);
    case "pinch-zoom":
      return buildPinchZoom(rng);
    case "chromium-tabs":
      return buildChromiumTabs(rng);
    case "native-inspect":
      return buildNativeInspect(rng);
    default:
      return buildNavigateTap(rng);
  }
}

function difficultyForRoute(route: Hop[]): TaskSpec["difficulty"] {
  if (route.length <= 1) return "easy";
  if (route.length === 2) return "medium";
  return "hard";
}

// ---- builders ----

function buildNavigateTap(rng: RNG): TaskSpec | null {
  const app = rng.pick(ARCHETYPES);
  const platform = pickPlatform(rng, app);
  const screens = reachableScreens(app).filter((s) => s !== app.entryScreen);
  if (!screens.length) return null;
  const targetScreen = rng.pick(screens);
  const candidates = targetCandidates(app, targetScreen);
  if (!candidates.length) return null;
  const target = rng.pick(candidates);
  const route = routeToScreen(app, targetScreen);
  if (!route) return null;
  const inject = maybeInject(rng, { tapMissOnce: route.length > 0 }, 0.22);
  return {
    kind: "navigate-tap",
    app,
    platform,
    difficulty: difficultyForRoute(route),
    targetScreen,
    targetElementKey: target.key,
    route,
    pathLabels: [...pathLabelsFor(app, route), target.label ?? target.key],
    inject,
    deviceBooted: true,
  };
}

function buildToggle(rng: RNG): TaskSpec | null {
  const refs = ARCHETYPES.flatMap((app) =>
    allElements(app)
      .filter((r) => r.el.togglesState)
      .map((r) => ({ app, ...r }))
  );
  if (!refs.length) return null;
  const { app, screen, el } = rng.pick(refs);
  const platform = pickPlatform(rng, app);
  const route = routeToScreen(app, screen);
  if (!route) return null;
  return {
    kind: "toggle",
    app,
    platform,
    difficulty: difficultyForRoute(route),
    targetScreen: screen,
    targetElementKey: el.key,
    route,
    pathLabels: [...pathLabelsFor(app, route), el.label ?? el.key],
    inject: maybeInject(rng, { describeFailsOnce: !app.isReactNative }, 0.2),
    deviceBooted: true,
  };
}

function buildLogin(rng: RNG): TaskSpec | null {
  const app = ARCHETYPES.find((a) => a.id === "auth-login")!;
  const platform = pickPlatform(rng, app);
  return {
    kind: "login",
    app,
    platform,
    difficulty: "medium",
    targetScreen: "login",
    targetElementKey: "signin",
    route: [],
    pathLabels: ["Sign In"],
    inject: maybeInject(rng, { debuggerDropOnce: true }, 0.18),
    deviceBooted: true,
  };
}

function buildScrollFind(rng: RNG): TaskSpec | null {
  const refs = ARCHETYPES.flatMap((app) =>
    allElements(app)
      .filter((r) => r.el.revealedByScroll)
      .map((r) => ({ app, ...r }))
  );
  if (!refs.length) return null;
  const { app, screen, el } = rng.pick(refs);
  const platform = pickPlatform(rng, app);
  const route = routeToScreen(app, screen);
  if (!route) return null;
  return {
    kind: "scroll-find",
    app,
    platform,
    difficulty: "medium",
    targetScreen: screen,
    targetElementKey: el.key,
    route,
    pathLabels: [...pathLabelsFor(app, route), el.label ?? el.key],
    inject: {},
    deviceBooted: true,
  };
}

function buildRunSequence(rng: RNG): TaskSpec | null {
  const app = ARCHETYPES.find((a) => a.id === "rn-shop")!;
  const platform = pickPlatform(rng, app);
  const route = routeToScreen(app, "search");
  if (!route) return null;
  return {
    kind: "run-sequence",
    app,
    platform,
    difficulty: "medium",
    targetScreen: "search",
    targetElementKey: "search-field",
    route,
    pathLabels: ["Search", "Mechanical Keyboard"],
    inject: {},
    deviceBooted: true,
    field: "search",
    query: rng.pick(["keyboard", "headphones", "usb hub", "webcam"]),
  };
}

function buildVisualRegression(rng: RNG): TaskSpec | null {
  const app = rng.pick(ARCHETYPES);
  const platform = pickPlatform(rng, app);
  const screens = reachableScreens(app).filter((s) => s !== app.entryScreen);
  if (!screens.length) return null;
  const targetScreen = rng.pick(screens);
  const route = routeToScreen(app, targetScreen);
  if (!route) return null;
  return {
    kind: "visual-regression",
    app,
    platform,
    difficulty: difficultyForRoute(route),
    targetScreen,
    targetElementKey: app.screens[targetScreen]!.elements[0]!.key,
    route,
    pathLabels: [screenLabel(app, targetScreen)],
    inject: {},
    deviceBooted: true,
  };
}

function buildProfile(rng: RNG): TaskSpec | null {
  const app = rng.pick(ARCHETYPES.filter((a) => a.isReactNative));
  const platform = pickPlatform(rng, app);
  // Profile a scrollable screen.
  const target = app.id === "rn-shop" ? "home" : "dashboard";
  const route = routeToScreen(app, target) ?? [];
  return {
    kind: "profile",
    app,
    platform,
    difficulty: "hard",
    targetScreen: target,
    targetElementKey: app.screens[target]!.elements[0]!.key,
    route,
    pathLabels: [screenLabel(app, target)],
    inject: {},
    deviceBooted: true,
  };
}

function buildFlowRecord(rng: RNG): TaskSpec | null {
  const app = rng.pick(ARCHETYPES.filter((a) => a.platforms.includes("ios")));
  const platform = pickPlatform(rng, app, "ios");
  const screens = reachableScreens(app).filter((s) => s !== app.entryScreen);
  if (!screens.length) return null;
  const targetScreen = rng.pick(screens);
  const target = rng.pick(targetCandidates(app, targetScreen));
  const route = routeToScreen(app, targetScreen);
  if (!route) return null;
  return {
    kind: "flow-record",
    app,
    platform,
    difficulty: difficultyForRoute(route),
    targetScreen,
    targetElementKey: target.key,
    route,
    pathLabels: [...pathLabelsFor(app, route), target.label ?? target.key],
    inject: {},
    deviceBooted: true,
  };
}

function buildNetworkInspect(rng: RNG): TaskSpec | null {
  const refs = ARCHETYPES.flatMap((app) =>
    allElements(app)
      .filter((r) => r.el.firesRequest)
      .map((r) => ({ app, ...r }))
  );
  if (!refs.length) return null;
  const { app, screen, el } = rng.pick(refs);
  const platform = pickPlatform(rng, app);
  const route = routeToScreen(app, screen);
  if (!route) return null;
  return {
    kind: "network-inspect",
    app,
    platform,
    difficulty: "medium",
    targetScreen: screen,
    targetElementKey: el.key,
    route,
    pathLabels: [...pathLabelsFor(app, route), el.label ?? el.key],
    inject: {},
    deviceBooted: true,
  };
}

function buildAndroidSetup(rng: RNG): TaskSpec | null {
  const app = rng.pick(ARCHETYPES.filter((a) => a.platforms.includes("android")));
  const screens = reachableScreens(app).filter((s) => s !== app.entryScreen);
  const targetScreen = screens.length ? rng.pick(screens) : app.entryScreen;
  const target = rng.pick(targetCandidates(app, targetScreen));
  const route = routeToScreen(app, targetScreen) ?? [];
  return {
    kind: "android-setup",
    app,
    platform: "android",
    difficulty: "hard",
    targetScreen,
    targetElementKey: target.key,
    route,
    pathLabels: [...pathLabelsFor(app, route), target.label ?? target.key],
    inject: maybeInject(rng, { bootTimeoutOnce: true }, 0.3),
    deviceBooted: false,
  };
}

function buildDeepLink(rng: RNG): TaskSpec | null {
  const apps = ARCHETYPES.filter((a) => a.urls && Object.keys(a.urls).length);
  const app = rng.pick(apps);
  const urlEntries = Object.entries(app.urls!).filter(
    ([, screen]) => targetCandidates(app, screen).length
  );
  if (!urlEntries.length) return null;
  const [url, screen] = rng.pick(urlEntries);
  const platform = pickPlatform(rng, app);
  const target = rng.pick(targetCandidates(app, screen));
  return {
    kind: "deep-link",
    app,
    platform,
    difficulty: "easy",
    targetScreen: screen,
    targetElementKey: target.key,
    route: [],
    pathLabels: [screenLabel(app, screen), target.label ?? target.key],
    inject: {},
    deviceBooted: true,
    deepLinkUrl: url,
  };
}

function buildConsoleCheck(rng: RNG): TaskSpec | null {
  const app = rng.pick(ARCHETYPES.filter((a) => a.isReactNative));
  const platform = pickPlatform(rng, app);
  const screens = reachableScreens(app);
  const targetScreen = rng.pick(screens);
  const route = routeToScreen(app, targetScreen) ?? [];
  return {
    kind: "console-check",
    app,
    platform,
    difficulty: "medium",
    targetScreen,
    targetElementKey: app.screens[targetScreen]!.elements[0]!.key,
    route,
    pathLabels: [screenLabel(app, targetScreen)],
    inject: {},
    deviceBooted: true,
  };
}

function buildPinchZoom(rng: RNG): TaskSpec | null {
  const refs = ARCHETYPES.flatMap((app) =>
    allElements(app)
      .filter((r) => r.el.role === "image")
      .map((r) => ({ app, ...r }))
  );
  if (!refs.length) return null;
  const { app, screen, el } = rng.pick(refs);
  const platform = pickPlatform(rng, app);
  const route = routeToScreen(app, screen);
  if (!route) return null;
  return {
    kind: "pinch-zoom",
    app,
    platform,
    difficulty: "medium",
    targetScreen: screen,
    targetElementKey: el.key,
    route,
    pathLabels: [...pathLabelsFor(app, route), el.label ?? el.key],
    inject: {},
    deviceBooted: true,
  };
}

function buildChromiumTabs(rng: RNG): TaskSpec | null {
  const app = ARCHETYPES.find((a) => a.platforms.includes("chromium"));
  if (!app || !app.urls) return null;
  const urlEntries = Object.entries(app.urls).filter(
    ([, screen]) => screen !== app.entryScreen && targetCandidates(app, screen).length
  );
  if (!urlEntries.length) return null;
  const [url, screen] = rng.pick(urlEntries);
  const target = rng.pick(targetCandidates(app, screen));
  return {
    kind: "chromium-tabs",
    app,
    platform: "chromium",
    difficulty: "medium",
    targetScreen: screen,
    targetElementKey: target.key,
    route: [],
    pathLabels: [screenLabel(app, screen), target.label ?? target.key],
    inject: {},
    deviceBooted: true,
    deepLinkUrl: url,
  };
}

function buildNativeInspect(rng: RNG): TaskSpec | null {
  const app = ARCHETYPES.find((a) => a.id === "ios-settings")!;
  const screens = reachableScreens(app).filter((s) => s !== app.entryScreen);
  const targetScreen = rng.pick(screens);
  const target = rng.pick(targetCandidates(app, targetScreen));
  const route = routeToScreen(app, targetScreen);
  if (!route) return null;
  return {
    kind: "native-inspect",
    app,
    platform: "ios",
    difficulty: difficultyForRoute(route),
    targetScreen,
    targetElementKey: target.key,
    route,
    pathLabels: [...pathLabelsFor(app, route), target.label ?? target.key],
    inject: {},
    deviceBooted: true,
  };
}

function buildDebugInspect(rng: RNG): TaskSpec | null {
  const app = rng.pick(ARCHETYPES.filter((a) => a.isReactNative));
  const platform = pickPlatform(rng, app);
  const refs = allElements(app).filter((r) => !r.el.isTab && r.el.label);
  if (!refs.length) return null;
  const { screen, el } = rng.pick(refs);
  const route = routeToScreen(app, screen);
  if (!route) return null;
  return {
    kind: "debug-inspect",
    app,
    platform,
    difficulty: difficultyForRoute(route),
    targetScreen: screen,
    targetElementKey: el.key,
    route,
    pathLabels: [...pathLabelsFor(app, route), el.label ?? el.key],
    inject: {},
    deviceBooted: true,
  };
}
