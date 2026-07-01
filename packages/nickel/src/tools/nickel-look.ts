// nickel-look — inspect the current screen. Returns the on-screen element labels,
// and (with a question) a short answer. The question is answered by VISION by default
// — Gemma 4 is a VLM, so a screenshot answers "what colour / is X visible / does this
// look right" that the accessibility tree alone can't. Pass vision:false to answer from
// the tree text instead (faster, no screenshot) for structural questions.

import { z } from "zod";
import type { Registry, ToolDefinition, ToolContext } from "@argent/registry";
import { llamaRuntimeRef, type LlamaApi } from "../runtime/llama-runtime";
import { renderTree, labels } from "../describe/screen";
import { groundAction } from "../grounding/ground";
import { captureImage } from "../runtime/vision";
import { bindInvoke, observeScreen } from "../invoke";

const zodSchema = z.object({
  udid: z.string().describe("Target device id from `list-devices`."),
  question: z.string().optional().describe("Optional question about the screen."),
  vision: z
    .boolean()
    .optional()
    .describe(
      "Answer the question by looking at a screenshot (default true); false = tree text only."
    ),
});
type Params = z.infer<typeof zodSchema>;

export interface NickelLookResult {
  screen: string[];
  answer?: string;
  used_vision: boolean;
  latency_ms: number;
}

const VISION_SYSTEM =
  "You are looking at a screenshot of a mobile app screen. Answer the question about what " +
  "you see concisely and factually. If the answer is not visible, say so.";

export function createNickelLookTool(registry: Registry): ToolDefinition<Params, NickelLookResult> {
  return {
    id: "nickel-look",
    description:
      "Inspect the current screen via the local Nickel minion: returns the on-screen element " +
      "labels, and (with a question) a short answer. Visual questions are answered by looking at " +
      "a screenshot (Gemma 4 vision); pass vision:false to answer from the accessibility tree only.",
    featureFlag: "nickel",
    zodSchema,
    services: () => ({ llama: llamaRuntimeRef() }),
    async execute(services, params, ctx?: ToolContext): Promise<NickelLookResult> {
      const llama = services.llama as LlamaApi;
      const invoke = bindInvoke(registry, ctx);

      const t = Date.now();
      const screen = await observeScreen(invoke, params.udid);

      let answer: string | undefined;
      let usedVision = false;
      if (params.question) {
        const wantVision = params.vision !== false;
        const image = wantVision ? await captureImage(invoke, params.udid) : undefined;
        if (image) {
          const r = await llama.chat({
            system: VISION_SYSTEM,
            user: params.question,
            image,
            maxTokens: 200,
          });
          answer = r.text.trim();
          usedVision = true;
        } else {
          // No screenshot (or vision:false) — fall back to the tree text.
          const g = await groundAction(
            llama,
            renderTree(screen),
            `${params.question} Answer briefly.`
          );
          answer = String((g.call as { value?: string } | null)?.value ?? g.raw);
        }
      }

      return {
        screen: labels(screen).slice(0, 40),
        answer,
        used_vision: usedVision,
        latency_ms: Date.now() - t,
      };
    },
  };
}
