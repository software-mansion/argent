import { spawn } from "node:child_process";
import * as path from "node:path";
import * as readline from "node:readline";
import { z } from "zod";
import { Tool } from "../types";
import {
  SimulatorEntry,
  setProcess,
  deleteProcess,
  registerSpawnFn,
} from "../simulator-registry";

// Binary lives in the project root (four levels up from dist/tools/ at runtime)
const BINARY_PATH = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "simulator-server"
);
const BINARY_DIR = path.join(__dirname, "..", "..", "..", "..");

const READY_TIMEOUT_MS = 30_000;

const inputSchema = z.object({
  udid: z.string().describe("The UDID of the simulator to connect to"),
  token: z
    .string()
    .optional()
    .describe("JWT license token for Pro features (screenshot, recording)"),
});

const outputSchema = z.object({
  udid: z.string(),
  apiUrl: z.string(),
  streamUrl: z.string(),
});

export const simulatorServerTool: Tool<
  typeof inputSchema,
  z.infer<typeof outputSchema>
> = {
  name: "simulator-server",
  description: `Get (or start) the simulator-server for a UDID.
Returns { apiUrl, streamUrl }. If no server is running for this UDID, one is started automatically.
Use this explicitly to pass a JWT token for Pro features (screenshot, recording).
All other tools also trigger auto-start without a token if needed.`,
  inputSchema,
  outputSchema,
  async execute(input, signal) {
    const result = await spawnAndWait(input.udid, input.token, signal);
    return { udid: input.udid, apiUrl: result.apiUrl, streamUrl: result.streamUrl };
  },
};

function spawnAndWait(
  udid: string,
  token: string | undefined,
  signal: AbortSignal | undefined
): Promise<SimulatorEntry> {
  return new Promise((resolve, reject) => {
    const args = ["ios", "--id", udid];
    if (token) args.push("-t", token);

    const proc = spawn(BINARY_PATH, args, {
      cwd: BINARY_DIR,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let streamUrl: string | null = null;
    let apiUrl: string | null = null;
    let settled = false;

    const rl = readline.createInterface({ input: proc.stdout! });

    const settle = (fn: () => void, cleanup?: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.close();
      cleanup?.();
      fn();
    };

    const tryResolve = () => {
      if (streamUrl && apiUrl) {
        settle(() => {
          const entry: SimulatorEntry = {
            proc,
            udid,
            streamUrl: streamUrl!,
            apiUrl: apiUrl!,
          };
          setProcess(entry);
          proc.on("exit", () => deleteProcess(udid));
          resolve(entry);
        });
      }
    };

    rl.on("line", (rawLine: string) => {
      const line = rawLine.trim();

      if (line.startsWith("stream_ready ")) {
        const match = line.match(/(http:\/\/[^ ]+)/);
        if (match) {
          streamUrl = match[1]!;
          // Derive base URL so tryResolve() can succeed without api_ready
          if (!apiUrl) {
            const u = new URL(streamUrl);
            apiUrl = `${u.protocol}//${u.host}`;
          }
          tryResolve();
        }
        return;
      }

      if (line.startsWith("api_ready ")) {
        const match = line.match(/(http:\/\/[^ ]+)/);
        if (match) {
          apiUrl = match[1]!;
          tryResolve();
        }
        return;
      }
    });

    proc.stderr?.on("data", (data: Buffer) => {
      process.stderr.write(`[sim ${udid.slice(0, 8)}] ${data}`);
    });

    proc.on("exit", (code) => {
      settle(() =>
        reject(
          new Error(
            `simulator-server exited with code ${code} before becoming ready`
          )
        )
      );
    });

    proc.on("error", (err) => {
      settle(() => reject(err));
    });

    const timer = setTimeout(() => {
      settle(
        () =>
          reject(
            new Error("Timed out waiting for simulator-server to become ready")
          ),
        () => proc.kill()
      );
    }, READY_TIMEOUT_MS);

    signal?.addEventListener("abort", () => {
      settle(
        () => reject(new DOMException("Aborted", "AbortError")),
        () => proc.kill()
      );
    });
  });
}

// Register spawn function so other tools can call ensureServer()
registerSpawnFn(spawnAndWait);
