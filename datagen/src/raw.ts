// The neutral, harness-agnostic raw trajectory.
//
// Two sources produce a RawTrajectory:
//   1. the synthetic gym  — `trajectoryToRaw(assemble(...))`
//   2. real-app capture   — a navigator agent emits RawTrajectory JSON directly
// Four harness renderers (harness/renderers.ts) consume a RawTrajectory and emit a
// gemma4-template-ready {messages, tools} record, each applying that harness's tool
// naming + result junk. So one trajectory → up to 4 training rows (naming/junk
// robustness). Tool names in a RawTrajectory are ALWAYS the canonical Argent names
// (e.g. "gesture-tap", "list-devices", "describe"); renderers map them per harness.

import type { Platform, ToolSpec, Trajectory } from "./types.ts";

export interface RawObservation {
  /** The real tool-result text (describe AX tree, list-devices JSON, keyboard ack, …).
   *  For pure screen-changing tools the readable text is minimal — the screen state
   *  must be re-read with `describe`. Never contains an idealized free screen view. */
  text: string;
  /** The tool auto-attached a screenshot (every Argent interaction tool does). The
   *  renderer decides how to surface it (OpenCode: unreadable-image junk; Codex:
   *  `--- Screen after action --- Saved: <path>`; Hermes: `[screenshot]`; …). */
  hasScreenshot?: boolean;
  /** Absolute path of the saved screenshot, if captured (kept for a vision follow-up). */
  screenshotPath?: string;
  /** A real (recoverable) tool error — kept so the model learns recovery. */
  isError?: boolean;
}

export interface RawStep {
  /** Optional reasoning shown before the call (most real rows omit it — no-narration). */
  thought?: string;
  /** The Argent tool call, canonical name + args object. */
  call: { name: string; arguments: Record<string, unknown> };
  /** The real observation returned by the tool. */
  observation: RawObservation;
}

export interface RawMeta {
  id: string;
  app: string; // app dir name (real) or archetype id (gym)
  platform: Platform;
  task_kind: string; // navigate-tap | toggle | scroll-find | swipe | pinch | search | …
  source: "gym" | "real";
  difficulty?: "easy" | "medium" | "hard";
  bundleId?: string;
  device?: string;
  gestures?: string[]; // which gesture kinds the path exercises (tap, swipe, scroll, pinch, …)
  notes?: string;
}

export interface RawTrajectory {
  meta: RawMeta;
  /** Canonical device-control policy text (renderer decides system vs folded). */
  policy: string;
  /** The user task phrasing. */
  task: string;
  /** Tools offered to the model, canonical Argent names (used ∪ distractors). */
  tools: ToolSpec[];
  /** Ordered navigation steps. */
  steps: RawStep[];
  /** Final plain-text answer (no tool call). */
  finalAnswer?: string;
}

// Tools that change the screen — real Argent auto-attaches a screenshot after these.
export const INTERACTION_TOOLS = new Set([
  "launch-app",
  "open-url",
  "restart-app",
  "reinstall-app",
  "gesture-tap",
  "gesture-swipe",
  "gesture-scroll",
  "gesture-pinch",
  "gesture-rotate",
  "gesture-drag",
  "gesture-custom",
  "keyboard",
  "button",
  "run-sequence",
  "rotate",
]);

// The gym's idealized free post-action caption (not something a real tool returns).
const SCENE_CAPTION = /\n\n\[screenshot\][\s\S]*$/;

/** Lift the existing gym Trajectory into the neutral RawTrajectory. The gym bakes a
 *  system turn and an idealized `[screenshot]` caption into interaction results; both
 *  are harness decisions, so we strip them here and let renderers re-apply. */
export function trajectoryToRaw(traj: Trajectory): RawTrajectory {
  const msgs = traj.messages;
  const policy = msgs.find((m) => m.role === "system")?.content ?? "";
  const firstUserIdx = msgs.findIndex((m) => m.role === "user");
  const task = firstUserIdx >= 0 ? (msgs[firstUserIdx] as { content: string }).content : "";

  // id -> canonical tool name (for matching tool results to their call)
  const idToName = new Map<string, string>();
  for (const m of msgs)
    if (m.role === "assistant" && m.tool_calls)
      for (const c of m.tool_calls) idToName.set(c.id, c.name);

  const steps: RawStep[] = [];
  let finalAnswer: string | undefined;
  for (let i = firstUserIdx + 1; i < msgs.length; i++) {
    const m = msgs[i]!;
    if (m.role === "assistant") {
      if (m.tool_calls && m.tool_calls.length) {
        for (const c of m.tool_calls) {
          // find the matching tool result among following tool messages
          const res = msgs
            .slice(i + 1)
            .find((x) => x.role === "tool" && x.tool_call_id === c.id) as
            | { content: string }
            | undefined;
          const rawText = res?.content ?? "";
          const hasShot = INTERACTION_TOOLS.has(c.name);
          // Keep the real tool-result ack ({tapped/launched/scrolled/typed/…}); strip only the gym's
          // idealized `[screenshot]` caption. The renderer re-appends the real
          // `--- Screen after action --- / Saved: <path>` for screenshot tools so train == serve.
          // (Previously blanked to "" → the model trained on a result it NEVER receives at inference,
          //  going OOD on every action outcome — the dominant cause of silver losing to the base.)
          const text = rawText.replace(SCENE_CAPTION, "").trimEnd();
          steps.push({
            thought: m.content || undefined,
            call: { name: c.name, arguments: c.arguments },
            observation: { text, hasScreenshot: hasShot },
          });
        }
      } else if (m.content) {
        finalAnswer = m.content; // final plain answer
      }
    }
  }

  return {
    meta: {
      id: traj.meta.id,
      app: traj.meta.app_archetype,
      platform: traj.meta.platform,
      task_kind: traj.meta.task_type,
      source: "gym",
      difficulty: traj.meta.difficulty,
      notes: traj.meta.is_react_native ? "react-native" : undefined,
    },
    policy,
    task,
    tools: traj.tools,
    steps,
    finalAnswer,
  };
}

// Real `describe` of a long list/calendar can be tens of thousands of chars (hundreds of AX
// elements), blowing past the memory-bound SEQ. Cap each describe to a char budget — but ALWAYS
// keep the element that grounds the NEXT tap, so the trajectory stays valid (the model can still
// locate what it taps). Structural lines (Source/Mode/ROOT/blank) are always kept.
const FRAME_RE = /\(([0-9.]+),\s*([0-9.]+),\s*([0-9.]+),\s*([0-9.]+)\)\s*$/;

function capDescribe(
  text: string,
  nextTap: { x: number; y: number } | null,
  maxChars: number
): string {
  if (text.length <= maxChars) return text;
  const lines = text.split("\n");
  const isElem = lines.map((l) => /^\s+/.test(l) && FRAME_RE.test(l) && !l.includes("ROOT"));
  const elemIdx = lines.map((_, i) => i).filter((i) => isElem[i]);
  if (!elemIdx.length) return text.slice(0, maxChars) + "\n…(truncated)";
  const structuralChars = lines
    .filter((_, i) => !isElem[i])
    .reduce((a, l) => a + l.length + 1, 0);
  let budget = maxChars - structuralChars;
  // grounding element: its frame contains the next tap point
  let groundIdx = -1;
  if (nextTap) {
    for (const i of elemIdx) {
      const m = lines[i]!.match(FRAME_RE);
      if (!m) continue;
      const [fx, fy, fw, fh] = m.slice(1).map(Number) as [number, number, number, number];
      if (nextTap.x >= fx && nextTap.x <= fx + fw && nextTap.y >= fy && nextTap.y <= fy + fh) {
        groundIdx = i;
        break;
      }
    }
  }
  const kept = new Set<number>();
  for (const i of elemIdx) {
    const cost = lines[i]!.length + 1;
    if (budget - cost < 0 && kept.size) break;
    kept.add(i);
    budget -= cost;
  }
  if (groundIdx >= 0) kept.add(groundIdx);
  const omitted = elemIdx.length - kept.size;
  const out = lines.filter((_, i) => !isElem[i] || kept.has(i));
  if (omitted > 0) out.push(`  … (${omitted} more elements)`);
  return out.join("\n");
}

/** Cap long describe observations in place (grounding-aware). Returns the trajectory. */
export function capObservations(raw: RawTrajectory, maxChars = 1500): RawTrajectory {
  const steps = raw.steps;
  for (let i = 0; i < steps.length; i++) {
    const obs = steps[i]!.observation;
    if (!obs.text || obs.text.length <= maxChars) continue;
    const nx = steps[i + 1]?.call.arguments as Record<string, number> | undefined;
    const nextTap =
      nx && typeof nx.x === "number" && typeof nx.y === "number"
        ? { x: nx.x, y: nx.y }
        : nx && typeof nx.fromX === "number" && typeof nx.fromY === "number"
          ? { x: nx.fromX, y: nx.fromY }
          : null;
    obs.text = capDescribe(obs.text, nextTap, maxChars);
  }
  return raw;
}

/** Rough char length of a raw trajectory (cheap SEQ proxy, ~3.6 chars/token). */
export function rawCharLen(raw: RawTrajectory): number {
  let n = raw.policy.length + raw.task.length + (raw.finalAnswer?.length ?? 0);
  for (const t of raw.tools) n += t.name.length + 80; // compact desc + schema, rough
  for (const s of raw.steps) n += (s.observation.text?.length ?? 0) + JSON.stringify(s.call).length;
  return n;
}

/** Light structural validation of a RawTrajectory (used for real-capture imports). */
export function validateRaw(raw: RawTrajectory, catalogNames: Set<string>): string[] {
  const errs: string[] = [];
  if (!raw.task?.trim()) errs.push("empty task");
  if (!raw.steps?.length) errs.push("no steps");
  if (!raw.tools?.length) errs.push("no tools offered");
  const offered = new Set(raw.tools.map((t) => t.name));
  raw.steps?.forEach((s, i) => {
    if (!s.call?.name) errs.push(`step ${i}: missing call name`);
    else {
      if (!catalogNames.has(s.call.name)) errs.push(`step ${i}: unknown tool ${s.call.name}`);
      if (!offered.has(s.call.name)) errs.push(`step ${i}: ${s.call.name} not in offered tools`);
    }
    if (typeof s.call?.arguments !== "object") errs.push(`step ${i}: arguments not an object`);
    if (typeof s.observation?.text !== "string") errs.push(`step ${i}: observation.text missing`);
  });
  return errs;
}
