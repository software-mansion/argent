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
import { trajectoryToRaw, validateRaw, capObservations, rawCharLen } from "../src/raw.ts";
import type { RawTrajectory } from "../src/raw.ts";
import { render, HARNESSES } from "../harness/renderers.ts";
import type { HarnessName, NativeRecord } from "../harness/renderers.ts";
import type { ToolSpec } from "../src/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const catalog: ToolSpec[] = JSON.parse(readFileSync(join(HERE, "..", "spec", "tools.json"), "utf8"));
const byName = new Map(catalog.map((t) => [t.name, t]));
const catalogNames = new Set(catalog.map((t) => t.name));
const validator = new Validator(catalog);

// Lean fixed CORE offered every example; offeredFor() adds any tool the trajectory actually uses
// (open-url, restart-app, gesture-pinch, debugger-component-tree, screenshot, …). Per-trajectory
// lean (~8-11 tools) instead of a fixed 15 halves the tool token overhead (15 tools ≈ 2073 tok =
// 45% of SEQ) so multi-describe trajectories fit SEQ 4608.
const NAV_SURFACE = [
  "list-devices", "launch-app", "describe",
  "gesture-tap", "gesture-swipe", "gesture-scroll", "keyboard", "button",
];
const NAV_SURFACE_SPECS: ToolSpec[] = NAV_SURFACE.map((n) => byName.get(n)!).filter(Boolean);

// Rich mode (--rich): a WIDER surface that includes the tools the model confused/hallucinated in
// prod (button→appSwitch, restart-app/open-url for recovery, boot-device for the opening sequence),
// rendered WITH full descriptions (ARGENT_RICH_DESC) so the bundle-id/enum facts survive. Closes the
// lean→fat gap within the 8K T4 budget. Lean mode keeps the 8-tool NAV_SURFACE.
const RICH_SURFACE = [
  "list-devices", "boot-device", "launch-app", "restart-app", "open-url", "describe",
  "gesture-tap", "gesture-swipe", "gesture-scroll", "gesture-pinch", "button", "keyboard", "screenshot",
];
const RICH = process.argv.includes("--rich");                    // --rich = WIDE tool surface
// verbose descriptions add ~4.4K tok/row → OOMs the 16GB T4 AND likely mismatches real harness
// disclosure (harnesses compact/defer descriptions). So gate verbose behind a separate flag; --rich
// alone now means wide surface + COMPACT descriptions (facts come from gym demonstrations).
if (process.argv.includes("--verbose-desc")) process.env.ARGENT_RICH_DESC = "1";
const SURFACE = RICH ? RICH_SURFACE : NAV_SURFACE;

// --longctx: produce LONG (10-20K tok) rows so the model trains on real-harness-scale context.
// Lever = the tool surface: full 67-tool catalog verbose ≈ 17K tok. Pad each trajectory's offered
// surface to a per-row target sampled in [30, catalog] -> a fair spread across the 10-20K band.
// (Verbose descs ON; the actual harness system prompts aren't available as text, so the catalog is
// the legitimate length source — and it mirrors the real harnesses, which DO disclose the full catalog.)
const LONGCTX = process.argv.includes("--longctx");
if (LONGCTX) process.env.ARGENT_RICH_DESC = "1";
const padRng = new RNG(7);
// Real OpenCode provider system prompts (2-4K tok each) vendored under harness/prompts/. In --longctx we
// swap the small ARGENT_SYSTEM_PROMPT for one of these per row -> realistic large prompts + length + the
// variety that makes the model robust to ANY harness's big prompt (the gap that broke it at 55K).
const PROMPT_POOL: string[] = LONGCTX
  ? readdirSync(join(HERE, "..", "harness", "prompts"))
      .filter((f) => f.endsWith(".txt"))
      .map((f) => readFileSync(join(HERE, "..", "harness", "prompts", f), "utf8"))
  : [];
// The real harness system prompt is NOT just the provider prompt — it bundles the built-in tool catalog,
// the skills list, the project/global instructions (CLAUDE.md/AGENTS.md), and the persistent memory. That
// bulk (the "see-and-ignore" noise the model must navigate to still pick the argent tool) is what makes a
// real session 40-58K. Assemble all of it per row so rows reach real-harness scale.
const CTX_BLOCKS: string[] = LONGCTX
  ? [join(HERE, "..", "harness", "skills.txt"),
     ...readdirSync(join(HERE, "..", "harness", "context"))
         .filter((f) => f.endsWith(".txt"))
         .map((f) => join(HERE, "..", "harness", "context", f))]
      .filter(existsSync)
      .map((f) => readFileSync(f, "utf8"))
  : [];
function assembleContext(rng: RNG): string {
  return [rng.pick(PROMPT_POOL), ...rng.shuffle(CTX_BLOCKS)].join("\n\n---\n\n");
}
function padSurface(offered: ToolSpec[], rng: RNG): ToolSpec[] {
  const targetN = rng.range(55, catalog.length);
  if (offered.length >= targetN) return offered;
  const have = new Set(offered.map((t) => t.name));
  const pool = rng.shuffle(catalog.filter((t) => !have.has(t.name)));
  const add = new Set(pool.slice(0, targetN - offered.length).map((t) => t.name));
  return catalog.filter((t) => have.has(t.name) || add.has(t.name)); // keep catalog order
}

// Nav-style gym task kinds (drop profiling/flow/network — out of the nav surface).
const NAV_KINDS = new Set([
  "navigate-tap", "toggle", "scroll-find", "deep-link", "hide-and-seek",
  "login", "android-setup", "chromium-tabs",
]);

/** offered tools = NAV_SURFACE ∪ any tool actually used (kept in catalog order). */
function offeredFor(used: string[]): ToolSpec[] {
  const names = new Set(SURFACE);
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
  let offered = offeredFor(sr.toolsUsed);
  if (LONGCTX) offered = padSurface(offered, rng);
  if (!sr.toolsUsed.every((n) => catalogNames.has(n))) return null;
  const traj = assemble(sr, task, seed, offered, persona);
  if (!validator.validate(traj).ok) return null;
  const raw = trajectoryToRaw(traj);
  raw.tools = offered; // ensure full nav surface offered
  if (LONGCTX) raw.policy = assembleContext(rng);
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
      raw.policy = LONGCTX ? assembleContext(padRng) : (raw.policy || ARGENT_SYSTEM_PROMPT);
      const used = (raw.steps || []).map((s) => s.call?.name).filter(Boolean) as string[];
      raw.tools = LONGCTX ? padSurface(offeredFor(used), padRng) : offeredFor(used);
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

  // Cap long describe observations (grounding-aware), then drop the rare trajectory still over
  // the SEQ budget so nothing trains truncated. ~9000 chars ≈ p99 ~4250 tokens after rendering.
  // longctx: rows are 10-20K tok (~40-80K chars) by design; let the Python kernel token-filter precisely.
  const MAX_RAW_CHARS = LONGCTX ? 240000 : RICH ? 100000 : 9000;
  let dropped = 0;
  const fan = (raws: RawTrajectory[]): NativeRecord[] => {
    const fit = raws
      .map((r) => capObservations(r, 1000))
      .filter((r) => {
        if (rawCharLen(r) <= MAX_RAW_CHARS) return true;
        dropped++;
        return false;
      });
    return fit.flatMap((r) => harnessList.map((h) => render(r, h, { narration })));
  };

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
    dropped_over_seq: dropped,
    per_harness_rows: byH,
  };
  writeFileSync(join(out, "stats.json"), JSON.stringify(stats, null, 2));
  console.log(JSON.stringify(stats, null, 2));
}

main();
