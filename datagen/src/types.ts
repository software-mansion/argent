// Core types for the Argent gym + trajectory generator.
//
// The whole pipeline is deterministic: given a seed, the same trajectory is
// produced. That makes the dataset reproducible, shardable, and diffable.

export type Platform = "ios" | "android" | "chromium";

/** Who is asking, and in what voice. */
export type Persona = "technical" | "nontechnical" | "seeker";

/** Normalized [0,1] frame, exactly the coordinate space every Argent tool uses. */
export interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A single interactive element on a screen. `frame` is normalized so a tap at
 * its centre is a grounded, schema-valid coordinate — this is what makes the
 * generated tap coordinates trustworthy instead of hallucinated.
 */
export interface ElementDef {
  /** Stable key within the screen; used for navigation edges + grounding. */
  key: string;
  /** Platform accessibility role used by `describe` (AXButton, Button, View…). */
  role: string;
  /** React component name surfaced by `debugger-component-tree` (RN apps). */
  component?: string;
  label?: string;
  /** accessibilityIdentifier (iOS) / resource-id (Android) / testID (RN). */
  identifier?: string;
  frame: Frame;
  /** Tapping this element navigates to the named screen. */
  navigatesTo?: string;
  /** Tapping this element toggles a boolean state under this key. */
  togglesState?: string;
  /** This element is a text field writing to the named field key. */
  textField?: string;
  /** This element fires an HTTP request (used by network-inspection tasks). */
  firesRequest?: NetworkSeed;
  /** Marks a tab-bar item (bottom navigation). */
  isTab?: boolean;
  /** Only visible after scrolling the screen down (offscreen until revealed). */
  revealedByScroll?: boolean;
}

export interface ScreenDef {
  key: string;
  title: string;
  elements: ElementDef[];
}

export interface NetworkSeed {
  method: string;
  url: string;
  status: number;
  statusText: string;
  resourceType: string;
  bytes: number;
  durationMs: number;
  reqBody?: string;
  resBody?: string;
}

/**
 * A self-contained app world. Instantiated per platform; an archetype declares
 * which platforms it can run on. Screen graph + nav edges drive realistic
 * multi-step navigation.
 */
export interface AppArchetype {
  id: string;
  name: string;
  platforms: Platform[];
  /** bundle id (iOS) / package (Android) / electron app id (chromium). */
  bundleId: string;
  isReactNative: boolean;
  metroPort?: number;
  entryScreen: string;
  screens: Record<string, ScreenDef>;
  /** Deep links: url -> screen key (open-url targets). */
  urls?: Record<string, string>;
}

export interface DeviceState {
  platform: Platform;
  /** udid (iOS) / adb serial (android) / chromium id. */
  id: string;
  name: string;
  booted: boolean;
  /** Android only. */
  avdName?: string;
  sdkLevel?: number;
  /** Chromium only. */
  port?: number;
}

/** Mutable world state threaded through a single trajectory. */
export interface World {
  app: AppArchetype;
  platform: Platform;
  devices: DeviceState[];
  avds: string[];
  /** The device the task operates on. */
  deviceId: string;
  // runtime flags
  simServerRunning: boolean;
  metroRunning: boolean;
  debuggerConnected: boolean;
  androidReversed: boolean;
  launchedBundle: string | null;
  currentScreen: string;
  /** navigation back-stack of screen keys. */
  navStack: string[];
  /** screens whose scroll has been revealed. */
  scrolledScreens: Set<string>;
  fieldValues: Record<string, string>;
  toggles: Record<string, boolean>;
  // profiler
  reactProfiling: boolean;
  nativeProfiling: boolean;
  reactProfileStartMs?: number;
  // flow recording
  flowRecording?: { name: string; projectRoot: string; prereq: string; steps: FlowStep[] };
  flowsOnDisk: Record<string, { prereq: string; steps: FlowStep[] }>;
  // network
  networkLog: NetworkSeed[];
  clock: number;
  // failure injection (consumed once)
  inject: InjectionPlan;
}

export interface FlowStep {
  kind: "tool" | "echo";
  name?: string;
  message?: string;
  args?: Record<string, unknown>;
}

export interface InjectionPlan {
  /** First tap on a navigation element silently misses; expert recovers. */
  tapMissOnce?: boolean;
  /** describe fails first call; expert falls back / retries. */
  describeFailsOnce?: boolean;
  /** boot-device times out once before succeeding. */
  bootTimeoutOnce?: boolean;
  /** Metro/debugger not connected on first debugger call. */
  debuggerDropOnce?: boolean;
}

// ---- Message / trajectory schema (normalized, OpenAI-ish) ----

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; name: string; content: string };

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface TrajectoryMeta {
  id: string;
  seed: number;
  task_type: string;
  persona: Persona;
  platform: Platform;
  app_archetype: string;
  difficulty: "easy" | "medium" | "hard";
  is_react_native: boolean;
  tools_used: string[];
  n_assistant_turns: number;
  n_tool_calls: number;
  has_recovery: boolean;
  source: "expert-solver";
}

export interface Trajectory {
  meta: TrajectoryMeta;
  /** Tools offered to the model for this example (used + distractors). */
  tools: ToolSpec[];
  messages: Message[];
}
