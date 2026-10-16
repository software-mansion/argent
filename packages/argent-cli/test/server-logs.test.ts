import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "argent-cli-server-logs-"));
  fs.mkdirSync(path.join(home, ".argent"));
  fs.writeFileSync(path.join(home, ".argent", "tool-server.log"), "listening\n");
  fs.mkdirSync(path.join(home, "empty-bin"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("PATH", path.join(home, "empty-bin"));
  // server.ts resolves the log path from the home directory at import time.
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("argent server logs --follow", () => {
  it("reports a `tail` that cannot be spawned and exits 1", async () => {
    const err: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args) => void err.push(args.join(" ")));
    const exitCode = new Promise<number | undefined>((resolve) => {
      vi.spyOn(process, "exit").mockImplementation(((code?: number) => resolve(code)) as never);
    });
    const { server } = await import("../src/server.js");

    await server(["logs", "-f"]);

    expect(await exitCode).toBe(1);
    expect(err).toEqual([
      "argent server logs: cannot run `tail` to follow the log (spawn tail ENOENT). " +
        "Run `argent server logs` without -f to print it.",
    ]);
  });
});
