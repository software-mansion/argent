// Probe an Ollama model with the Argent preamble, two ways:
//   node test-ollama.ts raw  <model> "<task>"   -> /api/generate raw=true, feeding the
//        EXACT gemma4-rendered training prompt (isolates: do the weights tool-call?)
//   node test-ollama.ts chat <model> "<task>"   -> /api/chat with {role:user} messages
//        (tests the model's own TEMPLATE / renderer end-to-end)
// Greedy (temperature 0). Prints the raw completion so we can see <tool_call> blocks.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildGemmaFirstUser } from "../src/emit.ts";
import { ARGENT_POLICY_COMPACT } from "../src/system-prompt.ts";
import type { ToolSpec } from "../src/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const catalog: ToolSpec[] = JSON.parse(
  readFileSync(join(HERE, "..", "spec", "tools.json"), "utf8")
);
const TOOLS = [
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
].map((n) => catalog.find((t) => t.name === n)!);

// Exact gemma4 chat rendering (captured from the tokenizer) for a single user turn.
function gemma4Raw(userContent: string): string {
  return (
    "<bos><|turn>system\n<|think|>\n<turn|>\n" +
    "<|turn>user\n" +
    userContent +
    "<turn|>\n" +
    "<|turn>model\n"
  );
}

async function main() {
  const [mode, model, task] = process.argv.slice(2);
  if (!mode || !model || !task)
    throw new Error('usage: test-ollama.ts <raw|chat> <model> "<task>"');
  const firstUser = buildGemmaFirstUser(ARGENT_POLICY_COMPACT, TOOLS, task);

  let url: string, body: unknown;
  if (mode === "raw") {
    url = "http://127.0.0.1:11434/api/generate";
    body = {
      model,
      raw: true,
      prompt: gemma4Raw(firstUser),
      stream: false,
      options: { temperature: 0, num_predict: 160 },
    };
  } else {
    url = "http://127.0.0.1:11434/api/chat";
    body = {
      model,
      stream: false,
      messages: [{ role: "user", content: firstUser }],
      options: { temperature: 0, num_predict: 160 },
    };
  }
  const res = await fetch(url, { method: "POST", body: JSON.stringify(body) });
  const j = (await res.json()) as { response?: string; message?: { content?: string } };
  const out = j.response ?? j.message?.content ?? JSON.stringify(j);
  console.log(`=== [${mode}] ${model} | task: ${task} ===`);
  console.log(out);
}

main();
