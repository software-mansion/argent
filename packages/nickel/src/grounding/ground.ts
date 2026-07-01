// System 1 — reflex grounding. Tree + one instruction -> one tool call. Reasoning
// off, flat-enum JSON schema (llama.cpp stalls on oneOf+strict).
//
// The vocabulary is exactly what execute.ts can honestly perform — do not add an
// action here without a real mapping onto an argent tool there.

import type { LlamaClient, ChatImage } from "../runtime/client";

const SYSTEM = `You are a mobile UI automation agent controlling an iOS/Android screen.

You receive a SCREEN (accessibility tree; each line: ROLE "label" [flags] (x, y, w, h),
top-left origin, all normalized 0..1) and one INSTRUCTION. Choose exactly ONE tool.

Tools:
- tap(target): tap an element. \`target\` = the exact quoted label from a tree line (verbatim).
- type_text(text): type into the focused field (tap the field first in a separate step).
- swipe(direction): scroll. "down" reveals content below, "up" scrolls back up.
- answer(value): answer a short yes/no or factual question about the screen (do not tap).

When several elements share a label, use the instruction's context. Tapping a button to
navigate is a tap, never type_text. Reply with ONE JSON tool call only.`;

const SCHEMA = {
  type: "object",
  properties: {
    tool: { type: "string", enum: ["tap", "type_text", "swipe", "answer"] },
    target: { type: "string" },
    text: { type: "string" },
    direction: { type: "string", enum: ["up", "down"] },
    value: { type: "string" },
  },
  required: ["tool"],
};

export interface ToolCall {
  tool?: string;
  target?: string;
  text?: string;
  direction?: string;
  value?: string;
  [k: string]: unknown;
}

export interface Grounded {
  call: ToolCall | null;
  raw: string;
  latency_ms: number;
}

// Pull the first balanced {...} object out of the response (robust to stray prose).
// Exported (generic) so System-2 deliberation reuses the exact same tolerant parser.
export function extractJson<T = ToolCall>(text: string): T | null {
  if (!text) return null;
  const s = text.replace(/```json/gi, "```").replace(/```/g, " ");
  let start = s.indexOf("{");
  while (start !== -1) {
    let depth = 0;
    for (let i = start; i < s.length; i++) {
      if (s[i] === "{") depth++;
      else if (s[i] === "}" && --depth === 0) {
        try {
          const o = JSON.parse(s.slice(start, i + 1));
          if (o && typeof o === "object") return o as T;
        } catch {
          /* keep scanning */
        }
        break;
      }
    }
    start = s.indexOf("{", start + 1);
  }
  return null;
}

export async function groundAction(
  llama: LlamaClient,
  tree: string,
  instruction: string,
  image?: ChatImage
): Promise<Grounded> {
  const r = await llama.chat({
    system: SYSTEM,
    user: `SCREEN:\n${tree}\n\nINSTRUCTION: ${instruction}`,
    image,
    schema: SCHEMA,
    maxTokens: 160,
  });
  return { call: extractJson(r.text), raw: r.text.trim(), latency_ms: r.latency_ms };
}
