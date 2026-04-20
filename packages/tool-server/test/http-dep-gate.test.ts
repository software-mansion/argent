import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { Registry } from "@argent/registry";
import { z } from "zod";

const execFileMock = vi.fn();
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFile: (...args: unknown[]) => execFileMock(...args) };
});

import { createHttpApp } from "../src/http";
import {
  DependencyMissingError,
  __resetDepCacheForTests,
  ensureDep,
} from "../src/utils/check-deps";

function stubProbe(missing: readonly string[]): void {
  execFileMock.mockImplementation(
    (
      _cmd: string,
      args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout?: string, stderr?: string) => void
    ) => {
      const script = args[1] ?? "";
      const dep = script.replace("command -v ", "").trim();
      if (missing.includes(dep)) cb(new Error(`not found: ${dep}`));
      else cb(null, `/usr/bin/${dep}\n`, "");
    }
  );
}

describe("http dependency gate", () => {
  beforeEach(() => {
    __resetDepCacheForTests();
    execFileMock.mockReset();
  });

  it("returns 424 with a pretty message when a pre-flight dep is missing", async () => {
    stubProbe(["adb"]);
    const registry = new Registry();
    registry.registerTool({
      id: "android-thing",
      requires: ["adb"],
      zodSchema: z.object({}),
      services: () => ({}),
      async execute() {
        // Should never run — the dep gate blocks the request before execute.
        throw new Error("execute should have been skipped");
      },
    });
    const { app } = createHttpApp(registry);
    const res = await request(app).post("/tools/android-thing").send({});
    expect(res.status).toBe(424);
    expect(res.body.error).toMatch(/android-platform-tools/);
  });

  it("invokes the tool normally when declared deps are present", async () => {
    stubProbe([]);
    const registry = new Registry();
    registry.registerTool({
      id: "ios-thing",
      requires: ["xcrun"],
      zodSchema: z.object({}),
      services: () => ({}),
      async execute() {
        return { ran: true };
      },
    });
    const { app } = createHttpApp(registry);
    const res = await request(app).post("/tools/ios-thing").send({});
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ ran: true });
  });

  it("surfaces a DependencyMissingError thrown from inside execute (post-classify path) as 424", async () => {
    // Two probes expected: the first stubs all missing; the second call (for
    // the cross-platform tool's in-execute ensureDep) re-probes adb and finds
    // it still missing. This is the cross-platform tool pattern: `requires`
    // is absent so the pre-flight gate doesn't fire, and the dep check
    // happens after classifyDevice has picked android.
    stubProbe(["adb"]);
    const registry = new Registry();
    registry.registerTool({
      id: "cross-platform-thing",
      zodSchema: z.object({}),
      services: () => ({}),
      async execute() {
        // Simulate the classify → ensureDep pattern used by launch-app etc.
        await ensureDep("adb");
        return { ran: true };
      },
    });
    const { app } = createHttpApp(registry);
    const res = await request(app).post("/tools/cross-platform-thing").send({});
    expect(res.status).toBe(424);
    expect(res.body.error).toMatch(/android-platform-tools/);
  });

  it("does not call the dep probe for tools without a `requires` declaration", async () => {
    stubProbe([]);
    const registry = new Registry();
    registry.registerTool({
      id: "no-deps",
      zodSchema: z.object({}),
      services: () => ({}),
      async execute() {
        return { ran: true };
      },
    });
    const { app } = createHttpApp(registry);
    const res = await request(app).post("/tools/no-deps").send({});
    expect(res.status).toBe(200);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("DependencyMissingError is still an Error — callers relying on err.message keep working", () => {
    const err = new DependencyMissingError(["xcrun"], "install Xcode");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("install Xcode");
    expect(err.missing).toEqual(["xcrun"]);
  });
});
