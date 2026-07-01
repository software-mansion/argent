// The Nickel runtime as an argent blueprint — same lifecycle as simulator-server /
// ax-service: lazy-created on first use, health-managed, torn down on idle.
//
// Two modes, chosen automatically:
//   ATTACH — a llama-server is already reachable (a manually-run one, or a previous
//            spawn). We use it and don't own it (dispose is a no-op). Forced when
//            NICKEL_LLAMA_URL is set explicitly.
//   SPAWN  — nothing is listening, so we start the packaged llama-server ourselves,
//            wait for /health, and own it (dispose kills it; exit → `terminated`).
// This keeps Nickel self-contained by default while leaving an escape hatch for a
// hand-managed or remote server.

import { TypedEventEmitter, FailureError, FAILURE_CODES } from "@argent/registry";
import type {
  ServiceBlueprint,
  ServiceInstance,
  ServiceEvents,
  ServiceRef,
} from "@argent/registry";
import { LlamaClient } from "./client";
import {
  resolveLlamaServerBin,
  spawnLlamaServer,
  DEFAULT_MODEL,
  DEFAULT_PORT,
} from "./llama-server";

export const LLAMA_RUNTIME_NAMESPACE = "LlamaRuntime";

export interface LlamaContext {
  model?: string;
}

export type LlamaApi = LlamaClient;

/** ServiceRef helper a tool's `services()` returns to declare it needs the runtime. */
export function llamaRuntimeRef(ctx: LlamaContext = {}): ServiceRef {
  return { urn: `${LLAMA_RUNTIME_NAMESPACE}:${ctx.model ?? "default"}`, options: { ...ctx } };
}

const noEvents = () => new TypedEventEmitter<ServiceEvents>();

export const llamaRuntimeBlueprint: ServiceBlueprint<LlamaApi, LlamaContext> = {
  namespace: LLAMA_RUNTIME_NAMESPACE,
  getURN(ctx) {
    return `${LLAMA_RUNTIME_NAMESPACE}:${ctx?.model ?? "default"}`;
  },
  async factory(_deps, _payload, options): Promise<ServiceInstance<LlamaApi>> {
    const opts = options as unknown as LlamaContext | undefined;
    const explicit = process.env.NICKEL_LLAMA_URL;
    const url = explicit ?? `http://127.0.0.1:${DEFAULT_PORT}`;

    // ATTACH: a server is already up (or the user pinned NICKEL_LLAMA_URL) — use it as-is.
    const existing = new LlamaClient(url);
    if (await existing.ping(1500)) {
      return { api: existing, dispose: async () => {}, events: noEvents() };
    }
    if (explicit) {
      throw new FailureError(
        `Nickel runtime: NICKEL_LLAMA_URL is set to ${explicit} but no server answered /health there. ` +
          `Start it, or unset NICKEL_LLAMA_URL to let Nickel spawn its own.`,
        {
          error_code: FAILURE_CODES.NICKEL_LLAMA_URL_UNREACHABLE,
          failure_stage: "nickel_llama_attach",
          failure_area: "tool_server",
          error_kind: "network",
        }
      );
    }

    // SPAWN: bring up our own managed llama-server.
    const bin = resolveLlamaServerBin();
    if (!bin) {
      throw new FailureError(
        `Nickel runtime: no llama-server found and none running at ${url}.\n` +
          `Run \`nickel init\` to set it up, install llama.cpp (\`brew install llama.cpp\`), ` +
          `set NICKEL_LLAMA_SERVER_BIN to the binary, or point NICKEL_LLAMA_URL at a running server.`,
        {
          error_code: FAILURE_CODES.NICKEL_LLAMA_BINARY_NOT_FOUND,
          failure_stage: "nickel_llama_resolve_binary",
          failure_area: "tool_server",
          error_kind: "dependency_missing",
        }
      );
    }
    const { proc, client } = await spawnLlamaServer({
      bin,
      model: opts?.model ?? DEFAULT_MODEL,
      port: DEFAULT_PORT,
    });
    const events = noEvents();
    proc.on("exit", (code) =>
      events.emit(
        "terminated",
        new FailureError(`llama-server exited with code ${code}`, {
          error_code: FAILURE_CODES.NICKEL_LLAMA_TERMINATED,
          failure_stage: "nickel_llama_process_exit",
          failure_area: "tool_server",
          error_kind: "subprocess",
        })
      )
    );
    proc.on("error", (err) => events.emit("terminated", err));
    return {
      api: client,
      dispose: async () => {
        proc.kill();
      },
      events,
    };
  },
};
