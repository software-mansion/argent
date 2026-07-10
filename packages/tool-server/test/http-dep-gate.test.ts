import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { Registry } from "@argent/registry";
import { z } from "zod";

const execFileMock = vi.fn();
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFile: (...args: unknown[]) => execFileMock(...args) };
});

// `probe()` special-cases adb/emulator to use `resolveAndroidBinary`
// (which adds an `$ANDROID_HOME` fallback to PATH). Mock the resolver so
// each test controls availability per-dep instead of fighting the host's
// real $ANDROID_HOME.
const resolveAndroidBinaryMock = vi.fn();
vi.mock("../src/utils/android-binary", () => ({
  resolveAndroidBinary: (name: "adb" | "emulator") => resolveAndroidBinaryMock(name),
  __resetAndroidBinaryCacheForTesting: () => {},
}));

import { createHttpApp } from "../src/http";
import {
  DependencyMissingError,
  __resetDepCacheForTests,
  ensureDep,
} from "../src/utils/check-deps";
import { InvalidToolInputError } from "../src/utils/capability";

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
  resolveAndroidBinaryMock.mockImplementation(async (name: string) => {
    return missing.includes(name) ? null : `/usr/bin/${name}`;
  });
}

describe("http dependency gate", () => {
  beforeEach(() => {
    __resetDepCacheForTests();
    execFileMock.mockReset();
    resolveAndroidBinaryMock.mockReset();
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

  it("records a static failure signal when a pre-flight dep is missing", async () => {
    stubProbe(["adb"]);
    const recordFailure = vi.fn();
    const registry = new Registry();
    registry.registerTool({
      id: "android-thing",
      requires: ["adb"],
      zodSchema: z.object({}),
      services: () => ({}),
      async execute() {
        throw new Error("execute should have been skipped");
      },
    });
    const { app } = createHttpApp(registry, { recordFailure });
    const res = await request(app).post("/tools/android-thing").send({});
    expect(res.status).toBe(424);
    expect(recordFailure).toHaveBeenCalledWith(
      "android-thing",
      {},
      {
        error_code: "HTTP_DEPENDENCY_PREFLIGHT_MISSING",
        failure_stage: "http_dependency_preflight",
        failure_area: "http",
        error_kind: "dependency_missing",
      },
      expect.any(Number)
    );
  });

  it("records a static failure signal when request validation fails", async () => {
    stubProbe([]);
    const recordFailure = vi.fn();
    const registry = new Registry();
    registry.registerTool({
      id: "validated-thing",
      zodSchema: z.object({ count: z.number() }),
      services: () => ({}),
      async execute() {
        throw new Error("execute should have been skipped");
      },
    });
    const { app } = createHttpApp(registry, { recordFailure });
    const res = await request(app).post("/tools/validated-thing").send({ count: "nope" });
    expect(res.status).toBe(400);
    expect(recordFailure).toHaveBeenCalledWith(
      "validated-thing",
      {},
      {
        error_code: "HTTP_ZOD_VALIDATION_FAILED",
        failure_stage: "http_zod_validation",
        failure_area: "http",
        error_kind: "validation",
      },
      expect.any(Number)
    );
    expect(JSON.stringify(recordFailure.mock.calls)).not.toContain("Expected number");
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

  it("maps an InvalidToolInputError thrown from execute to 400, not 500", async () => {
    // A tool rejecting its (well-typed) arguments — e.g. a newline / non-ASCII
    // char in Android `keyboard` text, an unknown named key — is a client input
    // error, not an internal fault. It reaches the dispatcher wrapped in
    // ToolExecutionError, so the mapping must walk the cause chain.
    stubProbe([]);
    const recordFailure = vi.fn();
    const registry = new Registry();
    registry.registerTool({
      id: "picky-input",
      zodSchema: z.object({}),
      services: () => ({}),
      async execute() {
        throw new InvalidToolInputError("that argument can't be carried out on this device");
      },
    });
    const { app } = createHttpApp(registry, { recordFailure });
    const res = await request(app).post("/tools/picky-input").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("that argument can't be carried out on this device");
    // An InvalidToolInputError thrown FROM execute() is recorded once, by the
    // registry's failure listener (the error carries its own signal out of
    // execute) — the HTTP layer must NOT also record it, or the failure
    // double-counts. `emitHttpFailure` fires only on pre-execute HTTP-layer
    // faults (zod / capability / device-resolution / dep-preflight), never on
    // this execute-catch 400 path.
    expect(recordFailure).not.toHaveBeenCalled();
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

  it("prefers 424 over 400 when a dependency error is nested under an InvalidToolInputError", async () => {
    // Pins the ordering invariant documented at the dispatcher's
    // InvalidToolInputError → 400 check (http.ts): `findDependencyMissing`
    // scans the WHOLE cause chain first, so for a chain carrying both classes
    // the 424 wins. Reordering the two checks — or a throw site nesting a
    // DependencyMissingError under an InvalidToolInputError — flips this test
    // instead of silently flipping the status code.
    stubProbe([]);
    const registry = new Registry();
    registry.registerTool({
      id: "dual-class-error",
      zodSchema: z.object({}),
      services: () => ({}),
      async execute() {
        const err = new InvalidToolInputError(
          "that argument needs a missing dependency"
        ) as InvalidToolInputError & { cause?: unknown };
        err.cause = new DependencyMissingError(["adb"], "install adb please");
        throw err;
      },
    });
    const { app } = createHttpApp(registry);
    const res = await request(app).post("/tools/dual-class-error").send({});
    expect(res.status).toBe(424);
    expect(res.body.error).toBe("install adb please");
  });

  it("still returns 424 when the DependencyMissingError is buried two levels deep in the cause chain", async () => {
    // The registry wraps execute() errors in ToolExecutionError with `cause`.
    // If a future middleware adds a second wrap (or something else does), a
    // naive one-level `.cause` check regresses 424 → 500. Walk the chain.
    stubProbe([]);
    const registry = new Registry();
    registry.registerTool({
      id: "double-wrap",
      zodSchema: z.object({}),
      services: () => ({}),
      async execute() {
        const inner = new DependencyMissingError(["adb"], "install adb please");
        const middle = new Error("outer wrap") as Error & { cause?: unknown };
        middle.cause = inner;
        const outer = new Error("tool failed") as Error & { cause?: unknown };
        outer.cause = middle;
        throw outer;
      },
    });
    const { app } = createHttpApp(registry);
    const res = await request(app).post("/tools/double-wrap").send({});
    expect(res.status).toBe(424);
    expect(res.body.error).toBe("install adb please");
  });
});
