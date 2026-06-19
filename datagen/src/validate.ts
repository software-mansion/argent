// Validator gates. Every trajectory must pass all of these or it is rejected.
// This is what turns "synthetic" into "high quality": nothing ships unless it
// is schema-valid, structurally sound, policy-compliant, and — crucially —
// every tap coordinate is grounded in a preceding discovery result.

import AjvMod from "ajv";
import type { Message, ToolSpec, Trajectory } from "./types.ts";

const Ajv = (AjvMod as unknown as { default?: typeof AjvMod }).default ?? AjvMod;

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

const DISCOVERY_TOOLS = new Set([
  "describe",
  "debugger-component-tree",
  "native-describe-screen",
  "native-full-hierarchy",
  "native-find-views",
]);

const GESTURE_COORD_FIELDS = [
  "x",
  "y",
  "fromX",
  "fromY",
  "toX",
  "toY",
  "centerX",
  "centerY",
  "radius",
  "startDistance",
  "endDistance",
];

// Tools that change which screen is visible, invalidating the current discovery.
// (A navigating gesture-tap also changes the screen, but the expert always
// re-discovers after one, which resets grounding on its own.)
const NAV_TOOLS = new Set(["launch-app", "open-url", "restart-app"]);

function isBackOrHome(args: Record<string, unknown>): boolean {
  return args.button === "back" || args.button === "home";
}

const RUN_SEQUENCE_ALLOWED = new Set([
  "gesture-tap",
  "gesture-swipe",
  "gesture-scroll",
  "gesture-drag",
  "gesture-custom",
  "gesture-pinch",
  "gesture-rotate",
  "button",
  "keyboard",
  "rotate",
]);

export class Validator {
  private ajv: InstanceType<typeof Ajv>;
  private validators = new Map<string, ReturnType<InstanceType<typeof Ajv>["compile"]>>();
  private schemas = new Map<string, Record<string, unknown>>();
  private catalogNames: Set<string>;

  constructor(catalog: ToolSpec[]) {
    this.ajv = new Ajv({ allErrors: true, strict: false });
    this.catalogNames = new Set(catalog.map((t) => t.name));
    for (const t of catalog) {
      this.schemas.set(t.name, t.inputSchema);
      this.validators.set(t.name, this.ajv.compile(t.inputSchema));
    }
  }

  validate(traj: Trajectory): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const msgs = traj.messages;

    this.checkStructure(msgs, errors);
    this.checkSchemas(msgs, errors);
    this.checkDeviceFirst(msgs, errors);
    this.checkGroundingAndPolicy(msgs, errors, warnings);
    this.checkToolsOffered(traj, errors);

    return { ok: errors.length === 0, errors, warnings };
  }

  /** Validate a single tool call (used by the live eval harness). */
  checkCall(
    name: string,
    args: Record<string, unknown>
  ): { known: boolean; schemaOk: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!this.catalogNames.has(name))
      return { known: false, schemaOk: false, errors: [`unknown tool '${name}'`] };
    const v = this.validators.get(name)!;
    const schema = this.schemas.get(name)!;
    let schemaOk = true;
    if (!v(args)) {
      schemaOk = false;
      errors.push(this.ajv.errorsText(v.errors));
    }
    const props = Object.keys((schema.properties as Record<string, unknown>) ?? {});
    for (const k of Object.keys(args)) {
      if (!props.includes(k)) {
        schemaOk = false;
        errors.push(`unknown argument '${k}'`);
      }
    }
    if (name.startsWith("gesture-")) {
      for (const f of GESTURE_COORD_FIELDS) {
        const val = args[f];
        if (typeof val === "number" && (val < 0 || val > 1)) {
          schemaOk = false;
          errors.push(`${f}=${val} out of [0,1]`);
        }
      }
    }
    return { known: true, schemaOk, errors };
  }

  // --- structure: roles, alternation, tool_call_id pairing ---
  private checkStructure(msgs: Message[], errors: string[]) {
    if (msgs[0]?.role !== "system") errors.push("first message must be system");
    if (msgs[1]?.role !== "user") errors.push("second message must be user");
    const last = msgs[msgs.length - 1];
    if (!last || last.role !== "assistant" || (last as { tool_calls?: unknown }).tool_calls) {
      errors.push("final message must be an assistant message with no tool_calls");
    }
    const pendingIds: string[] = [];
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i]!;
      if (m.role === "assistant" && m.tool_calls) {
        // every tool_call must be followed (in order) by a matching tool message
        const ids = m.tool_calls.map((c) => c.id);
        const seen: string[] = [];
        for (let j = i + 1; j < msgs.length && seen.length < ids.length; j++) {
          const t = msgs[j]!;
          if (t.role !== "tool") break;
          seen.push(t.tool_call_id);
        }
        for (const id of ids)
          if (!seen.includes(id)) errors.push(`tool_call ${id} has no matching tool result`);
        for (const c of m.tool_calls)
          if (!this.catalogNames.has(c.name))
            errors.push(`unknown tool '${c.name}' not in catalog`);
      }
      if (m.role === "tool") {
        // must correspond to a tool_call id seen earlier
        const ok = msgs
          .slice(0, i)
          .some(
            (p) => p.role === "assistant" && p.tool_calls?.some((c) => c.id === m.tool_call_id)
          );
        if (!ok) errors.push(`tool result ${m.tool_call_id} has no originating tool_call`);
      }
    }
    void pendingIds;
  }

  // --- schema: ajv + strict unknown-property check ---
  private checkSchemas(msgs: Message[], errors: string[]) {
    for (const m of msgs) {
      if (m.role !== "assistant" || !m.tool_calls) continue;
      for (const c of m.tool_calls) {
        const v = this.validators.get(c.name);
        const schema = this.schemas.get(c.name);
        if (!v || !schema) continue; // unknown tool already reported
        if (!v(c.arguments)) {
          errors.push(`${c.name}: schema ${this.ajv.errorsText(v.errors)}`);
        }
        const props = Object.keys((schema.properties as Record<string, unknown>) ?? {});
        for (const k of Object.keys(c.arguments)) {
          if (!props.includes(k)) errors.push(`${c.name}: unknown argument '${k}'`);
        }
        if (c.name === "run-sequence") this.checkRunSequence(c.arguments, errors);
        // gesture coordinate range (skip debugger-inspect-element: pixel coords)
        if (c.name.startsWith("gesture-")) {
          for (const f of GESTURE_COORD_FIELDS) {
            const val = (c.arguments as Record<string, unknown>)[f];
            if (typeof val === "number" && (val < 0 || val > 1)) {
              errors.push(`${c.name}: ${f}=${val} out of normalized [0,1] range`);
            }
          }
        }
      }
    }
  }

  private checkRunSequence(args: Record<string, unknown>, errors: string[]) {
    const steps = args.steps as Array<{ tool: string; args: Record<string, unknown> }> | undefined;
    if (!Array.isArray(steps)) return;
    for (const [i, step] of steps.entries()) {
      if (!RUN_SEQUENCE_ALLOWED.has(step.tool))
        errors.push(`run-sequence step ${i}: tool '${step.tool}' not allowed in a sequence`);
      if (step.args && "udid" in step.args)
        errors.push(`run-sequence step ${i}: must not include 'udid' (it is injected)`);
      // validate inner step against its tool schema (udid is supplied by the runner)
      const schema = this.schemas.get(step.tool);
      if (schema) {
        const required = ((schema.required as string[]) ?? []).filter((r) => r !== "udid");
        for (const r of required)
          if (!(r in (step.args ?? {})))
            errors.push(`run-sequence step ${i}: missing required '${r}' for ${step.tool}`);
        const props = Object.keys((schema.properties as Record<string, unknown>) ?? {});
        for (const k of Object.keys(step.args ?? {}))
          if (!props.includes(k))
            errors.push(`run-sequence step ${i}: unknown arg '${k}' for ${step.tool}`);
      }
    }
  }

  // --- device selection: list-devices before first boot/launch/open ---
  private checkDeviceFirst(msgs: Message[], errors: string[]) {
    let listedAt = -1;
    let firstTouchAt = -1;
    let idx = 0;
    for (const m of msgs) {
      if (m.role === "assistant" && m.tool_calls) {
        for (const c of m.tool_calls) {
          if (c.name === "list-devices" && listedAt < 0) listedAt = idx;
          if (
            (c.name === "boot-device" || c.name === "launch-app" || c.name === "open-url") &&
            firstTouchAt < 0
          )
            firstTouchAt = idx;
        }
      }
      idx++;
    }
    if (firstTouchAt >= 0 && (listedAt < 0 || listedAt > firstTouchAt)) {
      errors.push("device interaction (boot/launch/open) occurred before list-devices");
    }
  }

  // --- grounding + discovery-before-tap (the core quality gate) ---
  private checkGroundingAndPolicy(msgs: Message[], errors: string[], warnings: string[]) {
    // Walk messages, tracking the most-recent discovery tool result.
    let lastDiscovery: { name: string; content: string } | null = null;

    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i]!;
      if (m.role === "tool" && DISCOVERY_TOOLS.has(m.name)) {
        // Only treat a *successful* discovery as grounding (errors carry a JSON error).
        if (!/"error"\s*:/.test(m.content)) lastDiscovery = { name: m.name, content: m.content };
      }
      if (m.role !== "assistant" || !m.tool_calls) continue;
      for (const c of m.tool_calls) {
        // Navigation changes the screen, so the prior discovery no longer
        // describes what's visible: any tap after it must be re-grounded by a
        // fresh discovery. This is what makes discovery-before-tap hold across
        // screen transitions, not just at the start of a trajectory.
        if (NAV_TOOLS.has(c.name) || (c.name === "button" && isBackOrHome(c.arguments))) {
          lastDiscovery = null;
          continue;
        }
        if (c.name === "gesture-tap") {
          const x = Number(c.arguments.x);
          const y = Number(c.arguments.y);
          if (!lastDiscovery) {
            errors.push(
              `gesture-tap at (${x},${y}) with no preceding discovery (guessed coordinates)`
            );
          } else if (!this.isGrounded(lastDiscovery, x, y)) {
            errors.push(
              `gesture-tap at (${x},${y}) not grounded in latest ${lastDiscovery.name} result (stale screen / ungrounded)`
            );
          }
        }
        if (c.name === "run-sequence") {
          // Ground the first tap step against the latest discovery.
          const steps =
            (c.arguments.steps as Array<{ tool: string; args: Record<string, unknown> }>) ?? [];
          const firstTap = steps.find((s) => s.tool === "gesture-tap");
          if (firstTap) {
            const x = Number(firstTap.args.x);
            const y = Number(firstTap.args.y);
            if (!lastDiscovery)
              errors.push(`run-sequence tap (${x},${y}) with no preceding discovery`);
            else if (!this.isGrounded(lastDiscovery, x, y))
              errors.push(`run-sequence tap (${x},${y}) not grounded in latest discovery`);
          }
        }
      }
    }
  }

  private isGrounded(disc: { name: string; content: string }, x: number, y: number): boolean {
    if (disc.name === "debugger-component-tree") {
      const pts = parseComponentTaps(disc.content);
      return pts.some((p) => Math.abs(p.x - x) <= 0.02 && Math.abs(p.y - y) <= 0.02);
    }
    // describe-family: box containment
    const boxes = parseDescribeBoxes(disc.content);
    const eps = 0.005;
    return boxes.some(
      (b) => x >= b.x - eps && x <= b.x + b.w + eps && y >= b.y - eps && y <= b.y + b.h + eps
    );
  }

  private checkToolsOffered(traj: Trajectory, errors: string[]) {
    const offered = new Set(traj.tools.map((t) => t.name));
    for (const m of traj.messages) {
      if (m.role === "assistant" && m.tool_calls) {
        for (const c of m.tool_calls)
          if (!offered.has(c.name))
            errors.push(`tool '${c.name}' called but not offered in tools[]`);
      }
    }
  }
}

// ---- discovery-output parsers (mirror the real serializers) ----

export function parseDescribeBoxes(text: string): { x: number; y: number; w: number; h: number }[] {
  const out: { x: number; y: number; w: number; h: number }[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/\(([0-9.]+),\s*([0-9.]+),\s*([0-9.]+),\s*([0-9.]+)\)\s*$/);
    if (m) out.push({ x: +m[1]!, y: +m[2]!, w: +m[3]!, h: +m[4]! });
  }
  // Drop the ROOT (0,0,1,1) box so a tap isn't trivially "grounded" by the root.
  return out.filter((b) => !(b.x === 0 && b.y === 0 && b.w === 1 && b.h === 1));
}

export function parseComponentTaps(text: string): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  const re = /\(tap:\s*([0-9.]+),\s*([0-9.]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ x: +m[1]!, y: +m[2]! });
  return out;
}
