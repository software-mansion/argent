import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AUTO_DESCRIBE_HEADER } from "@argent/tools-client";
import { run } from "../src/run.js";

const SHOT = { localPath: "/tmp/after.png", data: Buffer.from("png"), mimeType: "image/png" };

const client = vi.hoisted(() => ({
  fetchTool: vi.fn(),
  callTool: vi.fn(),
  baseUrl: vi.fn(async () => ({ url: "http://127.0.0.1:1", token: "t" })),
}));

vi.mock("@argent/tools-client", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createToolsClient: vi.fn(() => client),
    materializeArtifacts: vi.fn(async (result: unknown) => ({
      result,
      images: result === "shot-handle" ? [SHOT] : [],
    })),
  };
});

vi.mock("@argent/telemetry", () => ({
  init: vi.fn(),
  shutdown: vi.fn(async () => undefined),
  track: vi.fn(),
}));

const gestureTap = {
  name: "gesture-tap",
  description: "",
  inputSchema: {
    type: "object",
    properties: { udid: { type: "string" }, x: { type: "number" }, y: { type: "number" } },
  },
};

describe("argent run after an interaction tool", () => {
  let tmp: string;
  let logs: string[];
  let errs: string[];
  const savedHome = process.env.HOME;

  beforeEach(() => {
    vi.clearAllMocks();
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "run-capture-out-")));
    fs.writeFileSync(path.join(tmp, "package.json"), "{}");
    process.env.HOME = tmp;
    vi.spyOn(process, "cwd").mockReturnValue(tmp);
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...a) => void logs.push(a.join(" ")));
    errs = [];
    vi.spyOn(console, "error").mockImplementation((...a) => void errs.push(a.join(" ")));
    client.fetchTool.mockResolvedValue(gestureTap);
    client.callTool.mockImplementation(async (name: string) => {
      if (name === "gesture-tap") return { data: { tapped: true } };
      if (name === "await-screen-idle") return { data: { settled: true } };
      if (name === "screenshot") return { data: "shot-handle" };
      return { data: { description: "button Done (0.1,0.2,0.3,0.1)" } };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env.HOME = savedHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const tapArgs = ["gesture-tap", "--udid", "SIM-1", "--x", "0.5", "--y", "0.5"];

  it("prints the result, then the screen after it settled", async () => {
    await run(tapArgs, { paths: {} as never });

    expect(logs).toEqual([
      JSON.stringify({ tapped: true }, null, 2),
      "Screen after action: /tmp/after.png",
      AUTO_DESCRIBE_HEADER,
      "button Done (0.1,0.2,0.3,0.1)",
    ]);
  });

  it("prints only the raw result with --json, without waiting", async () => {
    await run([...tapArgs, "--json"], { paths: {} as never });

    expect(logs).toEqual([JSON.stringify({ tapped: true }, null, 2)]);
    expect(client.callTool).toHaveBeenCalledTimes(1);
  });

  it("saves the screen after the action to --out", async () => {
    const out = path.join(tmp, "shots", "after.png");

    await run([...tapArgs, "--out", out], { paths: {} as never });

    expect(fs.readFileSync(out)).toEqual(SHOT.data);
    expect(logs.at(-1)).toBe(`Wrote: ${out}`);
  });

  it("says when --out was not written because no screen was captured", async () => {
    const out = path.join(tmp, "after.png");

    await run([...tapArgs, "--out", out, "--args", '{"text":"{{secret:PIN}}"}'], {
      paths: {} as never,
    });

    expect(fs.existsSync(out)).toBe(false);
    expect(logs).toEqual([JSON.stringify({ tapped: true }, null, 2)]);
    expect(errs[0]).toContain("Auto-screenshot and element tree skipped");
    expect(errs.at(-1)).toBe(`No screen was captured, so ${out} was not written.`);
  });
});
