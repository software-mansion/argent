// Build the multi-harness training set: one RawTrajectory -> up to 4 rows (one per harness),
// from BOTH sources — the synthetic gym AND real-app captures — into a single shuffled
// {messages, tools} jsonl that mlx-lm trains via the gemma4 chat template.
//
//   node training/prepare-multi.ts --gym 2000 --real --valid 160 --out data-multi
//
// Flags: --gym N (gym trajectories before ×harness fan-out), --real (include
//        training/real-capture/*.json), --valid N, --out <dir under training/>,
//        --harnesses opencode,codex,... (default all 4), --narration (keep thoughts).

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RNG } from "../src/rng.ts";
import { generateTask } from "../src/tasks.ts";
import { solve } from "../src/expert.ts";
import { pickPersona, userTaskPhrase } from "../src/narrate.ts";
import { assemble } from "../src/emit.ts";
import { Validator } from "../src/validate.ts";
import { ARGENT_SYSTEM_PROMPT } from "../src/system-prompt.ts";
import { trajectoryToRaw, validateRaw } from "../src/raw.ts";
import type { RawTrajectory } from "../src/raw.ts";
import { render, HARNESSES } from "../harness/renderers.ts";
import type { HarnessName, NativeRecord } from "../harness/renderers.ts";
import type { ToolSpec } from "../src/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const catalog: ToolSpec[] = JSON.parse(readFileSync(join(HERE, "..", "spec", "tools.json"), "utf8"));
const byName = new Map(catalog.map((t) => [t.name, t]));
const catalogNames = new Set(catalog.map((t) => t.name));
const validator = new Validator(catalog);

// The nav/gesture tool surface offered every example (covers tap, swipe, scroll, pinch, rotate,
// drag, keyboard, button + RN debugger-tree + screenshot fallback). Superset of the old 8-tool
// set so the model can learn ALL gestures the user wants exercised. Must match the eval agent.
const NAV_SURFACE = [
  "list-devices", "launch-app", "open-url", "restart-app", "describe",
  "gesture-tap", "gesture-swipe", "gesture-scroll", "gesture-pinch", "gesture-rotate",
  "gesture-drag", "keyboard", "button", "screenshot", "debugger-component-tree",
];
const NAV_SURFACE_SPECS: ToolSpec[] = NAV_SURFACE.map((n) => byName.get(n)!).filter(Boolean);

// Nav-style gym task kinds (drop profiling/flow/network — out of the nav surface).
const NAV_KINDS = new Set([
  "navigate-tap", "toggle", "scroll-find", "deep-link", "hide-and-seek",
  "login", "android-setup", "chromium-tabs",
]);

/** offered tools = NAV_SURFACE ∪ any tool actually used (kept in catalog order). */
function offeredFor(used: string[]): ToolSpec[] {
  const names = new Set(NAV_SURFACE);
  for (const u of used) if (catalogNames.has(u)) names.add(u);
  return catalog.filter((t) => names.has(t.name));
}

/** One gym RawTrajectory (nav-focused), or null if filtered/invalid. */
function genGymRaw(seed: number): RawTrajectory | null {
  const rng = new RNG(seed);
  const task = generateTask(rng);
  if (!task || !NAV_KINDS.has(task.kind)) return null;
  const persona = pickPersona(rng, task.kind);
  const prompt = userTaskPhrase(rng, task.kind, persona, {
    app: task.app.name,
    platform: task.platform,
    target: task.pathLabels.at(-1),
    path: task.pathLabels.slice(0, -1).length ? task.pathLabels.slice(0, -1) : task.pathLabels,
    field: task.field,
  });
  const sr = solve(task, rng, prompt);
  const offered = offeredFor(sr.toolsUsed);
  if (!sr.toolsUsed.every((n) => catalogNames.has(n))) return null;
  const traj = assemble(sr, task, seed, offered, persona);
  if (!validator.validate(traj).ok) return null;
  const raw = trajectoryToRaw(traj);
  raw.tools = offered; // ensure full nav surface offered
  return raw;
}

function collectGym(base: number, count: number): RawTrajectory[] {
  const out: RawTrajectory[] = [];
  let k = 0;
  while (out.length < count && k < count * 12 + 500) {
    const r = genGymRaw(base + k);
    if (r) out.push(r);
    k++;
  }
  return out;
}

/** Load real-app captures, fill policy + offered tools, validate. */
function loadReal(): RawTrajectory[] {
  const dir = join(HERE, "real-capture");
  if (!existsSync(dir)) return [];
  const out: RawTrajectory[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    let arr: RawTrajectory[];
    try {
      arr = JSON.parse(readFileSync(join(dir, f), "utf8"));
    } catch (e) {
      console.error(`skip ${f}: ${(e as Error).message}`);
      continue;
    }
    if (!Array.isArray(arr)) arr = [arr];
    for (const raw of arr) {
      raw.policy = raw.policy || ARGENT_SYSTEM_PROMPT;
      const used = (raw.steps || []).map((s) => s.call?.name).filter(Boolean) as string[];
      raw.tools = offeredFor(used);
      const errs = validateRaw(raw, catalogNames);
      if (errs.length) {
        console.error(`drop real ${raw.meta?.id || f}: ${errs.slice(0, 3).join("; ")}`);
        continue;
      }
      out.push(raw);
    }
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const num = (k: string, d: number) => {
    const i = argv.indexOf(k);
    return i >= 0 ? +argv[i + 1]! : d;
  };
  const str = (k: string, d: string) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1]! : d;
  };
  const gymN = num("--gym", 2000);
  const validN = num("--valid", 160);
  const outName = str("--out", "data-multi");
  const narration = argv.includes("--narration");
  const includeReal = argv.includes("--real");
  const harnessList = (str("--harnesses", "").trim()
    ? str("--harnesses", "").split(",")
    : HARNESSES) as HarnessName[];

  const real = includeReal ? loadReal() : [];
  const gymTrain = collectGym(1, gymN);
  const gymValid = collectGym(5_000_000, validN);

  // real trajectories: hold out ~10% for valid
  const realShuffled = new RNG(42).shuffle(real.slice());
  const realValidCount = Math.min(Math.floor(real.length * 0.1), Math.max(0, real.length - 1));
  const realValid = realShuffled.slice(0, realValidCount);
  const realTrain = realShuffled.slice(realValidCount);

  const fan = (raws: RawTrajectory[]): NativeRecord[] =>
    raws.flatMap((r) => harnessList.map((h) => render(r, h, { narration })));

  const trainRecs = new RNG(7).shuffle([...fan(gymTrain), ...fan(realTrain)]);
  const validRecs = new RNG(8).shuffle([...fan(gymValid), ...fan(realValid)]);

  const out = join(HERE, outName);
  mkdirSync(out, { recursive: true });
  const write = (file: string, recs: NativeRecord[]) =>
    writeFileSync(
      join(out, file),
      recs.map((r) => JSON.stringify({ messages: r.messages, tools: r.tools })).join("\n") + "\n"
    );
  write("train.jsonl", trainRecs);
  write("valid.jsonl", validRecs);

  // stats
  const byH: Record<string, number> = {};
  for (const r of [...trainRecs, ...validRecs]) byH[r._harness!] = (byH[r._harness!] || 0) + 1;
  const stats = {
    out,
    harnesses: harnessList,
    sources: { gym_train: gymTrain.length, gym_valid: gymValid.length, real_train: realTrain.length, real_valid: realValid.length },
    rows: { train: trainRecs.length, valid: validRecs.length },
    per_harness_rows: byH,
  };
  writeFileSync(join(out, "stats.json"), JSON.stringify(stats, null, 2));
  console.log(JSON.stringify(stats, null, 2));
}

main();
