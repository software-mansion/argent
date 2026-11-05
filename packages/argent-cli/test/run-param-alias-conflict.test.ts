import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as http from "node:http";
import { run } from "../src/run.js";

// #1794: a call that sets a param under both its former and its current name
// (`flow_path` and `e2e_test_path`) is refused by the tools client before it is
// sent. `argent run` must report that refusal as it reports any rejected input:
// exit 2, and with `--json` one JSON object on stderr. Driven through the real
// tools client against a stub tool-server, because the refusal happens there.

const telemetryMock = vi.hoisted(() => ({
  init: vi.fn(),
  shutdown: vi.fn(async () => undefined),
  track: vi.fn(),
}));

vi.mock("@argent/telemetry", () => telemetryMock);

const MESSAGE = "Pass e2e_test_path or its former name flow_path, not both.";

/** The schema e2e-execute lists: the current names only. */
const e2eExecute = {
  name: "e2e-execute",
  description: "Run an e2e test",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      e2e_test_path: { type: "string" },
      project_root: { type: "string" },
      device: { type: "string" },
    },
    required: ["project_root", "device"],
  },
};

function startServer(posts: string[]): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.url === "/tools" && req.method === "GET") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ tools: [e2eExecute] }));
      return;
    }
    posts.push(req.url ?? "");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: { ok: true } }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

describe("argent run with both names of one param (#1794)", () => {
  let server: { url: string; close: () => Promise<void> };
  let posts: string[];
  let errors: string[];
  let logs: string[];
  const spies: Array<{ mockRestore: () => void }> = [];

  const both = [
    "e2e-execute",
    "--project_root",
    "/p",
    "--device",
    "emulator-5554",
    "--e2e_test_path",
    "/p/.argent/e2e/t.yaml",
    "--flow_path",
    "/p/.argent/e2e/t.yaml",
  ];
  const invoke = (argv: string[]) => run(argv, { paths: {} as never });

  beforeEach(async () => {
    vi.clearAllMocks();
    posts = [];
    errors = [];
    logs = [];
    server = await startServer(posts);
    vi.stubEnv("ARGENT_TOOLS_URL", server.url);
    spies.push(
      vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
        throw new Error(`process.exit:${code}`);
      }) as typeof process.exit),
      vi.spyOn(console, "error").mockImplementation((...a) => void errors.push(a.join(" "))),
      vi.spyOn(console, "log").mockImplementation((...a) => void logs.push(a.join(" ")))
    );
  });

  afterEach(async () => {
    for (const spy of spies.splice(0)) spy.mockRestore();
    vi.unstubAllEnvs();
    await server.close();
  });

  it("exits 2 with one JSON object on stderr under --json, and sends nothing", async () => {
    await expect(invoke([...both, "--json"])).rejects.toThrow("process.exit:2");

    expect(posts).toEqual([]);
    expect(logs).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(JSON.parse(errors[0]!)).toEqual({
      error: MESSAGE,
      missing: [],
      issues: [{ code: "custom", path: [], message: MESSAGE }],
    });
    expect(telemetryMock.track).toHaveBeenCalledWith(
      "cli:run_fail",
      expect.objectContaining({
        tool: "e2e-execute",
        error_code: "CLI_RUN_INPUT_VALIDATION_FAILED",
        error_kind: "validation",
      })
    );
  });

  it("exits 2 with the message and the tool's help without --json", async () => {
    await expect(invoke(both)).rejects.toThrow("process.exit:2");

    expect(posts).toEqual([]);
    expect(errors.join("\n")).toContain(`Error: ${MESSAGE}`);
    expect(logs.join("\n")).toContain("argent run e2e-execute [flags]");
  });
});
