import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import supertest from "supertest";
import { createHttpApp, type HttpAppHandle } from "../src/http";
import type { Registry } from "@argent/registry";
import {
  __setCertificateListerForTests,
  announceDetectedSigningTeam,
} from "../src/utils/ios-device/team-detect";

// Keep the update note out of these assertions (same approach as the other
// http-*.test.ts files): no update available, never suppressed.
vi.mock("../src/utils/update-checker", () => ({
  getUpdateState: vi.fn(() => ({
    updateAvailable: false,
    updateInstallable: false,
    installableVersion: null,
    latestVersion: null,
    latestPublishedAt: null,
    minReleaseAgeMs: 0,
    currentVersion: "1.0.0",
  })),
  isUpdateNoteSuppressed: vi.fn(() => false),
  suppressUpdateNote: vi.fn(),
}));

function stubRegistry(): Registry {
  return {
    getSnapshot: vi.fn(() => ({ services: new Map(), namespaces: [], tools: ["test-tool"] })),
    getTool: vi.fn((name: string) => {
      if (name === "test-tool") {
        return {
          id: "test-tool",
          description: "A stub tool for testing",
          inputSchema: { type: "object", properties: {} },
          services: () => ({}),
          execute: async () => ({ ok: true }),
        };
      }
      return undefined;
    }),
    invokeTool: vi.fn(async () => ({ ok: true })),
  } as unknown as Registry;
}

const DETECTED_TEAM = [
  {
    teamId: "ABCDE12345",
    label: "Apple Development: alice@example.com (ALICEKEY01)",
    issuedAtMs: Date.parse("2024-01-15T12:00:00Z"),
  },
];

describe("HTTP signing-detection note", () => {
  let handle: HttpAppHandle;
  const request = supertest;

  // The seam reset clears the module-global pending note and announce-once
  // state so cases cannot leak notes into each other.
  beforeEach(() => __setCertificateListerForTests(async () => ""));

  afterEach(() => {
    handle?.dispose();
    __setCertificateListerForTests(null);
    vi.clearAllMocks();
  });

  it("attaches the staged detection note to the first tool result only", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      announceDetectedSigningTeam(DETECTED_TEAM);
    } finally {
      write.mockRestore();
    }
    handle = createHttpApp(stubRegistry());

    const first = await request(handle.app).post("/tools/test-tool").send({}).expect(200);
    expect(first.body.note).toContain("Signing the on-device runner with team ABCDE12345");
    expect(first.body.note).toContain("Set ARGENT_IOS_TEAM_ID");

    // Drained: the very next call is note-free again.
    const second = await request(handle.app).post("/tools/test-tool").send({}).expect(200);
    expect(second.body).not.toHaveProperty("note");
  });

  it("adds no note while nothing is staged", async () => {
    handle = createHttpApp(stubRegistry());

    const res = await request(handle.app).post("/tools/test-tool").send({}).expect(200);

    expect(res.body).toHaveProperty("data");
    expect(res.body).not.toHaveProperty("note");
  });
});
