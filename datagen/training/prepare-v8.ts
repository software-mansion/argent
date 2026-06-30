// Build the silver-v8 training set. Fixes the 3 data faults that drove v7's real-harness regression
// (measured by verify_v8_reqs.py on ds-longctx):
//
//   R2  distribution must span 30-80k (v7 was a narrow 30-39k spike — no upper range).
//       FIX: vary spam volume (system 16-30k tok) + grow/vary tool-output (describe) size per row,
//            with real-capture trajectories (real describes up to 41k chars) supplying the fat tail.
//   R3  hermes<=10%, codex<=20% (v7 was a flat 25/25/25/25 — renderAll fanned all 4 per trajectory).
//       FIX: sample ONE harness per trajectory by realistic weight. This also QUADRUPLES row-level
//            task uniqueness (1 row/traj instead of 4 identical-task rows).
//   R4  minimize duplication (v7 was 18.4% unique; top task repeated 92x).
//       FIX: single-harness sampling + a hard per-task row cap.
//
// Plus the confirmed v7 failure-mode fix (trajectory-prefix overfitting): VARY THE START STATE —
//   cold (list-devices->boot->launch->describe), warm-device (already booted), warm-app (already
//   foregrounded -> first action is describe). Teaches inspect-first / boot-only-if-needed.
//
//   node training/prepare-v8.ts --gym 6000 --real --valid 200 --out data-v8
//
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RNG } from "../src/rng.ts";
import { generateTask } from "../src/tasks.ts";
import { solve } from "../src/expert.ts";
import { pickPersona, userTaskPhrase } from "../src/narrate.ts";
import { assemble } from "../src/emit.ts";
import { Validator } from "../src/validate.ts";
import { trajectoryToRaw, validateRaw, capObservations } from "../src/raw.ts";
import type { RawTrajectory } from "../src/raw.ts";
import { render, HARNESSES } from "../harness/renderers.ts";
import type { HarnessName, NativeRecord } from "../harness/renderers.ts";
import type { ToolSpec } from "../src/types.ts";

// v9 experiment: --narration keeps each step's reasoning (step.thought) in the assistant turn, so the
// completion-only mask trains "think-then-act" instead of bare tool calls. Default off = v8 behavior.
const NARRATION = process.argv.includes("--narration");
const LITE = process.argv.includes("--lite");  // small-spam + compact-desc short rows for cheap test runs
if (!LITE) process.env.ARGENT_RICH_DESC = "1"; // verbose tools (real harness); lite uses compact for speed

const HERE = dirname(fileURLToPath(import.meta.url));
const catalog: ToolSpec[] = JSON.parse(readFileSync(join(HERE, "..", "spec", "tools.json"), "utf8"));
const byName = new Map(catalog.map((t) => [t.name, t]));
const catalogNames = new Set(catalog.map((t) => t.name));
const validator = new Validator(catalog);

// ---- harness mix (R3): weighted single-render. opencode+claude-code dominate (the harnesses real
//      users run); codex<=20%, hermes<=10% per the requirement. ----
const HARNESS_WEIGHTS: [HarnessName, number][] = [
  ["opencode", 0.4],
  ["claude-code", 0.35],
  ["codex", 0.17],
  ["hermes", 0.08],
];
function sampleHarness(rng: RNG): HarnessName {
  let x = rng.next();
  for (const [h, w] of HARNESS_WEIGHTS) if ((x -= w) <= 0) return h;
  return "opencode";
}

// ---- spam / context (R2 system-side variance). The provider prompt + the see-and-ignore noise a
//      real session carries (skills list, CLAUDE.md/AGENTS.md, persistent memory, builtins). Always
//      include the full set once (~16k-tok floor so every row clears 30k), then 0-4 extra blocks +
//      maybe a 2nd provider prompt for the power-user fat tail (~30k). The model must navigate THROUGH
//      this to still pick the argent tool. ----
const PROMPT_POOL = readdirSync(join(HERE, "..", "harness", "prompts"))
  .filter((f) => f.endsWith(".txt"))
  .map((f) => readFileSync(join(HERE, "..", "harness", "prompts", f), "utf8"));
const CTX_BLOCKS = [
  join(HERE, "..", "harness", "skills.txt"),
  ...readdirSync(join(HERE, "..", "harness", "context"))
    .filter((f) => f.endsWith(".txt"))
    .map((f) => join(HERE, "..", "harness", "context", f)),
]
  .filter(existsSync)
  .map((f) => readFileSync(f, "utf8"));

// Sample a target system size (chars) so system tokens spread ~16k-38k smoothly: always the full
// block set once (the ~16k-tok floor that keeps the system+tools preamble >=30k), then keep appending
// random blocks until the sampled target is reached (the heavy-skill-spam power user). gemma ~3.9 ch/tok
// -> [62k, 150k] chars ~= [16k, 38k] tok.
function assembleContext(rng: RNG): string {
  // lite: just a provider prompt + one context block (cheap short rows); full: the whole spam set.
  const parts = LITE ? [rng.pick(PROMPT_POOL), rng.pick(CTX_BLOCKS)] : [rng.pick(PROMPT_POOL), ...rng.shuffle(CTX_BLOCKS)];
  let len = parts.reduce((a, p) => a + p.length + 8, 0);
  // --lite: small spam target (~8-15k-token rows) for cheap, fast test runs that isolate a recipe change.
  // otherwise: 70% moderate spam, 30% heavy -> the real 30-80k distribution.
  const target = LITE
    ? rng.range(20000, 45000)
    : rng.bool(0.7) ? rng.range(70000, 140000) : rng.range(140000, 205000);
  while (len < target) {
    const b = rng.bool(0.3) ? rng.pick(PROMPT_POOL) : rng.pick(CTX_BLOCKS);
    parts.push(b);
    len += b.length + 8;
  }
  return parts.join("\n\n---\n\n");
}

// ---- offered tools: the (near-)full catalog, verbose, like a real harness. Vary the count a little
//      so the model doesn't key on an exact catalog size. ----
function offeredTools(rng: RNG, used: string[]): ToolSpec[] {
  const keep = new Set<string>(used.filter((u) => catalogNames.has(u)));
  const targetN = rng.range(58, catalog.length);
  const pool = rng.shuffle(catalog.filter((t) => !keep.has(t.name)));
  for (const t of pool.slice(0, Math.max(0, targetN - keep.size))) keep.add(t.name);
  return catalog.filter((t) => keep.has(t.name)); // catalog order
}

// ---- start-state variation (the v7 failure-mode fix). Strip the leading setup steps so a fraction
//      of rows begin already-booted / already-foregrounded. ----
type Start = "cold" | "warm_device" | "warm_app";
const SETUP_DEVICE = new Set(["list-devices", "boot-device"]);
const SETUP_APP = new Set([
  "list-devices", "boot-device", "launch-app", "open-url", "restart-app", "reinstall-app", "debugger-status",
]);
function sampleStart(rng: RNG): Start {
  const x = rng.next();
  if (x < 0.35) return "cold";
  if (x < 0.55) return "warm_device";
  return "warm_app";
}
function stripStart(raw: RawTrajectory, mode: Start): RawTrajectory {
  if (mode === "cold") return raw;
  const drop = mode === "warm_device" ? SETUP_DEVICE : SETUP_APP;
  let i = 0;
  while (i < raw.steps.length - 1 && drop.has(raw.steps[i]!.call.name)) i++;
  if (i === 0) return raw; // nothing strippable -> effectively cold
  return { ...raw, steps: raw.steps.slice(i) };
}

// ---- per-row describe (tool-output) budget (R2 conversation-side variance). Most rows lean; a long
//      tail keeps big real AX trees, which is what pushes real-capture rows into 50-80k. ----
function describeBudget(rng: RNG): number {
  // skew toward small with a heavy tail; the tail keeps big real AX trees (real describes reach
  // ~41k chars) so genuine tool-output bulk also contributes to the 50-80k rows.
  return rng.bool(0.55) ? rng.range(1200, 3500) : rng.range(3500, 46000);
}

const clone = (raw: RawTrajectory): RawTrajectory => JSON.parse(JSON.stringify(raw));

/** One neutral gym trajectory (nav-focused), policy/tools filled later per-row. */
const NAV_KINDS = new Set([
  "navigate-tap", "toggle", "scroll-find", "deep-link", "hide-and-seek", "login", "android-setup", "chromium-tabs",
]);
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
  if (!sr.toolsUsed.every((n) => catalogNames.has(n))) return null;
  // Offer the full catalog at assemble/validate time (used tools are a subset, so validation passes);
  // buildRow() reassigns raw.tools to a per-row sampled surface anyway.
  const traj = assemble(sr, task, seed, catalog, persona);
  if (!validator.validate(traj).ok) return null;
  return trajectoryToRaw(traj);
}

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
      const used = (raw.steps || []).map((s) => s.call?.name).filter(Boolean) as string[];
      raw.tools = catalog.filter((t) => used.includes(t.name)); // placeholder; offeredTools() reassigns
      const errs = validateRaw(raw, catalogNames);
      if (errs.length) continue;
      out.push(raw);
    }
  }
  return out;
}

/** Render one trajectory into a v8 training row (sampled harness/spam/start/budget). */
function buildRow(src: RawTrajectory, rng: RNG): NativeRecord {
  const raw = clone(src);
  const used = raw.steps.map((s) => s.call.name);
  raw.policy = assembleContext(rng);
  raw.tools = offeredTools(rng, used);
  const stripped = stripStart(raw, sampleStart(rng));
  const capped = capObservations(stripped, describeBudget(rng));
  return render(capped, sampleHarness(rng), { narration: NARRATION });
}

const taskOf = (r: NativeRecord) =>
  (r.messages.find((m) => m.role === "user")?.content ?? "").trim();

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
  const gymAttempts = num("--gym", 6000);
  const validN = num("--valid", 200);
  const outName = str("--out", "data-v8");
  const realRenders = num("--real-renders", 3); // render each real trajectory N times (augmentation)
  const maxPerTask = num("--max-per-task", 2); // R4: hard cap on identical-task rows

  // ---- gather neutral trajectories ----
  const gymRng = new RNG(1);
  const gym: RawTrajectory[] = [];
  for (let k = 0; k < gymAttempts; k++) {
    const r = genGymRaw(1 + k);
    if (r) gym.push(r);
  }
  const real = argv.includes("--real") ? loadReal() : [];
  console.error(`gym trajectories: ${gym.length} (from ${gymAttempts} attempts) | real: ${real.length}`);

  // ---- build rows: gym x1, real xN (real has the big describes -> the fat tail) ----
  const rowRng = new RNG(99);
  const candidates: NativeRecord[] = [];
  for (const g of gym) candidates.push(buildRow(g, rowRng));
  for (let n = 0; n < realRenders; n++) for (const r of real) candidates.push(buildRow(r, rowRng));

  // ---- R4: cap identical-task rows ----
  const seen = new Map<string, number>();
  const kept: NativeRecord[] = [];
  for (const r of new RNG(7).shuffle(candidates)) {
    const t = taskOf(r);
    const c = (seen.get(t) ?? 0) + 1;
    if (c > maxPerTask) continue;
    seen.set(t, c);
    kept.push(r);
  }

  // ---- split valid (disjoint by task so no train/valid task leakage) ----
  const shuffled = new RNG(8).shuffle(kept);
  const valid = shuffled.slice(0, validN);
  const validTasks = new Set(valid.map(taskOf));
  const train = shuffled.slice(validN).filter((r) => !validTasks.has(taskOf(r)));

  const out = join(HERE, outName);
  mkdirSync(out, { recursive: true });
  const write = (file: string, recs: NativeRecord[]) =>
    writeFileSync(
      join(out, file),
      recs.map((r) => JSON.stringify({ messages: r.messages, tools: r.tools })).join("\n") + "\n"
    );
  write("train.jsonl", train);
  write("valid.jsonl", valid);

  const byH: Record<string, number> = {};
  for (const r of train) byH[r._harness!] = (byH[r._harness!] || 0) + 1;
  const uniqTasks = new Set(train.map(taskOf)).size;
  const stats = {
    out,
    rows: { train: train.length, valid: valid.length, candidates: candidates.length, kept: kept.length },
    unique_tasks_train: uniqTasks,
    unique_pct_train: Math.round((1000 * uniqTasks) / Math.max(1, train.length)) / 10,
    per_harness_train: byH,
    sources: { gym: gym.length, real: real.length, real_renders: realRenders, max_per_task: maxPerTask },
  };
  writeFileSync(join(out, "stats.json"), JSON.stringify(stats, null, 2));
  console.log(JSON.stringify(stats, null, 2));
}

main();
