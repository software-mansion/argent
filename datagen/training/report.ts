// Build a base-vs-tuned comparison table from the eval run JSONs.
//   node training/report.ts            -> prints table + writes runs/RESULTS.md

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const runs = join(HERE, "runs");

function load(label: string): Record<string, unknown> | null {
  const p = join(runs, `eval-${label}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")).summary : null;
}

const base = load("base");
const tuned = load("tuned");
if (!base || !tuned) {
  console.error("need both runs/eval-base.json and runs/eval-tuned.json");
  process.exit(1);
}

const METRICS: [string, string, "up" | "down"][] = [
  ["nav_success_pct", "Navigation success %", "up"],
  ["schema_valid_pct", "Schema-valid calls %", "up"],
  ["grounded_tap_pct", "Grounded taps %", "up"],
  ["avg_calls_per_ep", "Avg tool calls / episode", "up"],
  ["policy_violations_per_ep", "Policy violations / episode", "down"],
  ["clean_finish_pct", "Clean finish (no attempt) %", "down"],
];

const rows = METRICS.map(([k, label]) => {
  const b = Number((base as Record<string, number>)[k] ?? 0);
  const t = Number((tuned as Record<string, number>)[k] ?? 0);
  const delta = Math.round((t - b) * 10) / 10;
  return `| ${label} | ${b} | ${t} | ${delta >= 0 ? "+" : ""}${delta} |`;
});

const md =
  `# Gemma 2 2B — base vs gym-tuned (eval through the gym)\n\n` +
  `Held-out tasks (seeds 5,000,000+), greedy decoding.\n` +
  `Base: \`${(base as { episodes?: number }).episodes ?? "?"}\` eps · Tuned: \`${(tuned as { episodes?: number }).episodes ?? "?"}\` eps.\n\n` +
  `| metric | base | tuned | Δ |\n|---|---|---|---|\n${rows.join("\n")}\n\n` +
  `## Navigation success by task kind\n\n` +
  `- base: \`${JSON.stringify((base as Record<string, unknown>).nav_success_by_kind)}\`\n` +
  `- tuned: \`${JSON.stringify((tuned as Record<string, unknown>).nav_success_by_kind)}\`\n`;

writeFileSync(join(runs, "RESULTS.md"), md);
console.log(md);
