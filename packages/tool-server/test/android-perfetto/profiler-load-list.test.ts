import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";

let debugDir: string;

// Point getDebugDir at a throwaway fixture dir; readCommitTree is unused here
// (no react sessions) but must exist on the mocked module.
vi.mock("../../src/utils/react-profiler/debug/dump", () => ({
  getDebugDir: async () => debugDir,
  readCommitTree: vi.fn(),
}));

import { profilerLoadTool } from "../../src/tools/profiler/query/profiler-load";

async function touch(name: string) {
  await fs.writeFile(path.join(debugDir, name), "");
}

async function listOutput(): Promise<string> {
  return (await profilerLoadTool.execute(
    {} as never,
    {
      mode: "list",
      device_id: "emulator-5554",
      port: 8081,
    } as never
  )) as string;
}

describe("profiler-load list — platform classification", () => {
  beforeEach(async () => {
    debugDir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-load-list-"));
  });
  afterEach(async () => {
    await fs.rm(debugDir, { recursive: true, force: true });
  });

  it("lists an Android session only under (Android), never under (iOS)", async () => {
    // An Android session on disk: .pftrace + metadata sidecar + report.
    await touch("native-profiler-20260615-112028.pftrace");
    await touch("native-profiler-20260615-112028.pftrace.metadata.json");
    await touch("native-profiler-20260615-112028-report.md");

    const out = await listOutput();

    expect(out).toContain("### Native Profiler Sessions (Android)");
    // The regression: the session must NOT also appear under an iOS heading.
    expect(out).not.toContain("### Native Profiler Sessions (iOS)");
    // And it appears exactly once overall.
    const occurrences = out.split("20260615-112028").length - 1;
    expect(occurrences).toBe(1);
  });

  it("classifies iOS (xctrace XML) and Android (.pftrace) sessions into separate sections", async () => {
    await touch("native-profiler-20260101-090000_raw_cpu.xml");
    await touch("native-profiler-20260101-090000_raw_hangs.xml");
    await touch("native-profiler-20260615-112028.pftrace");

    const out = await listOutput();
    const iosIdx = out.indexOf("(iOS)");
    const androidIdx = out.indexOf("(Android)");
    expect(iosIdx).toBeGreaterThan(-1);
    expect(androidIdx).toBeGreaterThan(iosIdx);

    // The iOS session id is in the iOS section, the Android id is after the
    // Android heading — neither leaks into the other.
    const iosSection = out.slice(iosIdx, androidIdx);
    const androidSection = out.slice(androidIdx);
    expect(iosSection).toContain("20260101-090000");
    expect(iosSection).not.toContain("20260615-112028");
    expect(androidSection).toContain("20260615-112028");
    expect(androidSection).not.toContain("20260101-090000");
  });

  it("reports no sessions when the dir is empty", async () => {
    expect(await listOutput()).toContain("No profiling sessions found");
  });
});
