/**
 * ADVERSARIAL AUDIT — cross-project state contamination in the tool-server.
 *
 * The tool-server is a singleton daemon. Two MCP clients from two different
 * projects can hit it concurrently. The recent `AsyncLocalStorage`-based
 * fix in `src/request-context.ts` plumbs `projectRoot` through
 * `requireProjectRoot()` correctly, but any tool that hoards state at
 * module scope keyed by anything OTHER than the projectRoot can still leak.
 *
 * This file contains failing tests that prove each leak is real.
 *
 * ─── PUNCH LIST ────────────────────────────────────────────────────────────
 *
 * P0 — CONFIRMED CONTAMINATION (pre-existing bugs the ALS fix does NOT solve)
 *
 * [P0-1] `activeFlowName` is a module-level singleton in
 *        src/tools/flows/flow-utils.ts (line 21: `let activeFlowName: string | null`).
 *        All flow-start-recording / flow-add-step / flow-finish-recording calls
 *        read and write it without any project scoping.
 *        REAL-WORLD EFFECT: Project A records a flow "login"; project B,
 *        while A is still recording, calls `flow-add-step`. B's step is
 *        appended to A's YAML file under A's .argent directory. B may also
 *        silently "inherit" A's active flow name and overwrite A's file when
 *        B eventually calls flow-finish-recording. Catastrophic data loss.
 *
 * [P0-2] `profilerPathsCache` is a module-level `Map<number, ProfilerSessionPaths>`
 *        in src/blueprints/react-profiler-session.ts (line 168). The cache key
 *        is the Metro port number ONLY — projectRoot is never part of the key.
 *        Both projects default to port 8081.
 *        REAL-WORLD EFFECT: Project A runs react-profiler-stop → caches
 *        `ProfilerSessionPaths { debugDir: "/Users/A/.argent/debug/..." }`
 *        at port 8081. Project B then calls react-profiler-analyze /
 *        profiler-cpu-query / profiler-combined-report / profiler-load —
 *        each of which falls back to `getCachedProfilerPaths(api.port)`
 *        when the per-session cache is empty. B reads paths pointing into
 *        A's filesystem, analyses A's CPU profile, and returns A's report
 *        labelled as B's. If B also calls profiler-load, it overwrites
 *        A's entry so A's next query now reads B's files.
 *
 * P1 — PROBABLE CONTAMINATION (not directly exploited here, but same shape)
 *
 * [P1-1] The Registry's service blueprints (simulator-server,
 *        js-runtime-debugger, ReactProfilerSession, ios-profiler-session,
 *        native-devtools) cache service instances by a URN that is either
 *        a UDID or a port — never the projectRoot. Two projects that share
 *        a simulator UDID or Metro port will share the underlying service
 *        instance, including any mutable fields on it
 *        (e.g. `scriptSources: Map<string, ScriptSourceEntry>` on
 *        ReactProfilerSessionApi line 51). Source maps ingested while
 *        project A is connected leak into project B's analyse step.
 *
 * [P1-2] `log-file-writer.ts` holds open file handles keyed by simulator
 *        UDID — same pattern, same risk of cross-project mixing if two
 *        projects target one simulator.
 *
 * P2 — THEORETICAL
 *
 * [P2-1] Any ad-hoc `new Map()` at module scope without a projectRoot key
 *        (source-map caches, AST-index caches in the react-profiler pipeline,
 *        component-tree caches). These are transient per-request in the
 *        current call sites but are easy regressions.
 *
 * ─── TESTS ────────────────────────────────────────────────────────────────
 *
 * Every test in this file uses `it.fails(...)` because each one documents a
 * CURRENTLY-UNFIXED pre-existing bug. `it.fails` passes while the test body
 * asserts the bug (a thing that should work, but doesn't) and it will FLIP
 * to a hard failure the day someone fixes the underlying singleton. That
 * fixer should then drop `.fails` and the test becomes a regression guard.
 *
 * In other words: red == good, green == regression, and "the test passed"
 * means "one of these bugs came back".
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHttpApp, type HttpAppHandle } from "../src/http";
import { runWithContext } from "../src/request-context";
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

// Route flow paths into per-project temp dirs that honour the CURRENT request's
// projectRoot. This is the correct behaviour flow-utils.ts already has (via
// `requireProjectRoot()`). The mock preserves it so the `activeFlowName` bug
// is isolated from the path-scoping fix.
vi.mock("../src/tools/flows/flow-utils", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/tools/flows/flow-utils")>();
  const { requireProjectRoot } = await import("../src/request-context");
  return {
    ...original,
    getFlowsDir: async () => path.join(requireProjectRoot(), ".argent"),
    getFlowPath: async (name: string) =>
      path.join(requireProjectRoot(), ".argent", `${name}.yaml`),
  };
});

// Imports that depend on the mock must come after vi.mock.
import {
  setActiveFlow,
  getActiveFlowOrNull,
  clearActiveFlow,
  parseFlow,
} from "../src/tools/flows/flow-utils";
import { flowStartRecordingTool } from "../src/tools/flows/flow-start-recording";
import { createFlowAddStepTool } from "../src/tools/flows/flow-add-step";
import {
  cacheProfilerPaths,
  getCachedProfilerPaths,
  clearCachedProfilerPaths,
  type ProfilerSessionPaths,
} from "../src/blueprints/react-profiler-session";

// ── Stub registry ──────────────────────────────────────────────────────

type StubTool = ToolDefinition<any, any>;

interface StubRegistry extends Registry {
  register(id: string, execute: (params: any) => Promise<any> | any): void;
  registerDef(def: StubTool): void;
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
    registerDef(def: StubTool) {
      tools.set(def.id, def);
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
let projectA: string;
let projectB: string;

beforeEach(async () => {
  request = await import("supertest").then((m) => m.default);
  registry = createStubRegistry();
  handle = createHttpApp(registry);

  // Give each "project" its own on-disk root so file writes map to real dirs.
  projectA = await fs.mkdtemp(path.join(os.tmpdir(), "contam-A-"));
  projectB = await fs.mkdtemp(path.join(os.tmpdir(), "contam-B-"));

  // Make sure prior test state can't leak into us.
  clearActiveFlow();
  clearCachedProfilerPaths(8081);
});

afterEach(async () => {
  handle?.dispose();
  vi.clearAllMocks();
  clearActiveFlow();
  clearCachedProfilerPaths(8081);
  await fs.rm(projectA, { recursive: true, force: true });
  await fs.rm(projectB, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════════════════════
// [P0-1] activeFlowName module-level singleton
// ══════════════════════════════════════════════════════════════════════

describe("[P0-1] flow-utils activeFlowName leaks between projects", () => {
  it.fails("project B's flow-add-step silently inherits project A's active flow name", async () => {
    // Register the real flow-start-recording + flow-add-step tools against
    // the stub registry. flow-add-step invokes a nested tool; we register
    // `fake-tap` as a sink.
    registry.registerDef(flowStartRecordingTool);
    registry.registerDef(createFlowAddStepTool(registry));
    registry.register("fake-tap", (params: any) => ({
      ok: true,
      echo: params,
    }));

    // ── Project A starts recording a flow named "login".
    await request(handle.app)
      .post("/tools/flow-start-recording")
      .set("X-Argent-Project-Root", encodeURIComponent(projectA))
      .send({ name: "login", executionPrerequisite: "home screen" })
      .expect(200);

    // Sanity: A's flow file exists.
    const aFlowPath = path.join(projectA, ".argent", "login.yaml");
    expect(await fs.stat(aFlowPath).catch(() => null)).not.toBeNull();

    // ── Project B calls flow-add-step WITHOUT ever calling
    //    flow-start-recording. Under correct project scoping, this must
    //    throw `No active flow. Call flow-start-recording first.`
    //    Under the module-level bug, the call succeeds because
    //    `getActiveFlow()` reads the global and returns A's "login".
    //    flow-add-step then writes a "login.yaml" file under projectB's
    //    .argent directory — a file B never asked for, with a name that
    //    only exists because it leaked out of A's request.
    const bRes = await request(handle.app)
      .post("/tools/flow-add-step")
      .set("X-Argent-Project-Root", encodeURIComponent(projectB))
      .send({
        command: "fake-tap",
        args: JSON.stringify({ who: "project-B" }),
      });

    // (1) Under a clean implementation this is a 500 — "No active flow".
    expect(
      bRes.status,
      "[P0-1] project B's flow-add-step returned 200 despite never calling flow-start-recording — it inherited project A's active flow name from a module-level singleton"
    ).not.toBe(200);

    // (2) The response message should carry the "No active flow" error,
    //     NOT a success message referencing "login".
    const combinedText = JSON.stringify(bRes.body);
    expect(
      combinedText,
      "[P0-1] project B's response referenced the flow 'login' — a name that only exists in project A's state"
    ).not.toContain("login");
  });

  it.fails("setActiveFlow inside project A leaks into project B via direct function-level read", async () => {
    // Lower-level proof that does not depend on HTTP. Even with
    // `runWithContext` wrapping, the state itself is module-level,
    // so it is visible from every request frame.
    expect(getActiveFlowOrNull()).toBeNull();

    await runWithContext({ projectRoot: projectA }, async () => {
      setActiveFlow("project-a-flow");
    });

    // Simulate project B entering a fresh request context. Under correct
    // scoping, B sees NO active flow (B never recorded one). Under the
    // module-level singleton bug, B sees "project-a-flow".
    const seenByB = await runWithContext(
      { projectRoot: projectB },
      async () => getActiveFlowOrNull()
    );

    expect(
      seenByB,
      "[P0-1] project B observed project A's active flow through a module-level singleton — cross-project contamination"
    ).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════
// [P0-2] profilerPathsCache keyed only by port
// ══════════════════════════════════════════════════════════════════════

describe("[P0-2] react-profiler session paths cache leaks between projects on shared port", () => {
  it.fails("project B reads project A's cached ProfilerSessionPaths when both use port 8081", async () => {
    // Build a realistic ProfilerSessionPaths that would have been cached by
    // react-profiler-stop when project A ran its profile.
    const aPaths: ProfilerSessionPaths = {
      sessionId: "A-session-2025",
      debugDir: path.join(projectA, ".argent", "debug", "react-profiler-A"),
      cpuProfilePath: path.join(
        projectA,
        ".argent",
        "debug",
        "react-profiler-A",
        "cpu.cpuprofile"
      ),
      commitsPath: path.join(
        projectA,
        ".argent",
        "debug",
        "react-profiler-A",
        "commits.json"
      ),
      cpuSampleIndexPath: null,
      detectedArchitecture: "bridgeless",
      anyCompilerOptimized: true,
      hotCommitIndices: [3, 7, 12],
      totalReactCommits: 42,
    };

    // ── Project A, in its own request frame, stops profiling and caches.
    //    (react-profiler-stop does this via cacheProfilerPaths at line 275.)
    await runWithContext({ projectRoot: projectA }, async () => {
      cacheProfilerPaths(8081, aPaths);
    });

    // ── Project B, in its own request frame, tries to read its own session.
    //    react-profiler-analyze, react-profiler-cpu-summary,
    //    profiler-combined-report, profiler-cpu-query and profiler-commit-query
    //    all call `getCachedProfilerPaths(api.port)` as a fallback.
    //    Project B has NEVER profiled anything — it should see undefined.
    //    With the module-level cache keyed only by port, it sees A's paths.
    const bLookup = await runWithContext(
      { projectRoot: projectB },
      async () => getCachedProfilerPaths(8081)
    );

    expect(
      bLookup,
      "[P0-2] project B read project A's cached profiler paths through a global Map keyed only by Metro port — analyze/summary/query tools would now operate on A's CPU profile and report A's data to B's MCP client"
    ).toBeUndefined();
  });

  it.fails("project B's profiler-load overwrites project A's cached entry on the shared port", async () => {
    // Seed A's entry.
    const aPaths: ProfilerSessionPaths = {
      sessionId: "A-session",
      debugDir: path.join(projectA, ".argent", "debug"),
      cpuProfilePath: path.join(projectA, ".argent", "debug", "A.cpuprofile"),
      commitsPath: path.join(projectA, ".argent", "debug", "A.commits.json"),
      cpuSampleIndexPath: null,
      detectedArchitecture: "bridge",
      anyCompilerOptimized: null,
      hotCommitIndices: null,
      totalReactCommits: null,
    };
    const bPaths: ProfilerSessionPaths = {
      sessionId: "B-session",
      debugDir: path.join(projectB, ".argent", "debug"),
      cpuProfilePath: path.join(projectB, ".argent", "debug", "B.cpuprofile"),
      commitsPath: path.join(projectB, ".argent", "debug", "B.commits.json"),
      cpuSampleIndexPath: null,
      detectedArchitecture: "bridgeless",
      anyCompilerOptimized: null,
      hotCommitIndices: null,
      totalReactCommits: null,
    };

    await runWithContext({ projectRoot: projectA }, async () =>
      cacheProfilerPaths(8081, aPaths)
    );

    // Project B loads a profile into the same port (profiler-load.ts:204).
    await runWithContext({ projectRoot: projectB }, async () =>
      cacheProfilerPaths(8081, bPaths)
    );

    // Project A returns and queries its session. It should still see ITS OWN
    // paths. Instead it reads B's — A's cached entry has been silently
    // overwritten by B.
    const aAfter = await runWithContext(
      { projectRoot: projectA },
      async () => getCachedProfilerPaths(8081)
    );

    expect(
      aAfter?.sessionId,
      "[P0-2] project A's cached profiler session was overwritten by project B's profiler-load — next query from A would return B's profile data"
    ).toBe("A-session");
    expect(aAfter?.debugDir).toContain(projectA);
    expect(
      aAfter?.debugDir,
      "[P0-2] A's cached debugDir now points inside projectB's filesystem"
    ).not.toContain(projectB);
  });
});

// ══════════════════════════════════════════════════════════════════════
// [P0 END-TO-END] Concurrent HTTP requests from two projects over
//                 the same singleton server.
// ══════════════════════════════════════════════════════════════════════

describe("[P0 end-to-end] concurrent HTTP requests expose the leaks", () => {
  it.fails("project B's flow-start-recording clobbers A's active flow, so A's flow-add-step writes to a file named after B's flow", async () => {
    registry.registerDef(flowStartRecordingTool);
    registry.registerDef(createFlowAddStepTool(registry));
    registry.register("fake-tap", (params: any) => ({ ok: true, echo: params }));

    // Project A starts recording "onboarding".
    await request(handle.app)
      .post("/tools/flow-start-recording")
      .set("X-Argent-Project-Root", encodeURIComponent(projectA))
      .send({ name: "onboarding", executionPrerequisite: "home" })
      .expect(200);

    // Project B, on the same daemon, starts recording "checkout". B wins the
    // race for the GLOBAL `activeFlowName`.
    await request(handle.app)
      .post("/tools/flow-start-recording")
      .set("X-Argent-Project-Root", encodeURIComponent(projectB))
      .send({ name: "checkout", executionPrerequisite: "cart" })
      .expect(200);

    // Project A, unaware, calls flow-add-step — still believing it is
    // recording "onboarding". The step is instead appended to A's
    // .argent/checkout.yaml file (B's flow name, A's path). A's onboarding
    // flow file never gets the step.
    const aRes = await request(handle.app)
      .post("/tools/flow-add-step")
      .set("X-Argent-Project-Root", encodeURIComponent(projectA))
      .send({
        command: "fake-tap",
        args: JSON.stringify({ from: "project-A" }),
      });

    // (1) The response message must not claim the step went to "checkout"
    //     from project A — project A never asked for that name.
    if (aRes.status === 200) {
      const msg = JSON.stringify(aRes.body);
      expect(
        msg,
        "[P0-1 HTTP] project A's flow-add-step reported recording into 'checkout' — a flow name that only exists because it leaked out of project B"
      ).not.toContain("checkout");
    }

    // (2) A file called `checkout.yaml` should NOT be created under projectA:
    //     project A never ran a flow called checkout.
    const aCheckoutPath = path.join(projectA, ".argent", "checkout.yaml");
    const aCheckoutExists = await fs
      .stat(aCheckoutPath)
      .then(() => true)
      .catch(() => false);
    expect(
      aCheckoutExists,
      "[P0-1 HTTP] projectA/.argent/checkout.yaml was written — a filename that only exists because project B's `activeFlowName` bled through the module-level singleton into project A's request"
    ).toBe(false);

    // (3) A's onboarding.yaml should EITHER contain the step (if the bug were
    //     fixed) OR still be empty (under the bug — A's step went to the
    //     wrong file). We assert the fixed behaviour so the test fails today.
    const aOnboardingPath = path.join(projectA, ".argent", "onboarding.yaml");
    const aOnboarding = parseFlow(await fs.readFile(aOnboardingPath, "utf8"));
    expect(
      aOnboarding.steps.length,
      "[P0-1 HTTP] project A's onboarding flow is missing the step it just recorded — the step was silently diverted to a different flow because of the shared activeFlowName"
    ).toBeGreaterThan(0);
  });
});
