import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHttpApp, type HttpAppHandle } from "../src/http";
import { requireProjectRoot, getRequestContext } from "../src/request-context";
import type { Registry } from "@argent/registry";

vi.mock("../src/utils/update-checker", () => ({
  getUpdateState: vi.fn(() => ({
    updateAvailable: false,
    latestVersion: null,
    currentVersion: "1.0.0",
  })),
  isUpdateNoteSuppressed: vi.fn(() => false),
  suppressUpdateNote: vi.fn(),
}));

function registryThatReadsProjectRoot(): Registry {
  return {
    getSnapshot: vi.fn(() => ({
      services: new Map(),
      namespaces: [],
      tools: ["needs-root", "no-root"],
    })),
    getTool: vi.fn((name: string) => ({ id: name })),
    invokeTool: vi.fn(async (name: string) => {
      if (name === "needs-root") return { root: requireProjectRoot() };
      if (name === "no-root") return { ok: true, ctx: getRequestContext() };
      throw new Error(`unknown tool: ${name}`);
    }),
  } as unknown as Registry;
}

describe("HTTP → AsyncLocalStorage → requireProjectRoot", () => {
  let handle: HttpAppHandle;
  let request: typeof import("supertest").default;

  beforeEach(async () => {
    request = await import("supertest").then((m) => m.default);
    handle = createHttpApp(registryThatReadsProjectRoot());
  });

  afterEach(() => {
    handle?.dispose();
    vi.clearAllMocks();
  });

  it("makes the project root reachable inside the tool handler when the header is present", async () => {
    const res = await request(handle.app)
      .post("/tools/needs-root")
      .set("X-Argent-Project-Root", encodeURIComponent("/Users/alice/my-project"))
      .send({})
      .expect(200);

    expect(res.body.data).toEqual({ root: "/Users/alice/my-project" });
  });

  it("round-trips unicode and spaces through URL encoding", async () => {
    const path = "/Users/alice/my project/プロジェクト";
    const res = await request(handle.app)
      .post("/tools/needs-root")
      .set("X-Argent-Project-Root", encodeURIComponent(path))
      .send({})
      .expect(200);

    expect(res.body.data).toEqual({ root: path });
  });

  it("returns a clear error when a tool needs the root but no header was sent", async () => {
    const res = await request(handle.app).post("/tools/needs-root").send({}).expect(500);

    expect(res.body.error).toContain("No project root in request context");
    expect(res.body.error).toContain("X-Argent-Project-Root");
  });

  it("treats an empty header value as missing", async () => {
    const res = await request(handle.app)
      .post("/tools/needs-root")
      .set("X-Argent-Project-Root", "")
      .send({})
      .expect(500);

    expect(res.body.error).toContain("No project root in request context");
  });

  it("treats a malformed percent-encoded header as missing", async () => {
    const res = await request(handle.app)
      .post("/tools/needs-root")
      .set("X-Argent-Project-Root", "%E0%A4%A")
      .send({})
      .expect(500);

    expect(res.body.error).toContain("No project root in request context");
  });

  it("lets tools that don't need the root succeed without the header", async () => {
    const res = await request(handle.app).post("/tools/no-root").send({}).expect(200);

    expect(res.body.data).toMatchObject({ ok: true });
    expect(res.body.data.ctx).toBeUndefined();
  });

  it("isolates concurrent requests from different project roots", async () => {
    const paths = [
      "/Users/a/project-one",
      "/Users/b/project-two",
      "/Users/c/project-three",
      "/Users/d/project-four",
    ];

    const responses = await Promise.all(
      paths.map((p) =>
        request(handle.app)
          .post("/tools/needs-root")
          .set("X-Argent-Project-Root", encodeURIComponent(p))
          .send({})
      )
    );

    responses.forEach((res, i) => {
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ root: paths[i] });
    });
  });
});
