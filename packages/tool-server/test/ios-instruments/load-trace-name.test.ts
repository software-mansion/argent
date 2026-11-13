/**
 * profiler-load used to set the session's traceFile to null for an xctrace
 * session, so native-profiler-analyze printed "**Trace:** unknown". The report
 * now names the loaded trace, or its session id when the .trace bundle is gone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  nativeProfilerSessionBlueprint,
  type NativeProfilerSessionApi,
} from "../../src/blueprints/native-profiler-session";

vi.mock("../../src/utils/react-profiler/debug/dump", () => ({
  getDebugDir: vi.fn(),
  readCommitTree: vi.fn(),
}));

import { getDebugDir } from "../../src/utils/react-profiler/debug/dump";
import { profilerLoadTool } from "../../src/tools/profiler/query/profiler-load";
import { analyzeNativeProfilerIos } from "../../src/tools/profiler/native-profiler/platforms/ios";

const SESSION_ID = "20261113-135245";

async function buildIosSession(): Promise<NativeProfilerSessionApi> {
  const device = { id: "ios-sim", platform: "ios" as const, kind: "simulator" as const };
  const instance = await nativeProfilerSessionBlueprint.factory({}, device, { device });
  return instance.api;
}

describe("profiler-load names the loaded xctrace trace", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "argent-load-trace-name-"));
    vi.mocked(getDebugDir).mockResolvedValue(dir);
    await writeFile(
      join(dir, `native-profiler-${SESSION_ID}_raw_hangs.xml`),
      "<trace-query-result></trace-query-result>",
      "utf8"
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  async function loadAndAnalyze() {
    const api = await buildIosSession();
    await profilerLoadTool.execute(
      { session: api } as never,
      {
        mode: "load_native",
        session_id: SESSION_ID,
        device_id: "ios-sim",
      } as never
    );
    return analyzeNativeProfilerIos(api);
  }

  it("names the .trace bundle", async () => {
    await mkdir(join(dir, `native-profiler-${SESSION_ID}.trace`));
    const result = await loadAndAnalyze();
    expect(result.report).toContain(`**Trace:** \`native-profiler-${SESSION_ID}.trace\``);
    expect(result.report).not.toContain("**Trace:** unknown");
  });

  it("names the session id when the .trace bundle is gone", async () => {
    const result = await loadAndAnalyze();
    expect(result.report).toContain(
      `**Trace:** session \`${SESSION_ID}\` (its .trace bundle is no longer on disk)`
    );
  });
});
