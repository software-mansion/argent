/**
 * Integration tests proving AsyncLocalStorage-based projectRoot propagation
 * is robust across nested `registry.invokeTool` chains.
 *
 * The HTTP layer at src/http.ts wraps `registry.invokeTool` with
 * `runWithContext({ projectRoot }, invoke)` once, at request entry. From there,
 * any depth of nested invocations — including the `flow-execute` pattern at
 * src/tools/flows/flow-run.ts that loops and re-enters `registry.invokeTool`
 * inside its own execute — must see the same projectRoot via
 * `requireProjectRoot()`.
 *
 * Single-level coverage lives in http-project-root.test.ts. This file covers
 * nested depth, sync/async mixing, parallel fan-out, cross-request isolation,
 * flow-execute loops, errors mid-chain, long-running chains, and explicit
 * runWithContext re-entry overrides.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHttpApp, type HttpAppHandle } from "../src/http";
import {
  requireProjectRoot,
  runWithContext,
  getRequestContext,
} from "../src/request-context";
import type { Registry } from "@argent/registry";
import type { ToolDefinition } from "@argent/registry";

// Silence the update checker so HTTP responses stay clean.
vi.mock("../src/utils/update-checker", () => ({
  getUpdateState: vi.fn(() => ({
    updateAvailable: false,
    latestVersion: null,
    currentVersion: "1.0.0",
  })),
  isUpdateNoteSuppressed: vi.fn(() => false),
  suppressUpdateNote: vi.fn(),
}));

// Let flow tests drop .argent files into a temp dir instead of a real project.
let tmpDir: string;
vi.mock("../src/tools/flows/flow-utils", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/tools/flows/flow-utils")>();
  return {
    ...original,
    getFlowsDir: async () => path.join(tmpDir, ".argent"),
    getFlowPath: async (name: string) => path.join(tmpDir, ".argent", `${name}.yaml`),
  };
});

// Import after the mock so flow-run picks up the overridden path helpers.
import { createRunFlowTool } from "../src/tools/flows/flow-run";
import { serializeFlow } from "../src/tools/flows/flow-utils";

// ── Stub registry ──────────────────────────────────────────────────────
//
// Minimal Registry shim that supports tool registration and nested invocation
// exactly the way the real Registry does from flow-execute's perspective: a
// synchronous lookup in a Map followed by `await definition.execute(...)`.
// No AsyncLocalStorage magic here — if the context propagates, it does so
// because the real ALS in src/request-context.ts handles it, not because the
// stub helps.

type StubTool = ToolDefinition<any, any>;

interface StubRegistry extends Registry {
  register(id: string, execute: (params: any) => Promise<any> | any): void;
}

function createStubRegistry(): StubRegistry {
  const tools = new Map<string, StubTool>();

  const registry = {
    register(id: string, execute: (params: any) => Promise<any> | any) {
      tools.set(id, {
        id,
        services: () => ({}),
        execute: async (_services: unknown, params: unknown) => execute(params),
      } as StubTool);
    },
    getTool(id: string) {
      return tools.get(id);
    },
    getSnapshot() {
      return {
        services: new Map(),
        namespaces: [],
        tools: [...tools.keys()],
      };
    },
    async invokeTool(id: string, params?: unknown) {
      const def = tools.get(id);
      if (!def) throw new Error(`Tool "${id}" not found`);
      return def.execute({}, params);
    },
  } as unknown as StubRegistry;

  return registry;
}

// ── Shared setup ───────────────────────────────────────────────────────

let handle: HttpAppHandle;
let registry: StubRegistry;
let request: typeof import("supertest").default;

beforeEach(async () => {
  request = await import("supertest").then((m) => m.default);
  registry = createStubRegistry();
  handle = createHttpApp(registry);
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "als-nested-"));
});

afterEach(async () => {
  handle?.dispose();
  vi.clearAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ──────────────────────────────────────────────────────────────────────
// 1. Single-level: already covered in http-project-root.test.ts.
//    We include one sanity check here so the suite is self-contained and a
//    regression in the entry-point wiring fails loudly in this file too.
// ──────────────────────────────────────────────────────────────────────

describe("1. Single-level HTTP → tool", () => {
  it("tool sees the projectRoot stamped by the HTTP handler", async () => {
    registry.register("leaf", () => ({ root: requireProjectRoot() }));

    const res = await request(handle.app)
      .post("/tools/leaf")
      .set("X-Argent-Project-Root", encodeURIComponent("/Users/alice/single"))
      .send({})
      .expect(200);

    expect(res.body.data).toEqual({ root: "/Users/alice/single" });
  });
});

// ──────────────────────────────────────────────────────────────────────
// 2. Two-level: A → B. Tool A invokes B through the registry, B reads root.
// ──────────────────────────────────────────────────────────────────────

describe("2. Two-level nesting", () => {
  it("B sees the projectRoot stamped for A's request", async () => {
    registry.register("B", () => ({
      level: "B",
      root: requireProjectRoot(),
    }));
    registry.register("A", async () => {
      const innerRoot = requireProjectRoot();
      const innerResult = await registry.invokeTool("B", {});
      return { level: "A", root: innerRoot, inner: innerResult };
    });

    const res = await request(handle.app)
      .post("/tools/A")
      .set("X-Argent-Project-Root", encodeURIComponent("/Users/alice/two-level"))
      .send({})
      .expect(200);

    expect(res.body.data).toEqual({
      level: "A",
      root: "/Users/alice/two-level",
      inner: { level: "B", root: "/Users/alice/two-level" },
    });
  });
});

// ──────────────────────────────────────────────────────────────────────
// 3. Deep nesting: A → B → C → D → E, each calling the next via invokeTool.
//    Every tool asserts it observes the same root as its caller.
// ──────────────────────────────────────────────────────────────────────

describe("3. Deep nesting (5 levels)", () => {
  it("all 5 levels see the same projectRoot", async () => {
    registry.register("E", () => ({ level: "E", root: requireProjectRoot() }));
    registry.register("D", async () => ({
      level: "D",
      root: requireProjectRoot(),
      inner: await registry.invokeTool("E", {}),
    }));
    registry.register("C", async () => ({
      level: "C",
      root: requireProjectRoot(),
      inner: await registry.invokeTool("D", {}),
    }));
    registry.register("B", async () => ({
      level: "B",
      root: requireProjectRoot(),
      inner: await registry.invokeTool("C", {}),
    }));
    registry.register("A", async () => ({
      level: "A",
      root: requireProjectRoot(),
      inner: await registry.invokeTool("B", {}),
    }));

    const PROJECT = "/Users/alice/deep";
    const res = await request(handle.app)
      .post("/tools/A")
      .set("X-Argent-Project-Root", encodeURIComponent(PROJECT))
      .send({})
      .expect(200);

    // Walk the nested result and assert every level sees PROJECT.
    let current: any = res.body.data;
    const observed: string[] = [];
    while (current) {
      observed.push(current.root);
      current = current.inner;
    }
    expect(observed).toHaveLength(5);
    expect(observed.every((r) => r === PROJECT)).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// 4. Mixed sync/async depth:
//    A awaits, B returns sync, C uses setImmediate, D uses setTimeout(0),
//    E uses a Promise resolve chain. Each level reads the root.
//
//    AsyncLocalStorage is supposed to survive all of these because the V8
//    async-hooks layer binds the store to the async scope that schedules the
//    continuation — not to the event-loop task that eventually runs it.
// ──────────────────────────────────────────────────────────────────────

describe("4. Mixed sync / async depth", () => {
  it("every continuation type preserves the store", async () => {
    // E: Promise resolve chain — several .then hops.
    registry.register("E", () =>
      Promise.resolve()
        .then(() => Promise.resolve())
        .then(() => Promise.resolve())
        .then(() => ({ level: "E", root: requireProjectRoot() }))
    );

    // D: setTimeout(0) — macrotask-scheduled continuation.
    registry.register("D", async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const root = requireProjectRoot();
      const inner = await registry.invokeTool("E", {});
      return { level: "D", root, inner };
    });

    // C: setImmediate — macrotask-scheduled continuation.
    registry.register("C", async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const root = requireProjectRoot();
      const inner = await registry.invokeTool("D", {});
      return { level: "C", root, inner };
    });

    // B: returns sync (non-thenable Promise-free path, no await).
    //    NOTE: execute() must still return a Promise to satisfy the tool
    //    interface, so we wrap in Promise.resolve without awaiting anything.
    registry.register("B", () => {
      const root = requireProjectRoot();
      return registry.invokeTool("C", {}).then((inner) => ({
        level: "B",
        root,
        inner,
      }));
    });

    // A: awaited entry point.
    registry.register("A", async () => {
      const root = requireProjectRoot();
      const inner = await registry.invokeTool("B", {});
      return { level: "A", root, inner };
    });

    const PROJECT = "/Users/alice/mixed";
    const res = await request(handle.app)
      .post("/tools/A")
      .set("X-Argent-Project-Root", encodeURIComponent(PROJECT))
      .send({})
      .expect(200);

    let current: any = res.body.data;
    const observed: { level: string; root: string }[] = [];
    while (current) {
      observed.push({ level: current.level, root: current.root });
      current = current.inner;
    }
    expect(observed.map((o) => o.level)).toEqual(["A", "B", "C", "D", "E"]);
    for (const { level, root } of observed) {
      expect(root, `level ${level} lost the store`).toBe(PROJECT);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// 5. Parallel nested calls: A invokes B and C concurrently via Promise.all,
//    both must observe A's root.
// ──────────────────────────────────────────────────────────────────────

describe("5. Parallel nested calls from the same root", () => {
  it("both branches see the same projectRoot", async () => {
    registry.register("B", async () => {
      // Force some async gap so the two branches actually interleave.
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      return { branch: "B", root: requireProjectRoot() };
    });
    registry.register("C", async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      return { branch: "C", root: requireProjectRoot() };
    });
    registry.register("A", async () => {
      const [b, c] = await Promise.all([
        registry.invokeTool("B", {}),
        registry.invokeTool("C", {}),
      ]);
      return { root: requireProjectRoot(), b, c };
    });

    const PROJECT = "/Users/alice/parallel-same";
    const res = await request(handle.app)
      .post("/tools/A")
      .set("X-Argent-Project-Root", encodeURIComponent(PROJECT))
      .send({})
      .expect(200);

    expect(res.body.data).toEqual({
      root: PROJECT,
      b: { branch: "B", root: PROJECT },
      c: { branch: "C", root: PROJECT },
    });
  });
});

// ──────────────────────────────────────────────────────────────────────
// 6. Parallel from different roots: two concurrent HTTP requests each
//    triggering deep nesting. Roots must never leak between requests.
// ──────────────────────────────────────────────────────────────────────

describe("6. Concurrent requests from different project roots", () => {
  it("deep chains from two different roots never leak into each other", async () => {
    registry.register("leaf", async () => {
      // Inject a timing gap so interleaving is real.
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      return { root: requireProjectRoot() };
    });
    registry.register("mid", async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      const inner = await registry.invokeTool("leaf", {});
      return { root: requireProjectRoot(), inner };
    });
    registry.register("top", async () => {
      const inner = await registry.invokeTool("mid", {});
      return { root: requireProjectRoot(), inner };
    });

    const roots = [
      "/Users/alice/first",
      "/Users/bob/second",
      "/Users/carol/third",
      "/Users/dave/fourth",
      "/Users/eve/fifth",
    ];

    const responses = await Promise.all(
      roots.map((r) =>
        request(handle.app)
          .post("/tools/top")
          .set("X-Argent-Project-Root", encodeURIComponent(r))
          .send({})
      )
    );

    responses.forEach((res, i) => {
      expect(res.status, `request ${i} failed`).toBe(200);
      const expected = roots[i];
      expect(res.body.data.root).toBe(expected);
      expect(res.body.data.inner.root).toBe(expected);
      expect(res.body.data.inner.inner.root).toBe(expected);
    });
  });
});

// ──────────────────────────────────────────────────────────────────────
// 7. flow-execute style loop: uses the real createRunFlowTool with a flow
//    file containing 5 tool steps. Each step tool reads the projectRoot
//    and appends it to a shared collector; the test asserts all 5
//    observations equal the request's root.
//
//    This is the exact pattern the user is worried about: a long for-loop
//    re-entering `registry.invokeTool` while the outer runWithContext frame
//    is still open.
// ──────────────────────────────────────────────────────────────────────

describe("7. flow-execute 5-step loop", () => {
  it("all 5 steps see the same projectRoot as the incoming request", async () => {
    const seen: { step: string; root: string }[] = [];

    for (const step of ["s1", "s2", "s3", "s4", "s5"]) {
      registry.register(step, async () => {
        // Realistic async gap.
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
        const root = requireProjectRoot();
        seen.push({ step, root });
        return { step, root };
      });
    }

    // Register the real flow-execute tool against our stub registry.
    const runFlow = createRunFlowTool(registry);
    (registry as any).register("flow-execute", (params: any) =>
      runFlow.execute({}, params)
    );

    // Write a flow file with 5 tool steps.
    const flowsDir = path.join(tmpDir, ".argent");
    await fs.mkdir(flowsDir, { recursive: true });
    const flowContent = serializeFlow({
      executionPrerequisite: "",
      steps: [
        { kind: "tool", name: "s1", args: {} },
        { kind: "echo", message: "between" },
        { kind: "tool", name: "s2", args: {} },
        { kind: "tool", name: "s3", args: {} },
        { kind: "tool", name: "s4", args: {} },
        { kind: "tool", name: "s5", args: {} },
      ],
    });
    await fs.writeFile(path.join(flowsDir, "loop-test.yaml"), flowContent);

    const PROJECT = tmpDir; // the flow-utils mock honours tmpDir
    const res = await request(handle.app)
      .post("/tools/flow-execute")
      .set("X-Argent-Project-Root", encodeURIComponent(PROJECT))
      .send({ name: "loop-test", prerequisiteAcknowledged: true })
      .expect(200);

    // Every step must have observed the root.
    expect(seen).toHaveLength(5);
    expect(seen.map((s) => s.step)).toEqual(["s1", "s2", "s3", "s4", "s5"]);
    for (const { step, root } of seen) {
      expect(root, `step ${step} lost the store`).toBe(PROJECT);
    }

    // Sanity: flow-execute itself came back clean.
    expect(res.body.data.flow).toBe("loop-test");
    expect(res.body.data.steps).toHaveLength(6);
  });
});

// ──────────────────────────────────────────────────────────────────────
// 8. Error mid-chain: A → B → C, C throws. The error must unwind cleanly
//    and a subsequent request in the same test must see its own root with
//    no residual state from the failed one.
// ──────────────────────────────────────────────────────────────────────

describe("8. Error mid-chain does not corrupt the store", () => {
  it("chain error propagates, next request is unaffected", async () => {
    registry.register("C", async () => {
      // Read the root first so we know the store is intact at the throw site.
      const root = requireProjectRoot();
      throw new Error(`C boom at ${root}`);
    });
    registry.register("B", async () => {
      const _root = requireProjectRoot();
      await registry.invokeTool("C", {});
      return { unreachable: true };
    });
    registry.register("A", async () => {
      const _root = requireProjectRoot();
      await registry.invokeTool("B", {});
      return { unreachable: true };
    });
    registry.register("success-leaf", () => ({ root: requireProjectRoot() }));

    // First: failing chain.
    const failRes = await request(handle.app)
      .post("/tools/A")
      .set("X-Argent-Project-Root", encodeURIComponent("/Users/failed/request"))
      .send({})
      .expect(500);
    expect(failRes.body.error).toContain("C boom at /Users/failed/request");

    // Second: a fresh request with a different root.
    const okRes = await request(handle.app)
      .post("/tools/success-leaf")
      .set("X-Argent-Project-Root", encodeURIComponent("/Users/new/request"))
      .send({})
      .expect(200);
    expect(okRes.body.data).toEqual({ root: "/Users/new/request" });

    // Third: a request with NO header — the store must be completely empty.
    const noRootRes = await request(handle.app)
      .post("/tools/success-leaf")
      .send({})
      .expect(500);
    expect(noRootRes.body.error).toContain("No project root in request context");
    // And the residual root from the failed first request must NOT leak.
    expect(noRootRes.body.error).not.toContain("/Users/failed/request");
  });
});

// ──────────────────────────────────────────────────────────────────────
// 9. Long-running chain: A waits 100ms, then invokes B which waits 100ms,
//    etc. Total ~500ms of awaited gaps. Root must still be reachable at
//    the bottom.
// ──────────────────────────────────────────────────────────────────────

describe("9. Long-running chain (500ms total)", () => {
  it("root is reachable after 5×100ms awaited gaps", async () => {
    const observations: string[] = [];
    const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    registry.register("L5", async () => {
      await wait(100);
      observations.push(requireProjectRoot());
      return { level: 5 };
    });
    registry.register("L4", async () => {
      await wait(100);
      observations.push(requireProjectRoot());
      await registry.invokeTool("L5", {});
      return { level: 4 };
    });
    registry.register("L3", async () => {
      await wait(100);
      observations.push(requireProjectRoot());
      await registry.invokeTool("L4", {});
      return { level: 3 };
    });
    registry.register("L2", async () => {
      await wait(100);
      observations.push(requireProjectRoot());
      await registry.invokeTool("L3", {});
      return { level: 2 };
    });
    registry.register("L1", async () => {
      await wait(100);
      observations.push(requireProjectRoot());
      await registry.invokeTool("L2", {});
      return { level: 1 };
    });

    const PROJECT = "/Users/alice/long-running";
    const start = Date.now();
    await request(handle.app)
      .post("/tools/L1")
      .set("X-Argent-Project-Root", encodeURIComponent(PROJECT))
      .send({})
      .expect(200);
    const elapsed = Date.now() - start;

    expect(observations).toHaveLength(5);
    expect(observations.every((r) => r === PROJECT)).toBe(true);
    // Sanity that the gaps actually happened (≥400ms — leave some slack).
    expect(elapsed).toBeGreaterThanOrEqual(400);
  }, 10_000);
});

// ──────────────────────────────────────────────────────────────────────
// 10. Explicit runWithContext re-entry: an inner tool opens its own
//     runWithContext scope with an override. Inside that sub-scope the
//     override wins; after unwinding, the outer scope must be restored.
//
//     This proves (a) nested runWithContext composes correctly and
//     (b) the outer entry-point scope is never mutated by a sub-scope.
// ──────────────────────────────────────────────────────────────────────

describe("10. Explicit runWithContext sub-scope", () => {
  it("override wins inside sub-scope, outer root is restored after", async () => {
    // Leaf reads the root; it will be called both inside and outside the
    // override sub-scope.
    registry.register("leaf", () => ({ root: requireProjectRoot() }));

    // Wrapper uses runWithContext to temporarily install a different root.
    registry.register("wrapper", async () => {
      const outerRoot = requireProjectRoot();
      const beforeOverride = await registry.invokeTool("leaf", {});

      const overridden = await runWithContext(
        { projectRoot: "/override/path" },
        async () => {
          const innerRoot = requireProjectRoot();
          const innerLeaf = await registry.invokeTool("leaf", {});
          // Assert the sub-scope ALSO sees the override by direct read.
          return { innerRoot, innerLeaf };
        }
      );

      // After the sub-scope closes, we must be back on the outer root.
      const restoredRoot = requireProjectRoot();
      const afterOverride = await registry.invokeTool("leaf", {});

      return {
        outerRoot,
        beforeOverride,
        overridden,
        restoredRoot,
        afterOverride,
      };
    });

    const PROJECT = "/Users/alice/outer";
    const res = await request(handle.app)
      .post("/tools/wrapper")
      .set("X-Argent-Project-Root", encodeURIComponent(PROJECT))
      .send({})
      .expect(200);

    expect(res.body.data).toEqual({
      outerRoot: PROJECT,
      beforeOverride: { root: PROJECT },
      overridden: {
        innerRoot: "/override/path",
        innerLeaf: { root: "/override/path" },
      },
      restoredRoot: PROJECT,
      afterOverride: { root: PROJECT },
    });

    // Final sanity: outside any request, no context is leaking.
    expect(getRequestContext()).toBeUndefined();
  });
});
