// Assemble a validated Trajectory and convert it to common fine-tuning formats.

import { ARGENT_SYSTEM_PROMPT } from "./system-prompt.ts";
import type { RNG } from "./rng.ts";
import type { Message, Persona, ToolSpec, Trajectory, TrajectoryMeta } from "./types.ts";
import type { SolveResult } from "./expert.ts";
import type { TaskSpec } from "./tasks.ts";

const DISTRACTOR_TARGET = 28; // total tools offered per example (used + distractors)

/** Tools offered to the model for this example: every used tool plus a random
 *  sample of distractors, so the model learns to select among the full surface.
 *  `target` caps the total offered (used ∪ distractors) — lower it to shrink
 *  sequences for small-model training; used tools are always included. */
export function buildOfferedTools(
  catalog: ToolSpec[],
  used: string[],
  rng: RNG,
  target = DISTRACTOR_TARGET
): ToolSpec[] {
  const byName = new Map(catalog.map((t) => [t.name, t]));
  const usedSpecs = used.map((n) => byName.get(n)).filter((t): t is ToolSpec => Boolean(t));
  const pool = catalog.filter((t) => !used.includes(t.name));
  const need = Math.max(0, target - usedSpecs.length);
  const distractors = rng.sample(pool, need);
  return rng.shuffle([...usedSpecs, ...distractors]);
}

export function assemble(
  solveResult: SolveResult,
  task: TaskSpec,
  seed: number,
  offeredTools: ToolSpec[],
  persona: Persona
): Trajectory {
  const messages: Message[] = [
    { role: "system", content: ARGENT_SYSTEM_PROMPT },
    ...solveResult.messages,
  ];
  const meta: TrajectoryMeta = {
    id: `argent-${task.kind}-${seed}`,
    seed,
    task_type: task.kind,
    persona,
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

// ---- Gemma 2 chat format ----
//
// Gemma 2 has only `user`/`model` turns — no system or tool role. So we fold the
// system policy + the offered tools + the task into the first user turn, render
// each tool call as a <tool_call> text block in the model turn, and fold tool
// results into the following user turn. The result is clean user/model
// alternation that mlx-lm can feed straight through the Gemma chat template.

const TOOL_CALL_OPEN = "<tool_call>";
const TOOL_CALL_CLOSE = "</tool_call>";

/** Compact one-line-per-tool rendering (name(params): first line of description). */
export function renderToolsCompact(tools: ToolSpec[]): string {
  return tools
    .map((t) => {
      const props = (t.inputSchema.properties as Record<string, unknown>) ?? {};
      const required = new Set((t.inputSchema.required as string[]) ?? []);
      const params = Object.keys(props)
        .map((p) => (required.has(p) ? p : `${p}?`))
        .join(", ");
      const desc = (t.description ?? "").split("\n")[0]!.trim();
      return `- ${t.name}(${params}): ${desc}`;
    })
    .join("\n");
}

export function renderToolCall(name: string, args: Record<string, unknown>): string {
  return `${TOOL_CALL_OPEN}\n${JSON.stringify({ name, arguments: args })}\n${TOOL_CALL_CLOSE}`;
}

/** The first user turn: policy + tools + task, with the tool-call protocol.
 *  Shared by the training exporter and the live eval harness so they match. */
export function buildGemmaFirstUser(systemPrompt: string, tools: ToolSpec[], task: string): string {
  return (
    `${systemPrompt}\n\n` +
    `# Tool-call protocol\n` +
    `To call a tool, emit exactly one block:\n${TOOL_CALL_OPEN}\n{"name": "<tool>", "arguments": { ... }}\n${TOOL_CALL_CLOSE}\n` +
    `You will then receive a <tool_response> with the result (including a [screenshot] line showing the resulting screen). When the task is done, reply with a short plain-text answer and no tool call.\n\n` +
    `# Available tools\n${renderToolsCompact(tools)}\n\n` +
    `# Task\n${task}`
  );
}

export function gemmaSystemPreamble(traj: Trajectory, task: string): string {
  const sys = traj.messages.find((m) => m.role === "system")?.content ?? "";
  return buildGemmaFirstUser(sys, traj.tools, task);
}

// The describe header repeats a long, constant coordinate explanation on every
// call; the Gemma preamble already states it, so strip it from observations to
// keep sequences short without losing element lines or the scene caption.
const DESCRIBE_NOTE_RE =
  /Coordinates are normalized \[0,1\][^\n]*tap_y = frame\.y \+ frame\.height \/ 2\.\n?/;

export function compactObservation(content: string): string {
  return content.replace(DESCRIBE_NOTE_RE, "");
}

export function toGemmaMessages(traj: Trajectory): { messages: { role: "user" | "assistant"; content: string }[] } {
  const out: { role: "user" | "assistant"; content: string }[] = [];
  const firstUserIdx = traj.messages.findIndex((m) => m.role === "user");
  const task = (traj.messages[firstUserIdx] as { content: string })?.content ?? "";
  out.push({ role: "user", content: gemmaSystemPreamble(traj, task) });

  let pending: string[] = [];
  const flush = () => {
    if (pending.length) {
      out.push({ role: "user", content: pending.join("\n") });
      pending = [];
    }
  };
  for (const m of traj.messages.slice(firstUserIdx + 1)) {
    if (m.role === "assistant") {
      flush();
      let content = m.content || "";
      if (m.tool_calls) {
        const calls = m.tool_calls.map((c) => renderToolCall(c.name, c.arguments)).join("\n");
        content = content ? `${content}\n${calls}` : calls;
      }
      out.push({ role: "assistant", content });
    } else if (m.role === "tool") {
      pending.push(`<tool_response>\n${compactObservation(m.content)}\n</tool_response>`);
    }
  }
  flush();
  return { messages: out };
}
