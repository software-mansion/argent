#!/usr/bin/env node
// nickel — setup + doctor CLI for the Nickel minion runtime.
//
//   nickel init     resolve the llama-server binary and WARM the model cache
//                   (first run downloads the ~5 GB Gemma-4 GGUF once), so the first
//                   real nickel-* call spawns instantly.
//   nickel doctor   report what's resolved: binary path, model, server reachability.
//
// The tool-server spawns/attaches the runtime on demand via llamaRuntimeBlueprint;
// this CLI is the one-time provisioning step, the Nickel analogue of argent's
// `download:simulator-server`.

import {
  resolveLlamaServerBin,
  spawnLlamaServer,
  hostPlatformKey,
  DEFAULT_MODEL,
  DEFAULT_PORT,
} from "./runtime/llama-server";
import { LlamaClient } from "./runtime/client";

function out(s: string) {
  process.stdout.write(s + "\n");
}

async function doctor(): Promise<number> {
  out(`Nickel doctor`);
  out(`  host:   ${hostPlatformKey()} (${process.arch})`);
  out(`  model:  ${DEFAULT_MODEL}`);
  const bin = resolveLlamaServerBin();
  const binHint =
    "NOT FOUND (set NICKEL_LLAMA_SERVER_BIN, install llama.cpp, or set NICKEL_LLAMA_URL)";
  out(`  binary: ${bin ?? binHint}`);
  const url = process.env.NICKEL_LLAMA_URL ?? `http://127.0.0.1:${DEFAULT_PORT}`;
  const up = await new LlamaClient(url).ping(1500);
  out(`  server: ${up ? `reachable at ${url}` : `not running at ${url} (will spawn on demand)`}`);
  if (up) out(`  loaded: ${await new LlamaClient(url).modelId()}`);
  return bin || up ? 0 : 1;
}

async function init(): Promise<number> {
  const url = process.env.NICKEL_LLAMA_URL ?? `http://127.0.0.1:${DEFAULT_PORT}`;
  if (await new LlamaClient(url).ping(1500)) {
    out(`✓ A llama-server is already running at ${url} — Nickel will attach to it.`);
    out(`  loaded model: ${await new LlamaClient(url).modelId()}`);
    return 0;
  }
  const bin = resolveLlamaServerBin();
  if (!bin) {
    out(`✗ No llama-server binary found.`);
    out(`  Install llama.cpp (e.g. \`brew install llama.cpp\`), then re-run \`nickel init\`.`);
    out(`  Or set NICKEL_LLAMA_SERVER_BIN to the binary, or NICKEL_LLAMA_URL to a running server.`);
    return 1;
  }
  out(`Using llama-server: ${bin}`);
  out(
    `Warming model ${DEFAULT_MODEL} (first run downloads ~5 GB; cached under ~/.cache/llama.cpp)…`
  );
  let lastPct = "";
  const spawned = await spawnLlamaServer({
    bin,
    onLog: (line) => {
      // Surface llama.cpp's download percentage without flooding the terminal.
      const m = line.match(/(\d+)%/);
      if (m && m[1] !== lastPct) {
        lastPct = m[1]!;
        process.stdout.write(`\r  downloading… ${m[1]}%   `);
      }
    },
  }).catch((e: unknown) => {
    out(`\n✗ Failed to warm the model: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  });
  if (!spawned) return 1;
  if (lastPct) process.stdout.write("\n");
  out(`✓ Model ready: ${await spawned.client.modelId()}`);
  out(`✓ Nickel ready. The tool-server will spawn this on demand (flag: nickel).`);
  spawned.proc.kill();
  return 0;
}

async function main() {
  const cmd = process.argv[2] ?? "doctor";
  let code: number;
  if (cmd === "init") code = await init();
  else if (cmd === "doctor" || cmd === "status") code = await doctor();
  else {
    out(
      `nickel — Nickel minion runtime CLI\n\nUsage:\n  nickel init     resolve + warm the local model\n  nickel doctor   report runtime status`
    );
    code = cmd === "help" || cmd === "--help" || cmd === "-h" ? 0 : 1;
  }
  process.exit(code);
}

void main();
