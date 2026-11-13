/**
 * The profiler folder kept every recording for good (1.4 GB in 187 entries on a
 * test Mac). deleteOldProfilerSessions deletes a session that no tool used for
 * 3 days, as a whole, and nothing else.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteOldProfilerSessions,
  SESSION_RETENTION_MS,
} from "../src/utils/profiler-shared/session-retention";

// test/setup/stub-profiler-session-cleanup.ts stubs the cleanup for every other suite.
vi.unmock("../src/utils/profiler-shared/session-retention");
vi.mock("../src/utils/react-profiler/debug/dump", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getDebugDir: vi.fn(async () => dir),
}));

import { profilerLoadTool } from "../src/tools/profiler/query/profiler-load";
import { newTraceOutputPath } from "../src/tools/profiler/native-profiler/platforms/xctrace";
import {
  nativeProfilerSessionBlueprint,
  type NativeProfilerSessionApi,
} from "../src/blueprints/native-profiler-session";

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
/** A session id for a UTC time. */
const id = (ms: number) =>
  new Date(ms).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "argent-session-retention-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Creates the entries with the given modification time. */
async function make(names: string[], mtimeMs: number): Promise<void> {
  for (const name of names) {
    const file = join(dir, name);
    if (name.endsWith(".trace")) {
      await mkdir(join(file, "Trace1.run"), { recursive: true });
    } else {
      await writeFile(file, "x");
    }
    await utimes(file, mtimeMs / 1000, mtimeMs / 1000);
  }
}

const xctraceSession = (sid: string) => [
  `native-profiler-${sid}.trace`,
  `native-profiler-${sid}.trace.metadata.json`,
  `native-profiler-${sid}_raw_cpu.xml`,
  `native-profiler-${sid}_raw_hangs.xml`,
  `native-profiler-${sid}-report.md`,
];
const reactSession = (sid: string) => [
  `react-profiler-${sid}_cpu.json`,
  `react-profiler-${sid}_commits.json`,
  `react-profiler-${sid}_report.md`,
];

describe("deleteOldProfilerSessions", () => {
  it("deletes each session unused for more than 3 days, with all its files", async () => {
    const old = NOW - 4 * DAY;
    await make(xctraceSession(id(old)), old);
    await make(reactSession(id(old)), old);
    await make(
      [`native-profiler-${id(old)}.pftrace`, `native-profiler-${id(old)}.pftrace.metadata.json`],
      old
    );

    const deleted = await deleteOldProfilerSessions(dir, NOW);

    expect(deleted).toHaveLength(10);
    expect(await readdir(dir)).toEqual([]);
  });

  it("keeps a session used within 3 days, also an old one", async () => {
    const recent = NOW - 2 * DAY;
    await make(xctraceSession(id(recent)), recent);
    // Recorded 10 days ago, analyzed again an hour ago: its report is new.
    const old = NOW - 10 * DAY;
    await make(xctraceSession(id(old)).slice(0, 4), old);
    await make([`native-profiler-${id(old)}-report.md`], NOW - 60 * 60 * 1000);

    expect(await deleteOldProfilerSessions(dir, NOW)).toEqual([]);
    expect(await readdir(dir)).toHaveLength(10);
  });

  it("deletes the old shared React report, and leaves files that are not argent's sessions", async () => {
    const old = NOW - 4 * DAY;
    await make(["react-profiler-report.md", "notes.txt", "native-profiler-x.trace"], old);
    expect(await deleteOldProfilerSessions(dir, NOW)).toEqual(["react-profiler-report.md"]);
    expect((await readdir(dir)).sort()).toEqual(["native-profiler-x.trace", "notes.txt"]);
  });

  it("keeps a session at exactly the retention limit and deletes it a second later", async () => {
    const edge = NOW - SESSION_RETENTION_MS;
    await make(reactSession(id(edge)), edge);
    expect(await deleteOldProfilerSessions(dir, NOW)).toEqual([]);
    expect(await deleteOldProfilerSessions(dir, NOW + 1000)).toHaveLength(3);
  });
});

describe("the cleanup in use", () => {
  async function iosSession(): Promise<NativeProfilerSessionApi> {
    const device = { id: "ios-sim", platform: "ios" as const, kind: "simulator" as const };
    return (await nativeProfilerSessionBlueprint.factory({}, device, { device })).api;
  }

  it("runs when a native recording starts, and deletes an old session", async () => {
    const old = Date.now() - 4 * DAY;
    await make(xctraceSession(id(old)), old);
    const tracePath = await newTraceOutputPath();
    expect(tracePath.startsWith(dir)).toBe(true);
    for (let i = 0; i < 100 && (await readdir(dir)).length > 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(await readdir(dir)).toEqual([]);
  });

  it("keeps a session that profiler-load loaded", async () => {
    const old = Date.now() - 4 * DAY;
    const sid = id(old);
    await writeFile(
      join(dir, `native-profiler-${sid}_raw_hangs.xml`),
      "<trace-query-result><node></node></trace-query-result>"
    );
    await utimes(join(dir, `native-profiler-${sid}_raw_hangs.xml`), old / 1000, old / 1000);
    await profilerLoadTool.execute(
      { session: await iosSession() } as never,
      {
        mode: "load_native",
        session_id: sid,
        device_id: "ios-sim",
      } as never
    );
    expect(await deleteOldProfilerSessions(dir)).toEqual([]);
  });
});
