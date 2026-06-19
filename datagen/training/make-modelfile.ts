// Emit an Ollama Modelfile for silver:2b. The model was trained with the
// Argent policy + a tool list in the first user turn, so we bake an equivalent
// preamble into SYSTEM (Gemma's template merges it into the first user turn) and
// a Gemma 2 chat template, so a user can type a task and get tool calls back.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildGemmaFirstUser } from "../src/emit.ts";
import { ARGENT_POLICY_COMPACT } from "../src/system-prompt.ts";
import type { ToolSpec } from "../src/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const catalog: ToolSpec[] = JSON.parse(
  readFileSync(join(HERE, "..", "spec", "tools.json"), "utf8")
);

// A representative interaction/navigation tool set for an interactive session.
const DEFAULT_TOOLS = [
  "list-devices",
  "boot-device",
  "launch-app",
  "open-url",
  "describe",
  "debugger-status",
  "debugger-component-tree",
  "gesture-tap",
  "gesture-swipe",
  "gesture-scroll",
  "keyboard",
  "button",
  "screenshot",
  "view-network-logs",
  "run-sequence",
  "stop-all-simulator-servers",
];
const tools = DEFAULT_TOOLS.map((n) => catalog.find((t) => t.name === n)!).filter(Boolean);

// Preamble ending at "# Task" — the user's typed message becomes the task.
const preamble = buildGemmaFirstUser(ARGENT_POLICY_COMPACT, tools, "").trimEnd();

// Multi-turn Gemma template with the Argent preamble baked into the first user
// turn (no reliance on .System, which our earlier template failed to inject).
// A literal <bos> is required: Gemma is bos-sensitive — the model only emits
// tool calls with bos present, and Ollama does NOT auto-add it for this imported
// model (verified empirically), so there's no double-bos. The first user message
// lands right after "# Task"; later turns (e.g. pasted <tool_response>s) carry
// the conversation so the model keeps driving.
const template = `{{- range $i, $m := .Messages }}
{{- if eq $i 0 }}<bos>{{ end }}
{{- if eq $m.Role "user" }}<start_of_turn>user
{{ if eq $i 0 }}${preamble}

{{ end }}{{ $m.Content }}<end_of_turn>
{{ end }}
{{- if eq $m.Role "assistant" }}<start_of_turn>model
{{ $m.Content }}<end_of_turn>
{{ end }}
{{- end }}<start_of_turn>model
`;

const modelfile = `# silver:2b — Gemma 2 2B fine-tuned to drive the Argent toolkit.
FROM ./argent-silver

TEMPLATE """${template}"""

# Greedy for consistent, schema-valid tool calls.
PARAMETER temperature 0
PARAMETER stop "<end_of_turn>"
`;

writeFileSync(join(HERE, "fused", "Modelfile"), modelfile);
console.log(`wrote fused/Modelfile (preamble ${preamble.length} chars, ${tools.length} tools)`);
