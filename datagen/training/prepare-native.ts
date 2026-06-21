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

/** OpenAI-style {messages, tools} with tool_call arguments as OBJECTS (the gemma4
 *  chat template renders dicts, not JSON strings). */
function toNative(traj: Trajectory) {
  const messages = traj.messages.map((m) => {
    if (m.role === "assistant") {
      const out: Record<string, unknown> = { role: "assistant", content: m.content || "" };
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
  return { messages, tools };
}

function genRow(seed: number) {
  const rng = new RNG(seed);
  const task = generateTask(rng);
  if (!task) return null;
  const persona = pickPersona(rng, task.kind);
  const prompt = userTaskPhrase(rng, task.kind, persona, {
    app: task.app.name,
    platform: task.platform,
    target: task.pathLabels.at(-1),
    path: task.pathLabels.slice(0, -1).length ? task.pathLabels.slice(0, -1) : task.pathLabels,
    field: task.field,
  });
  const sr = solve(task, rng, prompt);
  const traj = assemble(
    sr,
    task,
    seed,
    buildOfferedTools(catalog, sr.toolsUsed, rng, OFFERED_TOOLS),
    persona
  );
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
