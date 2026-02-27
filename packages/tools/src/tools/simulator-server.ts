import { z } from "zod";
import { Tool } from "../types";

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

interface ProcessEntry {
  proc: ChildProcess;
  streamUrl: string;
  apiUrl: string;
}

// Module-level registry keyed by UDID — reused across tool calls
const processRegistry = new Map<string, ProcessEntry>();

const zodSchema = z.object({
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
  description:
    "Launch (or reuse) the simulator-server process for a given simulator UDID and return its API and stream URLs",
  inputSchema,
  outputSchema,
  async execute(input, signal) {
    const existing = processRegistry.get(input.udid);
    if (existing) {
      return { udid: input.udid, apiUrl: existing.apiUrl, streamUrl: existing.streamUrl };
    }
    const result = await spawnAndWait(input.udid, input.token, signal);
    return { udid: input.udid, ...result };
  },
};

function spawnAndWait(
  udid: string,
  token: string | undefined,
  signal: AbortSignal | undefined
): Promise<{ apiUrl: string; streamUrl: string }> {
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

    const settle = (
      fn: () => void,
      cleanup?: () => void
    ) => {
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
          const entry: ProcessEntry = { proc, streamUrl: streamUrl!, apiUrl: apiUrl! };
          processRegistry.set(udid, entry);
          proc.on("exit", () => processRegistry.delete(udid));
          resolve({ apiUrl: apiUrl!, streamUrl: streamUrl! });
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
      settle(() => reject(new Error(`simulator-server exited with code ${code} before becoming ready`)));
    });

    proc.on("error", (err) => {
      settle(() => reject(err));
    });

    const timer = setTimeout(() => {
      settle(
        () => reject(new Error("Timed out waiting for simulator-server to become ready")),
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
