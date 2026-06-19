// CLI: generate a validated dataset of Argent tool-use trajectories.
//
//   node src/generate.ts --n 500 --seed 1 --out out
//
// Every emitted trajectory has passed schema, structural, device-order,
// policy, and coordinate-grounding validation. Rejects are written with their
// reasons so failures are auditable, never silently dropped.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RNG } from "./rng.ts";
import { generateTask, type TaskSpec } from "./tasks.ts";
import { solve } from "./expert.ts";
import { userTaskPhrase } from "./narrate.ts";
import { assemble, buildOfferedTools, toOpenAI, toShareGPT } from "./emit.ts";
import { Validator } from "./validate.ts";
import type { ToolSpec, Trajectory } from "./types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

interface Args {
  n: number;
  seed: number;
  out: string;
  evalN: number;
  emit: string[];
  samples: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    n: 200,
    seed: 1,
    out: join(HERE, "..", "out"),
    evalN: 40,
    emit: ["openai", "sharegpt"],
    samples: 4,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === "--n") ((a.n = +v!), i++);
    else if (k === "--seed") ((a.seed = +v!), i++);
    else if (k === "--out") ((a.out = v!), i++);
    else if (k === "--evalN") ((a.evalN = +v!), i++);
    else if (k === "--samples") ((a.samples = +v!), i++);
    else if (k === "--emit") ((a.emit = v!.split(",")), i++);
  }
  return a;
}

function loadCatalog(): ToolSpec[] {
  return JSON.parse(readFileSync(join(HERE, "..", "spec", "tools.json"), "utf8"));
}

interface GenOutcome {
  traj?: Trajectory;
  task?: TaskSpec;
  errors?: string[];
}

function generateOne(seed: number, catalog: ToolSpec[], validator: Validator): GenOutcome {
  const rng = new RNG(seed);
  const task = generateTask(rng);
  if (!task) return {};
  const prompt = userTaskPhrase(rng, task.kind, {
    app: task.app.name,
    platform: task.platform,
    target: task.pathLabels.at(-1),
    path: task.pathLabels.slice(0, -1).length ? task.pathLabels.slice(0, -1) : task.pathLabels,
    field: task.field,
  });
  const solveResult = solve(task, rng, prompt);
  const offered = buildOfferedTools(catalog, solveResult.toolsUsed, rng);
  const traj = assemble(solveResult, task, seed, offered);
  const result = validator.validate(traj);
  if (!result.ok) return { task, errors: result.errors };
  return { traj, task };
}

function collect(
  label: string,
  baseSeed: number,
  count: number,
  catalog: ToolSpec[],
  validator: Validator
) {
  const accepted: Trajectory[] = [];
  const failures: { seed: number; kind?: string; errors: string[] }[] = [];
  let k = 0;
  const maxAttempts = count * 8 + 50;
  while (accepted.length < count && k < maxAttempts) {
    const seed = baseSeed + k;
    k++;
    const out = generateOne(seed, catalog, validator);
    if (out.traj) accepted.push(out.traj);
    else if (out.errors) failures.push({ seed, kind: out.task?.kind, errors: out.errors });
  }
  return { label, accepted, failures, attempts: k };
}

function computeStats(records: Trajectory[], catalog: ToolSpec[]) {
  const byKind: Record<string, number> = {};
  const byPlatform: Record<string, number> = {};
  const byDifficulty: Record<string, number> = {};
  const toolUse = new Map<string, number>();
  const lengths: number[] = [];
  let recovery = 0;
  let totalCalls = 0;
  for (const r of records) {
    byKind[r.meta.task_type] = (byKind[r.meta.task_type] ?? 0) + 1;
    byPlatform[r.meta.platform] = (byPlatform[r.meta.platform] ?? 0) + 1;
    byDifficulty[r.meta.difficulty] = (byDifficulty[r.meta.difficulty] ?? 0) + 1;
    if (r.meta.has_recovery) recovery++;
    totalCalls += r.meta.n_tool_calls;
    lengths.push(r.meta.n_tool_calls);
    for (const m of r.messages) {
      if (m.role === "assistant" && m.tool_calls)
        for (const c of m.tool_calls) toolUse.set(c.name, (toolUse.get(c.name) ?? 0) + 1);
    }
  }
  lengths.sort((a, b) => a - b);
  const median = lengths.length ? lengths[Math.floor(lengths.length / 2)] : 0;
  const distinctTools = [...toolUse.keys()];
  return {
    count: records.length,
    distinct_tools_used: distinctTools.length,
    catalog_tools: catalog.length,
    tool_coverage_pct: Math.round((distinctTools.length / catalog.length) * 1000) / 10,
    avg_tool_calls: Math.round((totalCalls / Math.max(1, records.length)) * 10) / 10,
    median_tool_calls: median,
    min_tool_calls: lengths[0] ?? 0,
    max_tool_calls: lengths[lengths.length - 1] ?? 0,
    recovery_pct: Math.round((recovery / Math.max(1, records.length)) * 1000) / 10,
    by_task_type: byKind,
    by_platform: byPlatform,
    by_difficulty: byDifficulty,
    tool_frequency: Object.fromEntries([...toolUse.entries()].sort((a, b) => b[1] - a[1])),
    tools_never_used: catalog.map((t) => t.name).filter((n) => !toolUse.has(n)),
  };
}

function renderSampleMarkdown(traj: Trajectory): string {
  const lines: string[] = [
    `### ${traj.meta.id}  \`${traj.meta.task_type}/${traj.meta.platform}/${traj.meta.difficulty}\``,
    "",
  ];
  lines.push(
    `_tools offered: ${traj.tools.length} · tool calls: ${traj.meta.n_tool_calls} · recovery: ${traj.meta.has_recovery}_`,
    ""
  );
  for (const m of traj.messages) {
    if (m.role === "system") continue;
    if (m.role === "user") lines.push(`**user:** ${m.content}`, "");
    else if (m.role === "assistant") {
      if (m.content) lines.push(`**assistant:** ${m.content}`);
      if (m.tool_calls)
        for (const c of m.tool_calls)
          lines.push("```tool_call\n" + c.name + " " + JSON.stringify(c.arguments) + "\n```");
      lines.push("");
    } else if (m.role === "tool") {
      const short = m.content.length > 600 ? m.content.slice(0, 600) + " …" : m.content;
      lines.push("```tool_result (" + m.name + ")\n" + short + "\n```", "");
    }
  }
  return lines.join("\n");
}

function writeJsonl(path: string, rows: unknown[]) {
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const catalog = loadCatalog();
  const validator = new Validator(catalog);
  mkdirSync(args.out, { recursive: true });

  const train = collect("train", args.seed, args.n, catalog, validator);
  // Eval split: disjoint seed range so no overlap with train.
  const evalSet =
    args.evalN > 0 ? collect("eval", args.seed + 1_000_000, args.evalN, catalog, validator) : null;

  // normalized JSONL
  writeJsonl(join(args.out, "train.jsonl"), train.accepted);
  if (evalSet) writeJsonl(join(args.out, "eval.jsonl"), evalSet.accepted);

  // format conversions
  if (args.emit.includes("openai"))
    writeJsonl(join(args.out, "train.openai.jsonl"), train.accepted.map(toOpenAI));
  if (args.emit.includes("sharegpt"))
    writeJsonl(join(args.out, "train.sharegpt.jsonl"), train.accepted.map(toShareGPT));

  // failures (auditable)
  const allFailures = [...train.failures, ...(evalSet?.failures ?? [])];
  writeJsonl(join(args.out, "failures.jsonl"), allFailures);

  // stats
  const stats = {
    train: computeStats(train.accepted, catalog),
    eval: evalSet ? computeStats(evalSet.accepted, catalog) : null,
    generation: {
      train_accepted: train.accepted.length,
      train_attempts: train.attempts,
      train_pass_rate_pct:
        Math.round(
          (train.accepted.length /
            Math.max(1, train.attempts - train.failures.length + train.accepted.length)) *
            1000
        ) / 10,
      train_rejected: train.failures.length,
      eval_accepted: evalSet?.accepted.length ?? 0,
      eval_rejected: evalSet?.failures.length ?? 0,
    },
  };
  writeFileSync(join(args.out, "stats.json"), JSON.stringify(stats, null, 2));

  // samples
  const sampleRecords = train.accepted.slice(0, args.samples);
  writeFileSync(
    join(args.out, "samples.md"),
    `# Sample trajectories\n\n` + sampleRecords.map(renderSampleMarkdown).join("\n---\n\n")
  );

  // console summary
  const rejected = train.failures.length + (evalSet?.failures.length ?? 0);
  console.log(`\n=== Argent datagen ===`);
  console.log(
    `train: ${train.accepted.length} accepted / ${train.attempts} attempts (${train.failures.length} rejected)`
  );
  if (evalSet)
    console.log(`eval:  ${evalSet.accepted.length} accepted (${evalSet.failures.length} rejected)`);
  console.log(`rejected total: ${rejected}`);
  console.log(
    `tool coverage: ${stats.train.distinct_tools_used}/${catalog.length} (${stats.train.tool_coverage_pct}%)`
  );
  console.log(
    `avg tool calls/traj: ${stats.train.avg_tool_calls}  (median ${stats.train.median_tool_calls}, max ${stats.train.max_tool_calls})`
  );
  console.log(`recovery trajectories: ${stats.train.recovery_pct}%`);
  console.log(`task types:`, stats.train.by_task_type);
  console.log(`platforms:`, stats.train.by_platform);
  if (rejected > 0) {
    console.log(`\nFirst few rejections:`);
    for (const f of allFailures.slice(0, 5))
      console.log(`  seed=${f.seed} kind=${f.kind}: ${f.errors[0]}`);
  }
  console.log(
    `\nwrote -> ${args.out}/{train.jsonl, eval.jsonl, train.openai.jsonl, train.sharegpt.jsonl, stats.json, samples.md, failures.jsonl}`
  );
}

main();
