// Emit an Ollama Modelfile baking the Argent policy + tool list into the model.
//
//   node make-modelfile.ts            # gemma2 (silver:2b): baked chat TEMPLATE
//   FLAVOR=gemma4 node make-modelfile.ts   # gemma4 (silver:e4b): SYSTEM preamble
//
// gemma2 (silver:2b): Ollama doesn't apply Gemma 2's template/bos for an imported
// model, so we bake a multi-turn chat TEMPLATE with a literal <bos> and the
// preamble in the first user turn (matching training exactly).
//
// gemma4 (silver:e4b): Ollama 0.30 has a native `RENDERER gemma4` (auto-assigned
// when the GGUF is imported), which handles bos/turns correctly — so we just put
// the preamble (policy + tools, minus the "# Task" trailer) in SYSTEM and let the
// renderer fold it in. The user's typed task becomes the first user turn.
// (The fine-tuned model tool-calls correctly with the preamble in the system turn,
// verified empirically.)

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildGemmaFirstUser } from "../src/emit.ts";
import { ARGENT_POLICY_COMPACT } from "../src/system-prompt.ts";
import type { ToolSpec } from "../src/types.ts";

const FLAVOR = process.env.FLAVOR === "gemma4" ? "gemma4" : "gemma2";

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

const fullPreamble = buildGemmaFirstUser(ARGENT_POLICY_COMPACT, tools, "").trimEnd();

let modelfile: string;
if (FLAVOR === "gemma4") {
  // SYSTEM = policy + tools, minus the "# Task" trailer (the task is the user turn).
  const system = fullPreamble.replace(/\n+# Task\s*$/, "").trimEnd();
  // FROM the llama.cpp-converted GGUF (Ollama's own gemma4 safetensors converter is
  // broken; see README). `ollama create -q q4_K_M -f Modelfile` quantizes + imports;
  // RENDERER/PARSER gemma4 are auto-assigned from the GGUF.
  const gguf = process.env.GGUF ?? "./silver-e4b.f16.gguf";
  modelfile = `# silver:e4b — Gemma 4 E4B fine-tuned to drive the Argent toolkit.
FROM ${gguf}

SYSTEM """${system}"""

# Greedy for consistent, schema-valid tool calls.
PARAMETER temperature 0
`;
  writeFileSync(join(HERE, "fused", "Modelfile.e4b"), modelfile);
  console.log(`wrote fused/Modelfile.e4b (SYSTEM ${system.length} chars, ${tools.length} tools)`);
} else {
  // gemma2: bake a multi-turn chat TEMPLATE with a literal <bos> and the preamble in
  // the first user turn. Gemma is bos-sensitive and Ollama doesn't auto-add it for
  // this imported model (verified), and .System injection failed in earlier attempts.
  const template = `{{- range $i, $m := .Messages }}
{{- if eq $i 0 }}<bos>{{ end }}
{{- if eq $m.Role "user" }}<start_of_turn>user
{{ if eq $i 0 }}${fullPreamble}

{{ end }}{{ $m.Content }}<end_of_turn>
{{ end }}
{{- if eq $m.Role "assistant" }}<start_of_turn>model
{{ $m.Content }}<end_of_turn>
{{ end }}
{{- end }}<start_of_turn>model
`;
  modelfile = `# silver:2b — Gemma 2 2B fine-tuned to drive the Argent toolkit.
FROM ./argent-silver

TEMPLATE """${template}"""

# Greedy for consistent, schema-valid tool calls.
PARAMETER temperature 0
PARAMETER stop "<end_of_turn>"
`;
  writeFileSync(join(HERE, "fused", "Modelfile"), modelfile);
  console.log(
    `wrote fused/Modelfile (preamble ${fullPreamble.length} chars, ${tools.length} tools)`
  );
}
