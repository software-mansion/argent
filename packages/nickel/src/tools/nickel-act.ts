// nickel-act — one mundane action (pure System-1 reflex: ground + execute).

import { z } from "zod";
import type { Registry, ToolDefinition, ToolContext } from "@argent/registry";
import { llamaRuntimeRef, type LlamaApi } from "../runtime/llama-runtime";
import { renderTree, labels } from "../describe/screen";
import { groundAction, type ToolCall } from "../grounding/ground";
import { executeGrounded } from "../act/execute";
import { bindInvoke, observeScreen } from "../invoke";

const zodSchema = z.object({
  udid: z.string().describe("Target device id from `list-devices`."),
  instruction: z
    .string()
    .describe(
      'One short UI action, e.g. "tap the Login button" or "type hello into the search field".'
    ),
});
type Params = z.infer<typeof zodSchema>;

export interface NickelActResult {
  did: string;
  resolved: boolean;
  action: ToolCall;
  screen: string[];
  latency: { ground_ms: number; exec_ms: number };
}

export function createNickelActTool(registry: Registry): ToolDefinition<Params, NickelActResult> {
  return {
    id: "nickel-act",
    description:
      "Delegate ONE concrete UI action to the local Nickel minion: tap an element, type into " +
      "a field, or swipe. Give a short natural-language instruction; Nickel grounds it against " +
      "the live screen and executes it. Returns what it did and the resulting on-screen elements.",
    featureFlag: "nickel",
    zodSchema,
    services: () => ({ llama: llamaRuntimeRef() }),
    async execute(services, params, ctx?: ToolContext): Promise<NickelActResult> {
      const llama = services.llama as LlamaApi;
      const invoke = bindInvoke(registry, ctx);

      const screen = await observeScreen(invoke, params.udid);
      const g = await groundAction(llama, renderTree(screen), params.instruction);
      const call = g.call ?? {};

      const tExec = Date.now();
      const out = await executeGrounded(invoke, params.udid, screen, call);
      const exec_ms = Date.now() - tExec;

      const after = out.observe ? await observeScreen(invoke, params.udid) : screen;
      return {
        did: out.did,
        resolved: out.resolved,
        action: call,
        screen: labels(after).slice(0, 24),
        latency: { ground_ms: g.latency_ms, exec_ms },
      };
    },
  };
}
