// Prepare an mlx-lm chat dataset (train/valid/test) for Gemma 2 2B from the gym.
//
//   node training/prepare.ts --n 4000 --valid 200 --test 200 --maxTokens 3000
//
// Each line is {"messages":[{role:user|assistant, content}...]} in Gemma's
// user/model shape (see emit.toGemmaMessages). Disjoint seed ranges keep
// train/valid/test from overlapping; the live eval harness (eval.ts) uses yet
// another range, so nothing the model is scored on was trained on.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RNG } from "../src/rng.ts";
import { generateTask } from "../src/tasks.ts";
import { solve } from "../src/expert.ts";
import { pickPersona, userTaskPhrase } from "../src/narrate.ts";
import { assemble, buildOfferedTools, toGemmaMessages } from "../src/emit.ts";
import { Validator } from "../src/validate.ts";
import type { ToolSpec } from "../src/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const catalog: ToolSpec[] = JSON.parse(readFileSync(join(HERE, "..", "spec", "tools.json"), "utf8"));
const validator = new Validator(catalog);
const OFFERED_TOOLS = 16; // tools shown per example during training

interface GemmaRow {
  messages: { role: "user" | "assistant"; content: string }[];
}

/** ~tokens, used only to filter over-long sequences so they don't get truncated. */
function approxTokens(row: GemmaRow): number {
  return Math.round(row.messages.reduce((a, m) => a + m.content.length, 0) / 3.6);
}

function genRow(seed: number, maxTokens: number): GemmaRow | null {
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
  // Lean tool list (used ∪ ~few distractors) keeps sequences short for the 2B.
  const traj = assemble(sr, task, seed, buildOfferedTools(catalog, sr.toolsUsed, rng, OFFERED_TOOLS), persona);
  if (!validator.validate(traj).ok) return null; // never ship invalid into training
  const row = toGemmaMessages(traj);
  if (approxTokens(row) > maxTokens) return null;
  return row;
}

function collect(baseSeed: number, count: number, maxTokens: number): GemmaRow[] {
  const rows: GemmaRow[] = [];
  let k = 0;
  const cap = count * 12 + 200;
  while (rows.length < count && k < cap) {
    const r = genRow(baseSeed + k, maxTokens);
    if (r) rows.push(r);
    k++;
  }
  return rows;
}

function parseArgs(argv: string[]) {
  const a = { n: 4000, valid: 200, test: 200, maxTokens: 3000, out: join(HERE, "data") };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === "--n") (a.n = +v!), i++;
    else if (k === "--valid") (a.valid = +v!), i++;
    else if (k === "--test") (a.test = +v!), i++;
    else if (k === "--maxTokens") (a.maxTokens = +v!), i++;
    else if (k === "--out") (a.out = v!), i++;
  }
  return a;
}

function writeJsonl(path: string, rows: GemmaRow[]) {
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

function lenStats(rows: GemmaRow[]) {
  const lens = rows.map(approxTokens).sort((a, b) => a - b);
  const turns = rows.map((r) => r.messages.length).sort((a, b) => a - b);
  return {
    tokens: { min: lens[0], median: lens[Math.floor(lens.length / 2)], max: lens[lens.length - 1] },
    turns: { min: turns[0], median: turns[Math.floor(turns.length / 2)], max: turns[turns.length - 1] },
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.out, { recursive: true });
  // Disjoint seed ranges per split.
  const train = collect(1, args.n, args.maxTokens);
  const valid = collect(2_000_000, args.valid, args.maxTokens);
  const test = collect(3_000_000, args.test, args.maxTokens);
  writeJsonl(join(args.out, "train.jsonl"), train);
  writeJsonl(join(args.out, "valid.jsonl"), valid);
  writeJsonl(join(args.out, "test.jsonl"), test);
  console.log(`wrote ${train.length} train / ${valid.length} valid / ${test.length} test -> ${args.out}`);
  console.log("train length stats:", JSON.stringify(lenStats(train)));
}

main();
