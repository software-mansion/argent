import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ClientRequestLine } from "@argent/registry";
import { createClientServicesHandler } from "../src/client-services.js";

// The rename that puts a new baseline in place is the last step of a write.
// It runs for real unless a test makes it fail.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

let tmpDir: string;
let rootFlow: string;
let keyDir: string;
let baseline: string;

beforeEach(async () => {
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "client-services-write-")));
  // The run's root flow takes a snapshot, so the handler serves its baselines.
  rootFlow = path.join(tmpDir, ".argent", "flows", "login.yaml");
  keyDir = path.join(path.dirname(rootFlow), "__baselines__", "login");
  baseline = path.join(keyDir, "home__ios-390x844.png");
  await fs.mkdir(keyDir, { recursive: true });
  await fs.writeFile(rootFlow, "steps:\n  - snapshot: home\n");
});

afterEach(async () => {
  vi.mocked(fs.rename).mockClear();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function writeLine(file: string, bytes: Buffer): ClientRequestLine {
  return {
    event: "client-request",
    invocation: "inv-1",
    id: "req-1",
    op: "write-file",
    args: { path: file, content: bytes.toString("base64") },
  };
}

describe("write-file that does not finish", () => {
  it("leaves the old baseline whole and no temporary file", async () => {
    await fs.writeFile(baseline, "old");
    const handler = await createClientServicesHandler({
      roots: [tmpDir],
      rootFlow,
      advertised: ["write-file"],
      baselineDir: keyDir,
    });
    expect(handler).not.toBeNull();
    vi.mocked(fs.rename).mockRejectedValueOnce(
      Object.assign(new Error("EIO: i/o error, rename"), { code: "EIO" })
    );

    expect(await handler!.handle(writeLine(baseline, Buffer.from("new")))).toEqual({
      id: "req-1",
      ok: false,
      error: "write-file failed on this client: EIO: i/o error, rename",
    });
    expect(fs.rename).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(baseline, "utf8")).toBe("old");
    expect(await fs.readdir(keyDir)).toEqual([path.basename(baseline)]);
  });
});
