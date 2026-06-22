// Prepare a HARNESS-NATIVE training dataset for silver:e4b.
//
// Unlike prepare.ts (which folds the Argent preamble + tools into the first user
// turn and emits <tool_call> TEXT — silver's bespoke format that does NOT transfer
// to a standard harness), this emits proper OpenAI-style chat: a system message
// (device rules), user turns, assistant turns with STRUCTURED tool_calls, and
// tool-role results, plus a `tools` JSON-schema list. mlx-lm's ChatDataset renders
// each via the gemma4 chat template WITH tools — i.e. tools declared in the system
// turn and tool calls as gemma4-native `<|tool_call>call:NAME{args}<tool_call|>` —
// which is EXACTLY what OpenCode/ollama send and what PARSER gemma4 parses. So the
// fine-tune transfers: silver becomes a true drop-in for gemma (same renderer +
// parser, only the weights differ).
//
//   node training/prepare-native.ts --n 2500 --valid 150 --out data-native

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RNG } from "../src/rng.ts";
import { generateTask } from "../src/tasks.ts";
import { solve } from "../src/expert.ts";
import { pickPersona, userTaskPhrase } from "../src/narrate.ts";
import { assemble, buildOfferedTools } from "../src/emit.ts";
import { Validator } from "../src/validate.ts";
import type { ToolSpec, Trajectory } from "../src/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const catalog: ToolSpec[] = JSON.parse(
  readFileSync(join(HERE, "..", "spec", "tools.json"), "utf8")
);
const validator = new Validator(catalog);
const OFFERED_TOOLS = +(process.argv[process.argv.indexOf("--tools") + 1] || 8); // tools offered per example

const NO_NARRATION = process.argv.includes("--no-narration");

// --realistic: train the model the way it is actually deployed.
//  (a) FIXED tool set every example (= the set the benchmark agent exposes), so the
//      model never sees an unfamiliar tool at inference and stops confabulating tool
//      names (a 8-random-tools-train vs 69-tools-infer mismatch caused that).
//  (b) Observations that match REAL argent: the gym otherwise appends a free
//      `[screenshot] "Title" showing: <elements>` to every result, so the model learns
//      to "see" the screen for free — but real argent returns an UNREADABLE image and a
//      path, so the only text screen-state is `describe`. We strip the free caption and,
//      for screen-changing tools, append argent's real `--- Screen after action ---`
//      note. The expert already calls describe before every tap, so trajectories stay
//      coherent; the model now learns the correct describe-then-tap loop.
const REALISTIC = process.argv.includes("--realistic");

// The fixed nav/interaction tool set (covers iOS-native, RN, Android, Chromium nav).
const FIXED_TOOL_NAMES = [
  "list-devices",
  "launch-app",
  "open-url",
  "describe",
  "gesture-tap",
  "gesture-swipe",
  "keyboard",
  "button",
  "screenshot",
  "stop-all-simulator-servers",
];
const FIXED_TOOLS: ToolSpec[] = FIXED_TOOL_NAMES.map(
  (n) => catalog.find((t) => t.name === n)!
).filter(Boolean);

// Nav-style task kinds the fixed tool set covers (drop profiling/flow/network kinds).
const NAV_KINDS = new Set([
  "navigate-tap",
  "toggle",
  "scroll-find",
  "deep-link",
  "hide-and-seek",
  "login",
  "android-setup",
  "chromium-tabs",
]);

// Tools that change the screen — real argent appends a screenshot after these.
const INTERACTION_TOOLS = new Set([
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

const SCENE_CAPTION = /\n\n\[screenshot\][\s\S]*$/; // the gym's free post-action caption

/** Rewrite tool observations to match what OpenCode + argent actually return. */
function realizeObservations(
  messages: {
    role: string;
    content?: string;
    tool_calls?: { id?: string; function: { name: string } }[];
    tool_call_id?: string;
  }[]
) {
  const idToName = new Map<string, string>();
  for (const m of messages)
    if (m.role === "assistant" && m.tool_calls)
      for (const c of m.tool_calls) if (c.id) idToName.set(c.id, c.function.name);
  let shot = 0;
  for (const m of messages) {
    if (m.role !== "tool" || typeof m.content !== "string") continue;
    const name = m.tool_call_id ? idToName.get(m.tool_call_id) : undefined;
    let c = m.content.replace(SCENE_CAPTION, ""); // drop the idealized free screen view
    if (name && INTERACTION_TOOLS.has(name))
      c += `\n\n--- Screen after action ---\n\nSaved: /tmp/argent/screen-${++shot}.png`;
    m.content = c;
  }
  return messages;
}

/** OpenAI-style {messages, tools} with tool_call arguments as OBJECTS (the gemma4
 *  chat template renders dicts, not JSON strings). */
function toNative(traj: Trajectory) {
  const messages = traj.messages.map((m) => {
    if (m.role === "assistant") {
      // With --no-narration, a tool-call turn carries ONLY the call (no prose), so the
      // model can't confuse mid-task narration with a narration-only final answer and
      // stop early. The final answer turn (no tool_calls) keeps its content.
      const content = NO_NARRATION && m.tool_calls ? "" : m.content || "";
      const out: Record<string, unknown> = { role: "assistant", content };
      if (m.tool_calls)
        out.tool_calls = m.tool_calls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.arguments },
        }));
      return out;
    }
    if (m.role === "tool")
      return { role: "tool", tool_call_id: m.tool_call_id, content: m.content };
    return { role: m.role, content: m.content };
  });
  const tools = traj.tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
  if (REALISTIC) realizeObservations(messages);
  return { messages, tools };
}

function genRow(seed: number) {
  const rng = new RNG(seed);
  const task = generateTask(rng);
  if (!task) return null;
  if (REALISTIC && !NAV_KINDS.has(task.kind)) return null; // nav-focused, fixed tool set
  const persona = pickPersona(rng, task.kind);
  const prompt = userTaskPhrase(rng, task.kind, persona, {
    app: task.app.name,
    platform: task.platform,
    target: task.pathLabels.at(-1),
    path: task.pathLabels.slice(0, -1).length ? task.pathLabels.slice(0, -1) : task.pathLabels,
    field: task.field,
  });
  const sr = solve(task, rng, prompt);
  // REALISTIC: same FIXED tool set every example (train == inference). Otherwise a
  // per-example used∪distractors sample. Either way the validator drops a trajectory
  // whose calls aren't all in the offered set.
  const offered = REALISTIC
    ? FIXED_TOOLS
    : buildOfferedTools(catalog, sr.toolsUsed, rng, OFFERED_TOOLS);
  if (REALISTIC && !sr.toolsUsed.every((n) => FIXED_TOOL_NAMES.includes(n))) return null;
  const traj = assemble(sr, task, seed, offered, persona);
  if (!validator.validate(traj).ok) return null;
  return toNative(traj);
}

function collect(base: number, count: number) {
  const rows: unknown[] = [];
  let k = 0;
  while (rows.length < count && k < count * 12 + 200) {
    const r = genRow(base + k);
    if (r) rows.push(r);
    k++;
  }
  return rows;
}

function main() {
  const argv = process.argv.slice(2);
  const get = (k: string, d: number) => {
    const i = argv.indexOf(k);
    return i >= 0 ? +argv[i + 1]! : d;
  };
  const outName = (() => {
    const i = argv.indexOf("--out");
    return i >= 0 ? argv[i + 1]! : "data-native";
  })();
  const n = get("--n", 2500);
  const valid = get("--valid", 150);
  const out = join(HERE, outName);
  mkdirSync(out, { recursive: true });
  const train = collect(1, n);
  const validRows = collect(2_000_000, valid);
  const w = (f: string, rows: unknown[]) =>
    writeFileSync(join(out, f), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  w("train.jsonl", train);
  w("valid.jsonl", validRows);
  console.log(`wrote ${train.length} train / ${validRows.length} valid -> ${out}`);
}

main();
