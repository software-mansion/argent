// nickel-do — autonomously pursue a mundane multi-step goal (the S1 + S2 worker).
//
// The loop each turn:
//   describe  -> observe the live screen (the durable state lives on the device)
//   deliberate(S2) -> decide the next move OR a terminal verdict
//   ground(S1)     -> turn the chosen step into one concrete tool call
//   execute        -> perform it through argent's own tools, in-process
// until the minion reports done / need_clearance / blocked, or the step budget runs out.
//
// The session lives on the FRONTIER: nickel-do is stateful only WITHIN one run. To
// resume past a clearance, the frontier calls again with `context` carrying its
// approval — the device screen is the memory, so the minion just re-observes.

import { z } from "zod";
import type { Registry, ToolDefinition, ToolContext } from "@argent/registry";
import { llamaRuntimeRef, type LlamaApi } from "../runtime/llama-runtime";
import { renderTree, labels, type Screen } from "../describe/screen";
import { groundAction, type ToolCall } from "../grounding/ground";
import { deliberate } from "../grounding/deliberate";
import { executeGrounded } from "../act/execute";
import { classifyRisk, isApproved } from "../act/risk";
import { captureImage } from "../runtime/vision";
import { bindInvoke, observeScreen } from "../invoke";
import {
  emptyCost,
  type NickelResult,
  type TraceStep,
  type Cost,
  type Envelope,
  type Risk,
} from "../protocol";

const DEFAULT_MAX_STEPS = 12;

const zodSchema = z.object({
  udid: z.string().describe("Target device id from `list-devices`."),
  goal: z
    .string()
    .describe('The mundane goal to pursue, e.g. "open Settings and turn on airplane mode".'),
  context: z
    .string()
    .optional()
    .describe(
      'Guidance/approval from the frontier to resume with (e.g. "approved: submit the form").'
    ),
  max_steps: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(`Safety cap on executed steps (default ${DEFAULT_MAX_STEPS}).`),
});
type Params = z.infer<typeof zodSchema>;

// A short label for what a call did, for the trace.
function describeCall(step: string, call: ToolCall): string {
  const t = call.tool ?? "?";
  if (t === "tap") return `tap "${call.target ?? ""}"`;
  if (t === "type_text") return `type "${call.text ?? ""}"`;
  if (t === "swipe") return `swipe ${call.direction ?? "down"}`;
  if (t === "answer") return `answer "${call.value ?? ""}"`;
  return step || "act";
}

export function createNickelDoTool(registry: Registry): ToolDefinition<Params, NickelResult> {
  return {
    id: "nickel-do",
    description:
      "Delegate a mundane MULTI-STEP goal (navigation, filling forms, toggling settings) to the " +
      "local Nickel minion. It observes the screen, plans, acts, and re-observes on a loop until it " +
      "reports one of: done (goal met) | need_clearance (a risky step needs your approval) | blocked " +
      "(stuck, needs help) | report (budget reached). Each result carries the goal, a one-line summary, " +
      "the current screen, the full trace, and cost — enough to approve, help recover, or resume (call " +
      "again with `context` carrying your approval).",
    featureFlag: "nickel",
    longRunning: true,
    zodSchema,
    services: () => ({ llama: llamaRuntimeRef() }),
    async execute(services, params, ctx?: ToolContext): Promise<NickelResult> {
      const llama = services.llama as LlamaApi;
      const invoke = bindInvoke(registry, ctx);
      const signal = ctx?.signal;
      const maxSteps = params.max_steps ?? DEFAULT_MAX_STEPS;

      const cost: Cost = emptyCost();
      const trace: TraceStep[] = [];

      // Stall detection: the local model is weak at noticing it's looping. The harness
      // watches for CYCLES — a screen state we've already visited recently — which catches
      // both a frozen screen (revisits the prior state) and a 2-state oscillation (A↔B),
      // while leaving genuine forward progress (all-new states) alone. On a stall it first
      // (1) nudges the planner to try something else, then (2) escalates to "blocked" —
      // honest error recovery instead of burning the whole step budget in place.
      const STALL_LIMIT = 3;
      const RECENT = 5;
      let stall = 0;
      let lastAction = "";
      const recent: string[] = [];
      const sig = (s: Screen) => labels(s).join("|");

      const observe = async (): Promise<Screen> => {
        const t = Date.now();
        const s = await observeScreen(invoke, params.udid);
        cost.exec_ms += Date.now() - t;
        return s;
      };

      const envelope = (summary: string, screen: Screen): Envelope => ({
        goal: params.goal,
        summary,
        screen: labels(screen).slice(0, 30),
        trace,
        cost,
      });

      // Risk gate for a grounded call: a side-effecting action the frontier hasn't
      // approved returns the risk class; null means safe-to-execute.
      const gate = (call: ToolCall): Risk | null => {
        const r = classifyRisk(call);
        return r && !isApproved(params.context) ? r : null;
      };
      const clearance = (
        step: string,
        call: ToolCall,
        risk: Risk,
        screen: Screen,
        why?: string
      ): NickelResult => ({
        ...envelope(`needs approval: ${describeCall(step, call)}`, screen),
        status: "need_clearance",
        need_clearance: {
          proposed_action: { kind: describeCall(step, call), target: call.target },
          why: why || `"${call.target}" performs a ${risk} action`,
          risk,
          reversible: risk === "external",
          resume_hint: `call nickel-do again with the same goal + context: "approved: ${step}"`,
        },
      });

      let screen = await observe();
      recent.push(sig(screen));

      for (let i = 0; i < maxSteps; i++) {
        if (signal?.aborted) {
          return {
            ...envelope("aborted by caller", screen),
            status: "report",
            report: { note: "aborted", continue: false },
          };
        }

        // If we've stalled too long, don't ask the planner again — it already proved it
        // can't get past this. Report blocked so the frontier can help.
        if (stall >= STALL_LIMIT) {
          return {
            ...envelope(`stuck: repeated "${lastAction}" with no effect`, screen),
            status: "blocked",
            blocked: {
              obstacle: `the same action ("${lastAction}") did not change the screen after ${stall} tries`,
              likely_cause:
                "the target element may be wrong, disabled, or the step needs a different approach",
              tried: trace.slice(-3).map((t) => ({ action: t.action, outcome: t.outcome })),
              ask: "how should I proceed — a different element to tap, or is a prerequisite missing?",
            },
          };
        }

        // System 2 — decide the next move. When stalled, nudge it off the repeat.
        const nudge =
          stall > 0
            ? `Your last action "${lastAction}" did NOT change the screen. Do not repeat it — pick a DIFFERENT element or approach, or decide "blocked".`
            : undefined;
        const { plan, latency_ms: planMs } = await deliberate(
          llama,
          renderTree(screen),
          params.goal,
          trace,
          params.context,
          nudge
        );
        cost.model_calls++;
        cost.ground_ms += planMs;

        if (plan.decision === "done") {
          return {
            ...envelope(plan.evidence || "goal reached", screen),
            status: "done",
            done: { achieved: plan.achieved ?? true, evidence: plan.evidence ?? "" },
          };
        }

        if (plan.decision === "need_clearance") {
          return {
            ...envelope(`needs approval: ${plan.step ?? "a risky step"}`, screen),
            status: "need_clearance",
            need_clearance: {
              proposed_action: { kind: plan.step ?? "unknown" },
              why: plan.why ?? "the next step has side effects",
              risk: plan.risk ?? "irreversible",
              reversible: false,
              resume_hint: `call nickel-do again with context: "approved: ${plan.step ?? "proceed"}"`,
            },
          };
        }

        if (plan.decision === "blocked") {
          return {
            ...envelope(plan.obstacle || "stuck", screen),
            status: "blocked",
            blocked: {
              obstacle: plan.obstacle ?? "cannot make progress",
              likely_cause: plan.why,
              tried: trace.slice(-3).map((t) => ({ action: t.action, outcome: t.outcome })),
              ask: plan.ask ?? "how should I proceed?",
            },
          };
        }

        // decision === "act": System 1 grounds the chosen step (text tree first).
        const step = plan.step ?? "";
        const g = await groundAction(llama, renderTree(screen), step);
        cost.model_calls++;
        cost.ground_ms += g.latency_ms;
        const call = g.call ?? {};

        // Harness risk floor (see act/risk.ts): a side-effecting action the frontier
        // hasn't approved STOPS here for clearance even though the planner chose "act".
        const risk = gate(call);
        if (risk) return clearance(step, call, risk, screen, plan.why);

        let action = describeCall(step, call);
        const tExec = Date.now();
        let out = await executeGrounded(invoke, params.udid, screen, call);
        cost.exec_ms += Date.now() - tExec;

        // Vision escalation: the accessibility tree couldn't resolve the tap target.
        // Look at the actual pixels (Gemma 4 is a VLM) and re-ground ONCE with the
        // screenshot attached — this rescues elements the tree labels ambiguously.
        if (!out.resolved && call.tool === "tap") {
          const image = await captureImage(invoke, params.udid);
          if (image) {
            const gv = await groundAction(llama, renderTree(screen), step, image);
            cost.model_calls++;
            cost.ground_ms += gv.latency_ms;
            cost.used_vision = true;
            const cv = gv.call ?? {};
            const rv = gate(cv);
            if (rv) return clearance(step, cv, rv, screen, plan.why);
            const tv = Date.now();
            const outv = await executeGrounded(invoke, params.udid, screen, cv);
            cost.exec_ms += Date.now() - tv;
            if (outv.resolved) {
              out = outv;
              action = `${describeCall(step, cv)} [vision]`;
            }
          }
        }

        cost.steps++;
        trace.push({ i: i + 1, thought: plan.thought, action, outcome: out.did });

        if (out.observe) screen = await observe();

        // Stalled if the action failed to resolve, or the resulting screen is one we've
        // recently been on (frozen or cycling). Forward progress = a state not seen lately.
        const newSig = sig(screen);
        const cycling = recent.includes(newSig);
        recent.push(newSig);
        if (recent.length > RECENT) recent.shift();
        stall = !out.resolved || cycling ? stall + 1 : 0;
        lastAction = action;
      }

      // Budget exhausted — hand back to the frontier, which owns the session and can
      // decide to continue (call again) or stop.
      return {
        ...envelope(`step budget (${maxSteps}) reached before completion`, screen),
        status: "report",
        report: {
          note: `Ran ${cost.steps} step(s) without concluding. Call again to continue, or intervene.`,
          continue: true,
        },
      };
    },
  };
}
