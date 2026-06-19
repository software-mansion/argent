// Eval-through-gym: drive a model through the Argent gym on held-out tasks and
// score it with the same validators the dataset is built with. The gym and
// validators (the source of truth) live here in TS; a persistent Python process
// (serve.py) only generates text. This makes "did the gym teach anything?" a
// measurable question: schema-valid %, grounded-tap %, policy violations, and
// navigation task-success — base model vs fine-tuned.
//
//   node training/eval.ts --model <hf-id> [--adapter <dir>] --n 120 --label base
//
// Held-out seeds (5_000_000+) are disjoint from train/valid/test.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RNG } from "../src/rng.ts";
import { generateTask, type TaskSpec } from "../src/tasks.ts";
import { solve } from "../src/expert.ts";
import { pickPersona, userTaskPhrase } from "../src/narrate.ts";
import { buildOfferedTools, buildGemmaFirstUser, compactObservation } from "../src/emit.ts";
import { ARGENT_POLICY_COMPACT } from "../src/system-prompt.ts";
import { Validator, parseDescribeBoxes, parseComponentTaps } from "../src/validate.ts";
import { buildWorld } from "../src/world.ts";
import { currentScreenDef, elementAt, execute, type ToolResult } from "../src/gym.ts";
import type { ToolSpec } from "../src/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const PYTHON = process.env.PYTHON ?? join(ROOT, ".venv", "bin", "python");
const catalog: ToolSpec[] = JSON.parse(readFileSync(join(HERE, "..", "spec", "tools.json"), "utf8"));
const validator = new Validator(catalog);

const OFFERED_TOOLS = 16;
const MAX_STEPS = 14;
const HELD_OUT_BASE = 5_000_000;
const DISCOVERY = new Set(["describe", "debugger-component-tree", "native-describe-screen"]);
const DEVICE_TOUCH = new Set(["boot-device", "launch-app", "open-url"]);
// Tasks whose success is "navigate to + tap the target element".
const NAV_KINDS = new Set(["navigate-tap", "toggle", "scroll-find", "deep-link", "hide-and-seek", "chromium-tabs", "login", "android-setup"]);

// ---- generation client ----

class Gen {
  private proc: ChildProcessWithoutNullStreams;
  private buf = "";
  private waiters: ((line: string) => void)[] = [];
  ready: Promise<void>;

  constructor(model: string, adapter?: string) {
    const args = ["serve.py", "--model", model, ...(adapter ? ["--adapter-path", adapter] : [])];
    this.proc = spawn(PYTHON, args, { cwd: HERE });
    this.ready = new Promise<void>((res, rej) => {
      this.proc.stderr.on("data", (d) => {
        const s = String(d);
        if (s.includes("READY")) res();
        if (/Traceback|Error/.test(s)) process.stderr.write(s);
      });
      this.proc.on("exit", (code) => rej(new Error(`serve.py exited ${code} before READY`)));
    });
    this.proc.stdout.on("data", (d) => {
      this.buf += String(d);
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        this.waiters.shift()?.(line);
      }
    });
  }

  generate(messages: { role: string; content: string }[], maxTokens = 256): Promise<string> {
    return new Promise((resolve) => {
      this.waiters.push((line) => {
        try {
          resolve(JSON.parse(line).text ?? "");
        } catch {
          resolve("");
        }
      });
      this.proc.stdin.write(JSON.stringify({ messages, max_tokens: maxTokens }) + "\n");
    });
  }

  close() {
    this.proc.stdin.end();
    this.proc.kill();
  }
}

// ---- parsing + grounding ----

function parseToolCall(text: string): { name: string; arguments: Record<string, unknown> } | null {
  const tagged = text.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/);
  let jsonStr: string | null = tagged ? tagged[1]! : null;
  if (!jsonStr) {
    const bare = text.match(/\{[\s\S]*?"name"[\s\S]*?\}/);
    if (bare) jsonStr = bare[0];
  }
  if (!jsonStr) return null;
  try {
    const o = JSON.parse(jsonStr);
    if (o && typeof o.name === "string") return { name: o.name, arguments: (o.arguments as Record<string, unknown>) ?? {} };
  } catch {
    /* malformed */
  }
  return null;
}

function grounded(disc: { name: string; content: string }, x: number, y: number): boolean {
  if (disc.name === "debugger-component-tree") {
    return parseComponentTaps(disc.content).some((p) => Math.abs(p.x - x) <= 0.02 && Math.abs(p.y - y) <= 0.02);
  }
  const eps = 0.005;
  return parseDescribeBoxes(disc.content).some((b) => x >= b.x - eps && x <= b.x + b.w + eps && y >= b.y - eps && y <= b.y + b.h + eps);
}

// ---- per-episode rollout ----

interface EpisodeResult {
  kind: string;
  isNav: boolean;
  steps: number;
  calls: number;
  parseFails: number; // model turns that produced neither a tool call nor a clean stop
  schemaOk: number;
  taps: number;
  groundedTaps: number;
  policyViolations: number;
  success: boolean | null; // null for non-nav kinds
  endedClean: boolean; // model emitted a final answer (no tool call) before MAX_STEPS
}

async function runEpisode(seed: number, gen: Gen): Promise<EpisodeResult | null> {
  const rng = new RNG(seed);
  const task: TaskSpec | null = generateTask(rng);
  if (!task) return null;
  const persona = pickPersona(rng, task.kind);
  const taskPrompt = userTaskPhrase(rng, task.kind, persona, {
    app: task.app.name,
    platform: task.platform,
    target: task.pathLabels.at(-1),
    path: task.pathLabels.slice(0, -1).length ? task.pathLabels.slice(0, -1) : task.pathLabels,
    field: task.field,
  });
  // Offer the same tool-availability distribution as training: the expert's used
  // set plus distractors. The model still must select + sequence correctly.
  const expert = solve(task, new RNG(seed ^ 0x5d5d5d5d), taskPrompt);
  const offered = buildOfferedTools(catalog, expert.toolsUsed, new RNG(seed ^ 0x1234abcd), OFFERED_TOOLS);
  const world = buildWorld({
    app: task.app,
    platform: task.platform,
    rng: new RNG(seed ^ 0x0f0f0f0f),
    inject: task.inject,
    deviceBooted: task.deviceBooted,
  });

  const messages: { role: string; content: string }[] = [
    { role: "user", content: buildGemmaFirstUser(ARGENT_POLICY_COMPACT, offered, taskPrompt) },
  ];

  const r: EpisodeResult = {
    kind: task.kind,
    isNav: NAV_KINDS.has(task.kind),
    steps: 0,
    calls: 0,
    parseFails: 0,
    schemaOk: 0,
    taps: 0,
    groundedTaps: 0,
    policyViolations: 0,
    success: NAV_KINDS.has(task.kind) ? false : null,
    endedClean: false,
  };

  let lastDiscovery: { name: string; content: string } | null = null;
  let listedDevices = false;

  for (let step = 0; step < MAX_STEPS; step++) {
    r.steps = step + 1;
    const out = await gen.generate(messages, 180);
    const call = parseToolCall(out);
    messages.push({ role: "assistant", content: out.trim() || "(empty)" });

    if (!call) {
      // A plain answer with no tool call is a legitimate episode end; an empty /
      // garbled turn is a parse failure.
      if (out.trim().length > 0 && !/<tool_call>/.test(out)) r.endedClean = true;
      else r.parseFails++;
      break;
    }

    r.calls++;
    if (call.name === "list-devices") listedDevices = true;
    if (DEVICE_TOUCH.has(call.name) && !listedDevices) r.policyViolations++;

    const chk = validator.checkCall(call.name, call.arguments);
    if (chk.schemaOk) r.schemaOk++;

    if (call.name === "gesture-tap") {
      r.taps++;
      const x = Number(call.arguments.x);
      const y = Number(call.arguments.y);
      if (lastDiscovery && grounded(lastDiscovery, x, y)) r.groundedTaps++;
      else r.policyViolations++;
      // Success: tapping the target element while on the target screen.
      if (r.isNav && world.currentScreen === task.targetScreen) {
        const el = elementAt(world, x, y);
        if (el && el.key === task.targetElementKey) r.success = true;
      }
    }

    // Execute in the gym (guarded — a wrong/unimplemented tool yields an error obs).
    let obs: string;
    try {
      if (!chk.known) obs = JSON.stringify({ error: `unknown tool '${call.name}'` });
      else {
        const res: ToolResult = execute(world, call.name, { udid: world.deviceId, ...call.arguments });
        obs = res.content;
      }
    } catch (e) {
      obs = JSON.stringify({ error: String((e as Error).message ?? e) });
    }

    if (DISCOVERY.has(call.name) && !/"error"\s*:/.test(obs)) lastDiscovery = { name: call.name, content: obs };
    if (r.success) break;

    messages.push({ role: "user", content: `<tool_response>\n${compactObservation(obs)}\n</tool_response>` });
  }
  return r;
}

// ---- aggregation ----

function aggregate(results: EpisodeResult[]) {
  const navs = results.filter((e) => e.isNav);
  const sum = (f: (e: EpisodeResult) => number) => results.reduce((a, e) => a + f(e), 0);
  const calls = sum((e) => e.calls);
  const taps = sum((e) => e.taps);
  const byKind: Record<string, { n: number; success: number }> = {};
  for (const e of results) {
    if (e.success === null) continue;
    byKind[e.kind] ??= { n: 0, success: 0 };
    byKind[e.kind]!.n++;
    if (e.success) byKind[e.kind]!.success++;
  }
  return {
    episodes: results.length,
    nav_episodes: navs.length,
    nav_success_pct: navs.length ? +((100 * navs.filter((e) => e.success).length) / navs.length).toFixed(1) : 0,
    schema_valid_pct: calls ? +((100 * sum((e) => e.schemaOk)) / calls).toFixed(1) : 0,
    grounded_tap_pct: taps ? +((100 * sum((e) => e.groundedTaps)) / taps).toFixed(1) : 0,
    policy_violations_per_ep: +(sum((e) => e.policyViolations) / Math.max(1, results.length)).toFixed(2),
    parse_fail_episodes_pct: +((100 * results.filter((e) => e.parseFails > 0).length) / Math.max(1, results.length)).toFixed(1),
    clean_finish_pct: +((100 * results.filter((e) => e.endedClean).length) / Math.max(1, results.length)).toFixed(1),
    avg_calls_per_ep: +(calls / Math.max(1, results.length)).toFixed(1),
    nav_success_by_kind: Object.fromEntries(
      Object.entries(byKind).map(([k, v]) => [k, `${v.success}/${v.n}`])
    ),
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const get = (k: string, d?: string) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : d;
  };
  const model = get("--model")!;
  const adapter = get("--adapter");
  const n = +(get("--n", "120") as string);
  const label = get("--label", "run") as string;
  if (!model) throw new Error("--model required");

  const gen = new Gen(model, adapter);
  process.stderr.write(`loading ${model}${adapter ? ` + adapter ${adapter}` : ""} …\n`);
  await gen.ready;
  process.stderr.write(`model ready; running ${n} episodes\n`);

  const results: EpisodeResult[] = [];
  let seed = HELD_OUT_BASE;
  while (results.length < n) {
    const r = await runEpisode(seed, gen);
    seed++;
    if (r) results.push(r);
    if (results.length % 20 === 0) process.stderr.write(`  ${results.length}/${n}\n`);
  }
  gen.close();

  const summary = aggregate(results);
  const outDir = join(HERE, "runs");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `eval-${label}.json`), JSON.stringify({ model, adapter, label, summary }, null, 2));
  console.log(`\n=== eval [${label}] ${model}${adapter ? " + " + adapter : ""} ===`);
  console.log(JSON.stringify(summary, null, 2));
}

main();
