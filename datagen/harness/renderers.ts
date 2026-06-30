// Per-harness renderers: RawTrajectory -> gemma4-template-ready {messages, tools}.
//
// One RawTrajectory renders into up to 4 training rows, one per harness. All four emit
// the SAME wire schema (messages with roles system/user/assistant(+tool_calls)/tool, and a
// `tools` JSON-schema list) because silver is served via ollama + the gemma4 chat template,
// which renders tool_calls with arguments-as-OBJECT regardless of harness.
//   • tool NAMES vary per harness: argent_X | mcp__argent__X | X(de-dashed) | mcp_argent_X.
//   • tool RESULTS do NOT vary: every row uses the REAL opencode serve format (the serve+eval
//     harness), verified byte-for-byte against live silver-bench transcripts (see renderObservation).
//     The old per-harness "result junk" (Cannot-read-image / [image] / [screenshot]) was FICTION the
//     model never sees at inference — the train↔serve mismatch that made silver lose to the base.

import type { RawTrajectory, RawStep } from "../src/raw.ts";
import type { ToolSpec } from "../src/types.ts";
import { DESCRIBE_HEADER_NOTE } from "../src/format.ts";

export type HarnessName = "opencode" | "claude-code" | "codex" | "hermes";
export const HARNESSES: HarnessName[] = ["opencode", "claude-code", "codex", "hermes"];

export interface RenderOpts {
  /** Keep assistant `thought` on tool-call turns. Default false (no-narration — what fixed
   *  multi-step behaviour last run: prose-free tool turns so the model never confuses
   *  mid-task narration with a narration-only final answer and stops early). */
  narration?: boolean;
}

interface NativeMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: Record<string, unknown> };
  }[];
}
export interface NativeRecord {
  messages: NativeMessage[];
  tools: { type: "function"; function: { name: string; description: string; parameters: unknown } }[];
  // a tag the driver uses for stats / per-harness split (not part of the training row)
  _harness?: HarnessName;
}

/** Canonical Argent tool name -> the name this harness puts on the wire. */
export function mapToolName(harness: HarnessName, canonical: string): string {
  switch (harness) {
    case "opencode":
      return `argent_${canonical}`; // dashes preserved: argent_gesture-tap
    case "claude-code":
      return `mcp__argent__${canonical}`; // dashes preserved: mcp__argent__gesture-tap
    case "codex":
      return canonical.replace(/-/g, "_"); // de-dashed: gesture_tap, list_devices
    case "hermes":
      return `mcp_argent_${canonical.replace(/-/g, "_")}`; // mcp_argent_gesture_tap
  }
}

// Full MCP descriptions are verbose paragraphs (~260 tok/tool → ~3900 tok for 15 tools, which
// alone overflows the memory-bound SEQ). The model keys on tool NAME + params, not the prose, so
// we send a compact first-line description (≤120 chars). Inference still works against verbose
// real descriptions — extra context, not a contradiction.
function compactDesc(desc: string): string {
  const d = desc ?? "";
  // Rich mode (ARGENT_RICH_DESC=1): keep the FULL description so the model sees the facts that
  // compaction stripped (launch-app's bundle-id list incl. com.apple.Preferences, button's
  // appSwitch enum, …). The Python token-filter drops any row that overflows SEQ. Lean mode:
  // first non-empty line, ≤120 chars.
  if (process.env.ARGENT_RICH_DESC === "1") return d.trim();
  const first = d.split("\n").map((l) => l.trim()).find((l) => l.length) ?? "";
  return first.length > 120 ? first.slice(0, 117).trimEnd() + "…" : first;
}

function renderTools(harness: HarnessName, tools: ToolSpec[]): NativeRecord["tools"] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: mapToolName(harness, t.name),
      description: compactDesc(t.description),
      parameters: t.inputSchema,
    },
  }));
}

// The exact text a TEXT model receives at serve time through opencode: image content blocks are
// dropped, the remaining text blocks are concatenated with "\n\n". Verified byte-for-byte against
// real silver-bench argent transcripts. This is the SAME for every harness — the result wire format
// is opencode's (the serve+eval harness); only tool NAMES vary per harness (mapToolName).
const SCREEN_AFTER = "--- Screen after action ---";
const BASE_TS = 1782750000000; // fallback epoch-ms; real per-step timestamps come from the gym ack

function tryParseObj(text: string | undefined): unknown {
  const t = (text ?? "").trim();
  if (!t || (t[0] !== "{" && t[0] !== "[")) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

// Re-emit compact gym JSON as the real 2-space pretty form; pass non-JSON text through unchanged.
function prettyJson(text: string | undefined): string {
  const obj = tryParseObj(text);
  return obj !== null ? JSON.stringify(obj, null, 2) : (text ?? "").trim();
}

// A realistic, per-step-varied saved-artifact path. The model must NOT key on it (it differs every
// run); we only teach the surrounding shape `Saved: …/media/<digits>-<digits>.png`.
function savedPath(ts: number): string {
  const sess = (ts % 60466176).toString(36); // ~6-char base36 session tag
  return `/var/folders/by/zbhy2lxd297cvhzlg_xkpdv00000gn/T/simserver-${sess}/media/${ts % 1000000000}-${ts + 1583}.png`;
}

// Rebuild a describe with the EXACT canonical 5-line preamble. Real-capture describes were baked with
// an older 1-line note; gym describes already match (idempotent). Everything from ROOT onward — the
// real, possibly messy tree body — is kept verbatim.
function normalizeDescribe(text: string): { tree: string; source: string } {
  const source = text.match(/^Source:\s*(.+)$/m)?.[1]?.trim() ?? "ax-service";
  const mode = text.match(/^Mode:\s*(.+)$/m)?.[1]?.trim() ?? "flat";
  const rootIdx = text.search(/^ROOT\b/m);
  if (rootIdx < 0) return { tree: text, source }; // unknown shape — leave as-is
  const body = text.slice(rootIdx).replace(/\n+$/, "\n");
  const header = [`Source: ${source}`, `Mode: ${mode}`, ...DESCRIBE_HEADER_NOTE, ""].join("\n");
  return { tree: `${header}\n${body}`, source };
}

const ACK_VERB: Record<string, string> = {
  "gesture-tap": "tapped", "gesture-swipe": "swiped", "gesture-scroll": "scrolled",
  "gesture-pinch": "pinched", "gesture-rotate": "rotated", "gesture-drag": "dragged",
  "gesture-custom": "performed", "button": "pressed", "run-sequence": "ran", "rotate": "rotated",
};
// Synthesize the real result ack for an interaction tool whose capture didn't record one (real rows).
function synthAck(name: string, args: Record<string, unknown>, ts: number): Record<string, unknown> {
  if (name === "launch-app" || name === "restart-app") return { launched: true, bundleId: args.bundleId ?? "" };
  if (name === "reinstall-app") return { reinstalled: true, bundleId: args.bundleId ?? "" };
  if (name === "open-url") return { opened: true, url: args.url ?? "" };
  if (name === "keyboard") {
    const t = String(args.text ?? args.key ?? "");
    return { typed: args.text ?? args.key ?? "", keys: t.length };
  }
  return { [ACK_VERB[name] ?? "ok"]: true, timestampMs: ts };
}

/** Render one step's observation into the EXACT text the model receives at serve time (opencode +
 *  a text model). Verified against real benchmark transcripts:
 *    describe          → { "description": <tree incl. 5-line preamble>, "source": <src> } (2-sp JSON)
 *    screen-changing   → <result ack JSON>\n\n--- Screen after action ---\n\nSaved: <path>
 *    screenshot        → Saved: <path>
 *    other JSON        → 2-space pretty JSON  (list-devices, status, recoverable errors) */
function renderObservation(
  step: RawStep,
  shotCounter: { n: number }
): { content: string; extra: NativeMessage[] } {
  const obs = step.observation;
  const name = step.call.name; // canonical Argent tool name

  if (name === "describe") {
    const { tree, source } = normalizeDescribe(obs.text ?? "");
    return { content: JSON.stringify({ description: tree, source }, null, 2), extra: [] };
  }

  if (name === "screenshot") {
    const shot = ++shotCounter.n;
    return { content: `Saved: ${savedPath(BASE_TS + shot * 1000)}`, extra: [] };
  }

  // Screen-changing tools auto-attach a screenshot (image dropped → its Saved-path text remains).
  if (obs.hasScreenshot) {
    const shot = ++shotCounter.n;
    const ts0 = BASE_TS + shot * 1000;
    let ack = tryParseObj(obs.text) as Record<string, unknown> | null;
    if (!ack) ack = synthAck(name, (step.call.arguments ?? {}) as Record<string, unknown>, ts0); // real rows
    const ts = typeof ack.timestampMs === "number" ? (ack.timestampMs as number) : ts0;
    return { content: `${JSON.stringify(ack, null, 2)}\n\n${SCREEN_AFTER}\n\nSaved: ${savedPath(ts)}`, extra: [] };
  }

  return { content: prettyJson(obs.text), extra: [] };
}

/** Render a RawTrajectory into one harness's {messages, tools} training record. */
export function render(
  raw: RawTrajectory,
  harness: HarnessName,
  opts: RenderOpts = {}
): NativeRecord {
  const messages: NativeMessage[] = [];
  messages.push({ role: "system", content: raw.policy });
  messages.push({ role: "user", content: raw.task });

  const shotCounter = { n: 0 };
  let call = 0;
  for (const step of raw.steps) {
    const id = `call_${++call}`;
    const wireName = mapToolName(harness, step.call.name);
    messages.push({
      role: "assistant",
      content: opts.narration && step.thought ? step.thought : "",
      tool_calls: [
        { id, type: "function", function: { name: wireName, arguments: step.call.arguments } },
      ],
    });
    const { content, extra } = renderObservation(step, shotCounter);
    const toolMsg: NativeMessage = { role: "tool", tool_call_id: id, content };
    if (harness === "hermes") toolMsg.name = wireName; // hermes tool results carry the name
    messages.push(toolMsg);
    for (const e of extra) messages.push(e);
  }

  if (raw.finalAnswer) messages.push({ role: "assistant", content: raw.finalAnswer });

  return { messages, tools: renderTools(harness, raw.tools), _harness: harness };
}

/** Render all four harnesses for one trajectory. */
export function renderAll(raw: RawTrajectory, opts: RenderOpts = {}): NativeRecord[] {
  return HARNESSES.map((h) => render(raw, h, opts));
}
