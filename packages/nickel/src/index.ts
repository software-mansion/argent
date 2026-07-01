// @argent/nickel — Argent's local-VLM minion, exposed as argent tools.
export { registerNickel } from "./register";
export {
  llamaRuntimeBlueprint,
  llamaRuntimeRef,
  LLAMA_RUNTIME_NAMESPACE,
} from "./runtime/llama-runtime";
export { LlamaClient } from "./runtime/client";
export type { NickelResult } from "./protocol";
