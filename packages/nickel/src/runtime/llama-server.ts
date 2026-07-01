// Locate and spawn the local llama-server — the Nickel equivalent of argent's
// simulator-server binary handling. Same shape: a per-host binary resolved from a
// packaged bin/<platform>/ dir (env-overridable), spawned as a managed child whose
// readiness we wait on and whose lifecycle we own.
//
// The one difference from simulator-server: the MODEL (~5 GB GGUF + mmproj) is NOT
// bundled. llama-server's own `-hf` fetches and caches it under ~/.cache/llama.cpp on
// first run; `nickel init` warms that cache so the first real spawn is fast.

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { FailureError, FAILURE_CODES } from "@argent/registry";
import { LlamaClient } from "./client";

// dist/runtime/llama-server.js → ../../bin = packages/nickel/bin/<platform>/.
const BIN_DIR = process.env.NICKEL_BIN_DIR ?? path.join(__dirname, "..", "..", "bin");

// The model llama-server loads. Gemma 4 E4B: natively multimodal, so one spec covers
// both text grounding and vision (the GGUF bundles the mmproj).
export const DEFAULT_MODEL = process.env.NICKEL_MODEL ?? "ggml-org/gemma-4-E4B-it-GGUF:Q4_K_M";
export const DEFAULT_PORT = Number(process.env.NICKEL_PORT ?? 8080);

const EXE = process.platform === "win32" ? "llama-server.exe" : "llama-server";

// Host key mirrors @argent/native-devtools-ios hostPlatformKey(): process.platform,
// except arm64 Linux gets its own dir next to the x86_64 one. Kept as a local copy —
// importing the iOS devtools package for one platform switch would be the wrong
// dependency direction.
export function hostPlatformKey(): string {
  if (process.platform === "linux" && process.arch === "arm64") return "linux-arm64";
  return process.platform;
}

function whichOnPath(cmd: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, cmd);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

// Resolve the llama-server binary: explicit env → packaged bin/<platform>/ → PATH.
// Returns null when none is found (callers surface the `nickel init` hint).
export function resolveLlamaServerBin(): string | null {
  const envBin = process.env.NICKEL_LLAMA_SERVER_BIN;
  if (envBin && fs.existsSync(envBin)) return envBin;
  const packaged = path.join(BIN_DIR, hostPlatformKey(), EXE);
  if (fs.existsSync(packaged)) return packaged;
  return whichOnPath(EXE);
}

export interface SpawnLlamaOpts {
  bin: string;
  model?: string;
  port?: number;
  ngl?: number;
  readyTimeoutMs?: number;
  /** Called with each stderr line while waiting (for `init`/doctor progress). */
  onLog?: (line: string) => void;
}

export interface SpawnedLlama {
  proc: ChildProcess;
  baseUrl: string;
  client: LlamaClient;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Spawn llama-server and resolve once /health is green. We poll /health rather than
// scrape stdout so we're robust to llama.cpp log-format churn across versions. On
// first run this can block on a multi-GB model download — hence the generous default.
export function spawnLlamaServer(opts: SpawnLlamaOpts): Promise<SpawnedLlama> {
  const model = opts.model ?? DEFAULT_MODEL;
  const port = opts.port ?? DEFAULT_PORT;
  const readyTimeoutMs = opts.readyTimeoutMs ?? 300_000;
  const args = [
    "-hf",
    model,
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "-ngl",
    String(opts.ngl ?? 99),
    "--jinja",
    "--reasoning",
    "off",
  ];

  return new Promise<SpawnedLlama>((resolve, reject) => {
    const proc = spawn(opts.bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const baseUrl = `http://127.0.0.1:${port}`;
    const client = new LlamaClient(baseUrl);
    let settled = false;
    const tail: string[] = []; // last few stderr lines, surfaced on failure

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    proc.stderr?.on("data", (b: Buffer) => {
      const s = b.toString();
      for (const line of s.split("\n")) {
        if (!line.trim()) continue;
        tail.push(line);
        if (tail.length > 20) tail.shift();
        opts.onLog?.(line);
      }
    });

    proc.on("error", (err) =>
      settle(() =>
        reject(
          new FailureError(
            `llama-server failed to spawn: ${err.message}`,
            {
              error_code: FAILURE_CODES.NICKEL_LLAMA_PROCESS_ERROR,
              failure_stage: "nickel_llama_spawn",
              failure_area: "tool_server",
              error_kind: "subprocess",
            },
            { cause: err }
          )
        )
      )
    );
    proc.on("exit", (code) =>
      settle(() =>
        reject(
          new FailureError(`llama-server exited (code ${code}) before ready.\n${tail.join("\n")}`, {
            error_code: FAILURE_CODES.NICKEL_LLAMA_READY_EXITED,
            failure_stage: "nickel_llama_spawn_ready",
            failure_area: "tool_server",
            error_kind: "subprocess",
          })
        )
      )
    );

    const start = Date.now();
    void (async () => {
      while (!settled) {
        if (await client.ping(1500)) {
          settle(() => resolve({ proc, baseUrl, client }));
          return;
        }
        if (Date.now() - start > readyTimeoutMs) {
          settle(() => {
            proc.kill();
            reject(
              new FailureError(
                `llama-server not ready within ${readyTimeoutMs}ms.\n${tail.join("\n")}`,
                {
                  error_code: FAILURE_CODES.NICKEL_LLAMA_READY_TIMEOUT,
                  failure_stage: "nickel_llama_spawn_ready",
                  failure_area: "tool_server",
                  error_kind: "timeout",
                }
              )
            );
          });
          return;
        }
        await sleep(700);
      }
    })();
  });
}
