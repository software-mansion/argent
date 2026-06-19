// Assemble a validated Trajectory and convert it to common fine-tuning formats.

import { ARGENT_SYSTEM_PROMPT } from "./system-prompt.ts";
import type { RNG } from "./rng.ts";
import type { Message, ToolSpec, Trajectory, TrajectoryMeta } from "./types.ts";
import type { SolveResult } from "./expert.ts";
import type { TaskSpec } from "./tasks.ts";

const DISTRACTOR_TARGET = 28; // total tools offered per example (used + distractors)

/** Tools offered to the model for this example: every used tool plus a random
 *  sample of distractors, so the model learns to select among the full surface. */
export function buildOfferedTools(catalog: ToolSpec[], used: string[], rng: RNG): ToolSpec[] {
  const byName = new Map(catalog.map((t) => [t.name, t]));
  const usedSpecs = used.map((n) => byName.get(n)).filter((t): t is ToolSpec => Boolean(t));
  const pool = catalog.filter((t) => !used.includes(t.name));
  const need = Math.max(0, DISTRACTOR_TARGET - usedSpecs.length);
  const distractors = rng.sample(pool, need);
  return rng.shuffle([...usedSpecs, ...distractors]);
}

export function assemble(
  solveResult: SolveResult,
  task: TaskSpec,
  seed: number,
  offeredTools: ToolSpec[]
): Trajectory {
  const messages: Message[] = [
    { role: "system", content: ARGENT_SYSTEM_PROMPT },
    ...solveResult.messages,
  ];
  const meta: TrajectoryMeta = {
    id: `argent-${task.kind}-${seed}`,
    seed,
    task_type: task.kind,
    platform: task.platform,
    app_archetype: task.app.id,
    difficulty: task.difficulty,
    is_react_native: task.app.isReactNative,
    tools_used: solveResult.toolsUsed.slice().sort(),
    n_assistant_turns: solveResult.assistantTurns,
    n_tool_calls: solveResult.toolCalls,
    has_recovery: solveResult.hasRecovery,
    source: "expert-solver",
  };
  return { meta, tools: offeredTools, messages };
}

// ---- format converters ----

/** OpenAI fine-tuning chat format (tools + messages with tool_calls). */
export function toOpenAI(traj: Trajectory): unknown {
  return {
    messages: traj.messages.map((m) => {
      if (m.role === "assistant") {
        const out: Record<string, unknown> = { role: "assistant", content: m.content || null };
        if (m.tool_calls) {
          out.tool_calls = m.tool_calls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.arguments) },
          }));
        }
        return out;
      }
      if (m.role === "tool") {
        return { role: "tool", tool_call_id: m.tool_call_id, content: m.content };
      }
      return { role: m.role, content: m.content };
    }),
    tools: traj.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    })),
  };
}

/** ShareGPT-style (single conversation list), tool calls inlined as text blocks. */
export function toShareGPT(traj: Trajectory): unknown {
  const roleMap: Record<string, string> = {
    system: "system",
    user: "human",
    assistant: "gpt",
    tool: "tool",
  };
  return {
    tools: JSON.stringify(
      traj.tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      }))
    ),
    conversations: traj.messages.map((m) => {
      if (m.role === "assistant" && m.tool_calls) {
        const calls = m.tool_calls.map((c) => ({ name: c.name, arguments: c.arguments }));
        const text =
          (m.content ? m.content + "\n" : "") +
          calls.map((c) => `<tool_call>${JSON.stringify(c)}</tool_call>`).join("\n");
        return { from: "gpt", value: text };
      }
      return { from: roleMap[m.role], value: (m as { content: string }).content };
    }),
  };
}
