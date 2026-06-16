import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";

// ---------------------------------------------------------------------------
// True end-to-end test for `profiler-load { mode: "list" }`.
//
// Unlike profiler-load-list.test.ts (which vi.mocks getDebugDir), this exercises
// the REAL getDebugDir(): it returns `join(os.tmpdir(), "argent-profiler-cwd")`,
// and os.tmpdir() reads process.env.TMPDIR dynamically at call time. So we point
// TMPDIR at an isolated scratch dir per test and let the real code resolve the
// real on-disk path. Nothing in listSessions (the logic under test) is mocked.
//
// The `mode: "list"` execute path calls `listSessions(await getDebugDir())` and
// never touches `services`, so we drive it as execute({}, { mode: "list", ... }).
//
// Fixtures faithfully mirror what the writers put on disk:
//   Android (platforms/android.ts + session-metadata.ts):
//     native-profiler-<ts>.pftrace
//     native-profiler-<ts>.pftrace.metadata.json   { platform:"android", appProcess, wallClockStartMs }
//     native-profiler-<ts>-report.md               (written by native-profiler-analyze)
//   iOS (platforms/ios.ts + ios-profiler/render.ts deriveReportPath):
//     native-profiler-<ts>.trace                    (a directory in reality)
//     native-profiler-<ts>_raw_cpu.xml / _raw_hangs.xml / _raw_leaks.xml
//     native-profiler-<ts>-report.md
// Timestamp format on both platforms: YYYYMMDD-HHMMSS (15 chars).
// ---------------------------------------------------------------------------

let scratch: string;
let debugDir: string;
let savedTmpdir: string | undefined;

// Imported once; it reads getDebugDir() lazily inside execute, so per-test
// TMPDIR changes are honoured without re-importing.
import { profilerLoadTool } from "../../src/tools/profiler/query/profiler-load";

async function runList(): Promise<string> {
  return (await profilerLoadTool.execute(
    {} as never,
    { mode: "list", device_id: "emulator-5554", port: 8081 } as never
  )) as string;
}

/** Faithful Android session on disk: pftrace + metadata sidecar + report. */
async function writeAndroidSession(
  ts: string,
  opts: { metadata?: boolean | string; report?: boolean | string } = {}
): Promise<void> {
  const pftrace = path.join(debugDir, `native-profiler-${ts}.pftrace`);
  // The real .pftrace is a binary perfetto blob; a non-empty byte string is a
  // faithful enough stand-in for a listing test (list never parses it).
  await fs.writeFile(pftrace, "\x0a\x00perfetto-trace-bytes");
  if (opts.metadata !== false) {
    const body =
      typeof opts.metadata === "string"
        ? opts.metadata
        : `${JSON.stringify(
            { platform: "android", appProcess: "com.example.app", wallClockStartMs: 1710000000000 },
            null,
            2
          )}\n`;
    await fs.writeFile(`${pftrace}.metadata.json`, body);
  }
  if (opts.report !== false) {
    const body =
      typeof opts.report === "string"
        ? opts.report
        : "# Native Profiler Report (Android)\n\nBottlenecks: 0\n";
    await fs.writeFile(path.join(debugDir, `native-profiler-${ts}-report.md`), body);
  }
}

/** Faithful iOS session on disk: .trace dir + raw XML exports + report. */
async function writeIosSession(
  ts: string,
  exports: { cpu?: boolean; hangs?: boolean; leaks?: boolean; report?: boolean | string } = {
    cpu: true,
  }
): Promise<void> {
  // The real .trace is a directory created by xctrace.
  await fs.mkdir(path.join(debugDir, `native-profiler-${ts}.trace`), { recursive: true });
  if (exports.cpu)
    await fs.writeFile(
      path.join(debugDir, `native-profiler-${ts}_raw_cpu.xml`),
      "<trace-query-result></trace-query-result>"
    );
  if (exports.hangs)
    await fs.writeFile(
      path.join(debugDir, `native-profiler-${ts}_raw_hangs.xml`),
      "<trace-query-result></trace-query-result>"
    );
  if (exports.leaks)
    await fs.writeFile(
      path.join(debugDir, `native-profiler-${ts}_raw_leaks.xml`),
      "<trace-query-result></trace-query-result>"
    );
  if (exports.report !== false) {
    const body =
      typeof exports.report === "string"
        ? exports.report
        : "# Native Profiler Report (iOS)\n\nHotspots: 0\n";
    await fs.writeFile(path.join(debugDir, `native-profiler-${ts}-report.md`), body);
  }
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("profiler-load list — E2E against real on-disk fixtures (no mocks)", () => {
  beforeEach(async () => {
    savedTmpdir = process.env.TMPDIR;
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), "argent-load-e2e-"));
    process.env.TMPDIR = scratch;
    // Sanity: the real getDebugDir resolves under our scratch TMPDIR.
    debugDir = path.join(os.tmpdir(), "argent-profiler-cwd");
    expect(debugDir.startsWith(scratch)).toBe(true);
    await fs.mkdir(debugDir, { recursive: true });
  });

  afterEach(async () => {
    if (savedTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmpdir;
    await fs.rm(scratch, { recursive: true, force: true });
  });

  // ---- Matrix case 1: mixed Android + iOS (the headline case) ----
  it("case 1 — mixed: each session under exactly one heading, correct columns & ordering", async () => {
    await writeIosSession("20260101-090000", { cpu: true, hangs: true, leaks: true, report: true });
    await writeAndroidSession("20260615-112028", { metadata: true, report: true });

    const out = await runList();
    // OBSERVABLE: print the rendered list for the headline case.
    console.log(
      "\n===== mixed (Android + iOS) — real list output =====\n" +
        out +
        "\n====================================================\n"
    );

    const iosIdx = out.indexOf("### Native Profiler Sessions (iOS)");
    const androidIdx = out.indexOf("### Native Profiler Sessions (Android)");
    expect(iosIdx).toBeGreaterThan(-1);
    expect(androidIdx).toBeGreaterThan(-1);
    // Section ordering: iOS heading comes before Android heading.
    expect(androidIdx).toBeGreaterThan(iosIdx);

    const iosSection = out.slice(iosIdx, androidIdx);
    const androidSection = out.slice(androidIdx);

    // iOS id only in iOS section; Android id only in Android section.
    expect(iosSection).toContain("20260101-090000");
    expect(iosSection).not.toContain("20260615-112028");
    expect(androidSection).toContain("20260615-112028");
    expect(androidSection).not.toContain("20260101-090000");

    // iOS columns: cpu+hangs+leaks+report present → "CPU, hangs, leaks, report".
    expect(iosSection).toContain("`20260101-090000` | CPU, hangs, leaks, report |");
    // Android columns: pftrace + report tag.
    expect(androidSection).toContain("`20260615-112028` | pftrace, report |");

    // Each session id appears exactly once across the whole output.
    expect(countOccurrences(out, "20260101-090000")).toBe(1);
    expect(countOccurrences(out, "20260615-112028")).toBe(1);
  });

  // ---- Matrix case 2: Android-only ----
  it("case 2 — Android-only: no iOS heading, session listed once", async () => {
    await writeAndroidSession("20260615-112028", { metadata: true, report: true });

    const out = await runList();
    expect(out).toContain("### Native Profiler Sessions (Android)");
    expect(out).not.toContain("### Native Profiler Sessions (iOS)");
    expect(countOccurrences(out, "20260615-112028")).toBe(1);
    expect(out).toContain("`20260615-112028` | pftrace, report |");
  });

  // ---- Matrix case 3: iOS-only ----
  it("case 3 — iOS-only: no Android heading", async () => {
    await writeIosSession("20260101-090000", {
      cpu: true,
      hangs: false,
      leaks: false,
      report: false,
    });

    const out = await runList();
    expect(out).toContain("### Native Profiler Sessions (iOS)");
    expect(out).not.toContain("### Native Profiler Sessions (Android)");
    expect(countOccurrences(out, "20260101-090000")).toBe(1);
    // Only CPU export → just "CPU".
    expect(out).toContain("`20260101-090000` | CPU |");
  });

  // ---- Matrix case 4: empty dir ----
  it("case 4 — empty debug dir: clean 'no sessions' output, no crash", async () => {
    const out = await runList();
    expect(out).toContain("No profiling sessions found");
    expect(out).not.toContain("### Native Profiler Sessions");
  });

  // ---- Matrix case 5: adversarial filenames — classify by REAL extension ----
  it("case 5 — adversarial: 'pftrace' substring in a .trace name is iOS; .pftrace is Android", async () => {
    // iOS session whose id literally contains the word 'pftrace' but the file
    // ends in .trace → must classify as iOS, NOT Android.
    await fs.mkdir(path.join(debugDir, "native-profiler-20260201-101010.trace"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(debugDir, "native-profiler-20260201-101010_raw_cpu.xml"),
      "<trace-query-result></trace-query-result>"
    );
    // Genuine Android .pftrace.
    await writeAndroidSession("20260202-202020", { metadata: true, report: false });

    const out = await runList();
    console.log(
      "\n===== adversarial extension classification — real list output =====\n" +
        out +
        "\n=================================================================\n"
    );

    const iosIdx = out.indexOf("(iOS)");
    const androidIdx = out.indexOf("(Android)");
    const iosSection = out.slice(iosIdx, androidIdx > iosIdx ? androidIdx : undefined);
    const androidSection = androidIdx > -1 ? out.slice(androidIdx) : "";

    // The 'pftrace'-named-but-.trace session is iOS only.
    expect(iosSection).toContain("20260201-101010");
    expect(androidSection).not.toContain("20260201-101010");
    // The real .pftrace is Android only.
    expect(androidSection).toContain("20260202-202020");
    expect(iosSection).not.toContain("20260202-202020");
  });

  it("case 5b — '...trace.pftrace' oddity classifies as Android (real extension .pftrace)", async () => {
    // A file whose name ends in `.trace.pftrace`: extension is .pftrace → Android.
    // We bypass writeAndroidSession to craft the odd name precisely.
    await fs.writeFile(
      path.join(debugDir, "native-profiler-20260303-303030.trace.pftrace"),
      "\x0a\x00bytes"
    );

    const out = await runList();
    console.log(
      "\n===== '.trace.pftrace' oddity — real list output =====\n" +
        out +
        "\n======================================================\n"
    );

    // Must be Android (ends in .pftrace), never iOS.
    expect(out).toContain("### Native Profiler Sessions (Android)");
    expect(out).not.toContain("### Native Profiler Sessions (iOS)");
    expect(out).toContain("`20260303-303030`");
    expect(countOccurrences(out, "20260303-303030")).toBe(1);
  });

  it("case 5c — an Android session with .pftrace + leftover -report.md never leaks into iOS (the regression)", async () => {
    // This is the exact scenario the PR fixes: the -report.md also matches the
    // native-profiler- prefix, so pre-fix it surfaced under BOTH headings.
    await writeAndroidSession("20260615-112028", { metadata: true, report: true });

    const out = await runList();
    expect(out).not.toContain("### Native Profiler Sessions (iOS)");
    expect(out).toContain("### Native Profiler Sessions (Android)");
    expect(countOccurrences(out, "20260615-112028")).toBe(1);
  });

  // ---- Matrix case 6: malformed / missing sidecars degrade gracefully ----
  it("case 6 — Android session with missing metadata & malformed report still classified, no throw", async () => {
    // No metadata sidecar, a malformed (non-markdown garbage) report present.
    await writeAndroidSession("20260404-040404", {
      metadata: false,
      report: "\x00\x01 not valid markdown \xff",
    });

    const out = await runList();
    expect(out).toContain("### Native Profiler Sessions (Android)");
    // listSessions does NOT read metadata/report contents for the list, so the
    // session is still classified and listed once with the report tag.
    expect(out).toContain("`20260404-040404` | pftrace, report |");
    expect(countOccurrences(out, "20260404-040404")).toBe(1);
  });

  it("case 6b — iOS session with malformed report & only leaks export degrades gracefully", async () => {
    await writeIosSession("20260505-050505", {
      cpu: false,
      hangs: false,
      leaks: true,
      report: "\x00 garbage report \xff",
    });

    const out = await runList();
    expect(out).toContain("### Native Profiler Sessions (iOS)");
    // Only leaks + report → "leaks, report".
    expect(out).toContain("`20260505-050505` | leaks, report |");
    expect(countOccurrences(out, "20260505-050505")).toBe(1);
  });

  // ---- Matrix case 7: co-timed iOS + Android under ONE session id ----
  it("case 7 — co-timed: ONE session id with both iOS and Android artifacts appears under BOTH headings (M1)", async () => {
    // iOS + Android captured in the same UTC second share one second-granular,
    // discriminator-free session id in the shared debug dir. Pre-fix the whole
    // group routed to Android and the iOS heading was HIDDEN (a visibility
    // regression). The session must now surface under BOTH headings, each
    // listing only its own artifacts.
    const ts = "20260615-112028";
    // iOS artifacts (xctrace .trace bundle + a raw CPU export).
    await fs.mkdir(path.join(debugDir, `native-profiler-${ts}.trace`), { recursive: true });
    await fs.writeFile(
      path.join(debugDir, `native-profiler-${ts}_raw_cpu.xml`),
      "<trace-query-result></trace-query-result>"
    );
    // Android artifacts (.pftrace + metadata sidecar).
    await fs.writeFile(path.join(debugDir, `native-profiler-${ts}.pftrace`), "\x0a\x00bytes");
    await fs.writeFile(
      path.join(debugDir, `native-profiler-${ts}.pftrace.metadata.json`),
      `${JSON.stringify(
        { platform: "android", appProcess: "com.example.app", wallClockStartMs: 1710000000000 },
        null,
        2
      )}\n`
    );
    // A single shared -report.md (matches the native prefix; both headings show it).
    await fs.writeFile(path.join(debugDir, `native-profiler-${ts}-report.md`), "# report\n");

    const out = await runList();
    console.log(
      "\n===== co-timed iOS+Android (M1) — real list output =====\n" +
        out +
        "\n========================================================\n"
    );

    const iosIdx = out.indexOf("### Native Profiler Sessions (iOS)");
    const androidIdx = out.indexOf("### Native Profiler Sessions (Android)");
    // BOTH headings present (pre-fix the iOS heading was missing entirely).
    expect(iosIdx).toBeGreaterThan(-1);
    expect(androidIdx).toBeGreaterThan(iosIdx);

    const iosSection = out.slice(iosIdx, androidIdx);
    const androidSection = out.slice(androidIdx);

    // The iOS row shows its own files (CPU + shared report), NOT pftrace.
    expect(iosSection).toContain(`\`${ts}\` | CPU, report |`);
    expect(iosSection).not.toContain("pftrace");
    // The Android row shows its own files (pftrace + shared report), NOT CPU.
    expect(androidSection).toContain(`\`${ts}\` | pftrace, report |`);
    expect(androidSection).not.toContain("CPU");

    // The session id appears under each heading exactly once (twice overall).
    expect(countOccurrences(out, ts)).toBe(2);
  });

  // ---- Matrix case 8: lone .pftrace.metadata.json (no bare .pftrace) ----
  it("case 8 — lone .pftrace.metadata.json (no bare .pftrace) classifies as Android, not iOS (L1)", async () => {
    // The metadata sidecar does NOT end in `.pftrace`, so the old
    // `.endsWith(".pftrace")` check misclassified a session whose only Android
    // marker was the sidecar as iOS. The `.pftrace.metadata.json` matcher fixes
    // this; the Android Files tag must omit the (absent) bare-pftrace tag.
    const ts = "20260707-070707";
    await fs.writeFile(
      path.join(debugDir, `native-profiler-${ts}.pftrace.metadata.json`),
      `${JSON.stringify({ platform: "android", appProcess: "com.example.app" })}\n`
    );
    await fs.writeFile(path.join(debugDir, `native-profiler-${ts}-report.md`), "# report\n");

    const out = await runList();
    console.log(
      "\n===== lone .pftrace.metadata.json (L1) — real list output =====\n" +
        out +
        "\n===============================================================\n"
    );

    expect(out).toContain("### Native Profiler Sessions (Android)");
    expect(out).not.toContain("### Native Profiler Sessions (iOS)");
    // No bare .pftrace on disk → the tag is just "report", never "pftrace".
    expect(out).toContain(`\`${ts}\` | report |`);
    expect(countOccurrences(out, ts)).toBe(1);
  });

  it("case 6c — debug dir missing entirely is recreated by getDebugDir, reports no sessions, no throw", async () => {
    // Remove the debug dir. Through the real execute() entry point, getDebugDir()
    // does `fs.mkdir(dir, { recursive: true })` BEFORE listSessions reads it, so
    // the directory always exists by the time readdir runs and we get the empty
    // "no sessions" message rather than the "_No debug directory found_" branch.
    await fs.rm(debugDir, { recursive: true, force: true });
    const out = await runList();
    expect(out).toContain("No profiling sessions found");
    // The dir was transparently recreated (empty) by getDebugDir.
    await expect(fs.readdir(debugDir)).resolves.toEqual([]);
  });
});
