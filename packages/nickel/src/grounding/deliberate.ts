// System 2 — deliberation. Given the GOAL, the current SCREEN, and the HISTORY of
// what it has already done, the minion picks the single next move OR delivers a
// terminal verdict (done / need_clearance / blocked).
//
// It emits `thought` FIRST, so with grammar-constrained decoding the model reasons
// before it commits — a chain-of-thought that we capture into the trace rather than
// throwing away. Flat-enum schema, like grounding: llama.cpp stalls on oneOf/strict.

import type { LlamaClient } from "../runtime/client";
import type { TraceStep } from "../protocol";
import { extractJson } from "./ground";

const SYSTEM = `You are the planner for a mobile automation minion pursuing a GOAL on a live iOS/Android screen.

Each turn you see the GOAL, the current SCREEN (accessibility tree: ROLE "label" (x, y, w, h),
normalized 0..1), and the HISTORY of steps already taken. Think in ONE short sentence (\`thought\`),
then commit to ONE decision:

- "act": the goal is NOT done yet and the next step is safe and obvious. Put ONE short concrete
  instruction in \`step\` (e.g. "tap the Search tab", "type hello into the search field"). It gets
  executed and you will see the resulting screen next turn.
- "done": the goal is already satisfied on the current screen. Set \`achieved\` and cite \`evidence\`
  (what on screen proves it).
- "need_clearance": the next step is RISKY — destructive, irreversible, spends money, or posts/sends
  something to the outside world. Put the action in \`step\`, classify \`risk\`, explain \`why\`. STOP; do
  not perform it — the frontier must approve first.
- "blocked": you cannot make progress — a needed element is missing, the app is in an unexpected
  state, or the same step keeps failing. Give the \`obstacle\` and what you would \`ask\` the frontier.

Rules: prefer "act" while safe forward progress is possible. NEVER repeat a step that just failed in
HISTORY — if you are stuck, choose "blocked". If FRONTIER guidance is present, treat it as approval to
proceed past a prior clearance. Reply with ONE JSON object only.`;

const SCHEMA = {
  type: "object",
  properties: {
    thought: { type: "string" },
    decision: { type: "string", enum: ["act", "done", "need_clearance", "blocked"] },
    step: { type: "string" },
    achieved: { type: "boolean" },
    evidence: { type: "string" },
    risk: { type: "string", enum: ["destructive", "irreversible", "purchase", "external"] },
    why: { type: "string" },
    obstacle: { type: "string" },
    ask: { type: "string" },
  },
  required: ["thought", "decision"],
};

export type Decision = "act" | "done" | "need_clearance" | "blocked";

export interface Plan {
  thought: string;
  decision: Decision;
  step?: string;
  achieved?: boolean;
  evidence?: string;
  risk?: "destructive" | "irreversible" | "purchase" | "external";
  why?: string;
  obstacle?: string;
  ask?: string;
}

export interface Deliberated {
  plan: Plan;
  raw: string;
  latency_ms: number;
}

function renderHistory(trace: TraceStep[]): string {
  if (trace.length === 0) return "(nothing yet)";
  return trace.map((t) => `${t.i}. ${t.action} -> ${t.outcome}`).join("\n");
}

export async function deliberate(
  llama: LlamaClient,
  tree: string,
  goal: string,
  trace: TraceStep[],
  frontierContext?: string,
  nudge?: string
): Promise<Deliberated> {
  const guidance = frontierContext ? `\n\nFRONTIER guidance: ${frontierContext}` : "";
  // A stall nudge goes LAST so it's the freshest instruction the model reads.
  const alert = nudge ? `\n\n!! ${nudge}` : "";
  const r = await llama.chat({
    system: SYSTEM,
    user: `GOAL: ${goal}${guidance}\n\nSCREEN:\n${tree}\n\nHISTORY:\n${renderHistory(trace)}${alert}`,
    schema: SCHEMA,
    maxTokens: 384,
  });
  const parsed = extractJson<Plan>(r.text);
  // A missing/garbled plan is itself a signal: fall back to "blocked" so the loop
  // hands control back to the frontier instead of spinning.
  const plan: Plan =
    parsed && parsed.decision
      ? parsed
      : {
          thought: r.text.trim().slice(0, 200),
          decision: "blocked",
          obstacle: "planner returned no decision",
          ask: "how should I proceed?",
        };
  return { plan, raw: r.text.trim(), latency_ms: r.latency_ms };
}
