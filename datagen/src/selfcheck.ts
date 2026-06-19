// Adversarial proof that the validator has teeth. We take a known-good
// trajectory, corrupt it in each way the gates are supposed to catch, and
// assert every corruption is REJECTED (and the clean one ACCEPTED). A gate that
// passes everything is worse than no gate — this is the regression test for the
// quality guarantee.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RNG } from "./rng.ts";
import { generateTask } from "./tasks.ts";
import { solve } from "./expert.ts";
import { pickPersona, userTaskPhrase } from "./narrate.ts";
import { assemble, buildOfferedTools } from "./emit.ts";
import { Validator } from "./validate.ts";
import type { Message, ToolSpec, Trajectory } from "./types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const catalog: ToolSpec[] = JSON.parse(
  readFileSync(join(HERE, "..", "spec", "tools.json"), "utf8")
);
const validator = new Validator(catalog);

function clone(t: Trajectory): Trajectory {
  return JSON.parse(JSON.stringify(t));
}

/** Build a known-good trajectory whose task contains at least one gesture-tap. */
function goodTrajectory(): Trajectory {
  for (let seed = 1; seed < 5000; seed++) {
    const rng = new RNG(seed);
    const task = generateTask(rng);
    if (!task || (task.kind !== "navigate-tap" && task.kind !== "toggle")) continue;
    const persona = pickPersona(rng, task.kind);
    const prompt = userTaskPhrase(rng, task.kind, persona, {
      app: task.app.name,
      platform: task.platform,
      target: task.pathLabels.at(-1),
      path: task.pathLabels,
    });
    const sr = solve(task, rng, prompt);
    const traj = assemble(sr, task, seed, buildOfferedTools(catalog, sr.toolsUsed, rng), persona);
    if (validator.validate(traj).ok && sr.toolsUsed.includes("gesture-tap")) return traj;
  }
  throw new Error("could not build a good trajectory for selfcheck");
}

function firstTapMsgIndex(msgs: Message[]): number {
  return msgs.findIndex(
    (m) => m.role === "assistant" && m.tool_calls?.some((c) => c.name === "gesture-tap")
  );
}

const cases: { name: string; mutate: (t: Trajectory) => void; expectReject: boolean }[] = [
  { name: "clean (control)", mutate: () => {}, expectReject: false },
  {
    name: "ungrounded tap (move coords off every element)",
    mutate: (t) => {
      const i = firstTapMsgIndex(t.messages);
      const call = (
        t.messages[i] as { tool_calls: { name: string; arguments: Record<string, number> }[] }
      ).tool_calls.find((c) => c.name === "gesture-tap")!;
      call.arguments.x = 0.999;
      call.arguments.y = 0.999;
    },
    expectReject: true,
  },
  {
    name: "tap with no preceding discovery (delete the discovery before it)",
    mutate: (t) => {
      const i = firstTapMsgIndex(t.messages);
      // remove the nearest preceding describe/component-tree assistant+tool pair
      for (let j = i - 1; j >= 0; j--) {
        const m = t.messages[j]!;
        if (
          m.role === "assistant" &&
          m.tool_calls?.some((c) => c.name === "describe" || c.name === "debugger-component-tree")
        ) {
          // delete assistant + following tool result(s)
          let k = j + 1;
          while (k < t.messages.length && t.messages[k]!.role === "tool") k++;
          t.messages.splice(j, k - j);
          break;
        }
      }
    },
    expectReject: true,
  },
  {
    name: "schema violation (drop required y from a gesture-tap)",
    mutate: (t) => {
      const i = firstTapMsgIndex(t.messages);
      const call = (
        t.messages[i] as { tool_calls: { name: string; arguments: Record<string, unknown> }[] }
      ).tool_calls.find((c) => c.name === "gesture-tap")!;
      delete call.arguments.y;
    },
    expectReject: true,
  },
  {
    name: "unknown argument on a tool call",
    mutate: (t) => {
      const i = firstTapMsgIndex(t.messages);
      const call = (
        t.messages[i] as { tool_calls: { name: string; arguments: Record<string, unknown> }[] }
      ).tool_calls.find((c) => c.name === "gesture-tap")!;
      call.arguments.bogus = 42;
    },
    expectReject: true,
  },
  {
    name: "coordinate out of [0,1] range",
    mutate: (t) => {
      const i = firstTapMsgIndex(t.messages);
      const call = (
        t.messages[i] as { tool_calls: { name: string; arguments: Record<string, number> }[] }
      ).tool_calls.find((c) => c.name === "gesture-tap")!;
      call.arguments.x = 1.5;
    },
    expectReject: true,
  },
  {
    name: "interaction before list-devices (delete list-devices turn)",
    mutate: (t) => {
      const j = t.messages.findIndex(
        (m) => m.role === "assistant" && m.tool_calls?.some((c) => c.name === "list-devices")
      );
      if (j >= 0) {
        let k = j + 1;
        while (k < t.messages.length && t.messages[k]!.role === "tool") k++;
        t.messages.splice(j, k - j);
      }
    },
    expectReject: true,
  },
  {
    name: "unknown tool name",
    mutate: (t) => {
      const i = firstTapMsgIndex(t.messages);
      (t.messages[i] as { tool_calls: { name: string }[] }).tool_calls.find(
        (c) => c.name === "gesture-tap"
      )!.name = "gesture-teleport";
    },
    expectReject: true,
  },
  {
    name: "calling a tool not offered in tools[]",
    mutate: (t) => {
      t.tools = t.tools.filter((tool) => tool.name !== "gesture-tap");
    },
    expectReject: true,
  },
];

const base = goodTrajectory();
let pass = 0;
let fail = 0;
console.log(`\n=== validator self-check (base: ${base.meta.id}) ===`);
for (const c of cases) {
  const t = clone(base);
  c.mutate(t);
  const res = validator.validate(t);
  const rejected = !res.ok;
  const ok = rejected === c.expectReject;
  if (ok) pass++;
  else fail++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${c.name.padEnd(56)} -> ${rejected ? "rejected" : "accepted"}${rejected ? `  (${res.errors[0]})` : ""}`
  );
}
console.log(`\n${pass}/${pass + fail} self-check cases behaved correctly`);
if (fail > 0) process.exit(1);
