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
          inputSchema: {
            type: "object",
            properties: { udid: { type: "string" }, device: { type: "string" } },
          },
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

  const PHONE = "00008120-000E6D0C0ABBA01E";

  function stageNote(): void {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      announceDetectedSigningTeam(DETECTED_TEAM);
    } finally {
      write.mockRestore();
    }
  }

  it("attaches the staged detection note to the first physical-iPhone call only", async () => {
    stageNote();
    handle = createHttpApp(stubRegistry());

    const first = await request(handle.app)
      .post("/tools/test-tool")
      .send({ udid: PHONE })
      .expect(200);
    expect(first.body.note).toContain("Signing the on-device runner with team ABCDE12345");
    expect(first.body.note).toContain("Set ARGENT_IOS_TEAM_ID");

    // Drained: the very next call on the phone is note-free again.
    const second = await request(handle.app)
      .post("/tools/test-tool")
      .send({ udid: PHONE })
      .expect(200);
    expect(second.body).not.toHaveProperty("note");
  });

  it("holds the note past calls on other platforms and device-free calls", async () => {
    // One tool-server serves every agent on the machine; a simulator, Android
    // or device-free call must not carry a note about signing an iPhone runner.
    stageNote();
    handle = createHttpApp(stubRegistry());

    for (const body of [
      {},
      { udid: "emulator-5554" },
      { udid: "7AFBC98C-76B5-4BD4-8B7F-24AE3E30BA37" },
      { udid: "chromium-cdp-9222" },
    ]) {
      const res = await request(handle.app).post("/tools/test-tool").send(body).expect(200);
      expect(res.body).not.toHaveProperty("note");
    }

    const phone = await request(handle.app)
      .post("/tools/test-tool")
      .send({ udid: PHONE })
      .expect(200);
    expect(phone.body.note).toContain("Signing the on-device runner with team ABCDE12345");
  });

  it("recognises the phone under flow-execute's `device` spelling", async () => {
    // A session that only replays flows on the phone names it as `device`,
    // never as `udid`; the note must not wait for a call that never comes.
    stageNote();
    handle = createHttpApp(stubRegistry());

    const simulatorFlow = await request(handle.app)
      .post("/tools/test-tool")
      .send({ device: "7AFBC98C-76B5-4BD4-8B7F-24AE3E30BA37" })
      .expect(200);
    expect(simulatorFlow.body).not.toHaveProperty("note");

    const phoneFlow = await request(handle.app)
      .post("/tools/test-tool")
      .send({ device: PHONE })
      .expect(200);
    expect(phoneFlow.body.note).toContain("Signing the on-device runner with team ABCDE12345");
  });
});
