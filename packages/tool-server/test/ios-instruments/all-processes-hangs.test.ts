/**
 * The all-processes capture (the iOS default on Xcode 26.4 and later) records the whole
 * host, so its hangs export holds the hangs of every process: other simulators'
 * SpringBoard, other apps. The CPU samples were filtered to the app's PID, the hangs were
 * not, so the report gave other processes' hangs as the app's. The rows below are from
 * such an export of an idle app (Xcode 27.2), plus one hang of the app itself.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIosProfilerPipeline } from "../../src/utils/ios-profiler/pipeline/index";

const APP_PID = 3745;

function thread(id: number, name: string, pid: number, processId: number): string {
  return (
    `<thread id="${id}" fmt="Main Thread (0x6d94dd3) (${name}, pid: ${pid})">` +
    `<tid id="${id + 1}" fmt="0x6d94dd3">114904531</tid>` +
    `<process id="${processId}" fmt="${name} (${pid})"><pid id="${processId + 1}" fmt="${pid}">${pid}</pid>` +
    `<device-session id="${processId + 2}" fmt="TODO">TODO</device-session></process></thread>`
  );
}

const HANGS_XML =
  `<?xml version="1.0"?><trace-query-result><node xpath='//trace-toc[1]/run[1]/data[1]/table[10]'>` +
  // Another app, its thread and process defined in the row.
  `<row><start-time id="1" fmt="00:00.805.145">805145541</start-time><duration id="2" fmt="735.02 ms">735020375</duration>` +
  `<hang-type id="3" fmt="Hang">Hang</hang-type>${thread(4, "UnityPoster", 69175, 6)}<process ref="6"/></row>` +
  // Another simulator's SpringBoard.
  `<row><start-time id="20" fmt="00:02.094.713">2094713625</start-time><duration id="21" fmt="370.93 ms">370928833</duration>` +
  `<hang-type id="22" fmt="Microhang">Microhang</hang-type>${thread(23, "SpringBoard", 40510, 25)}<process ref="25"/></row>` +
  // The app: a hang whose type and duration refer to values defined in other processes' rows.
  `<row><start-time id="40" fmt="00:03.000.000">3000000000</start-time><duration ref="2"/>` +
  `<hang-type ref="3"/>${thread(41, "ProfProbe", APP_PID, 43)}<process ref="43"/></row>` +
  // SpringBoard again, with its thread and process as references.
  `<row><start-time id="60" fmt="00:04.800.696">4800696250</start-time><duration id="61" fmt="360.87 ms">360869916</duration>` +
  `<hang-type ref="22"/><thread ref="23"/><process ref="25"/></row>` +
  `</node></trace-query-result>`;

describe("hangs of an all-processes capture", () => {
  let dir = "";
  let hangs = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "argent-all-processes-hangs-"));
    hangs = join(dir, "hangs.xml");
    writeFileSync(hangs, HANGS_XML);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("are only the app's own when the capture is filtered to the app's PID", async () => {
    const out = await runIosProfilerPipeline(
      { cpu: null, hangs, leaks: null },
      { cpuFilterPid: APP_PID }
    );

    expect(out.uiHangs).toHaveLength(1);
    expect(out.uiHangs[0]).toMatchObject({ hangType: "Hang", durationMs: 735 });
    expect(out.uiHangs[0]!.startNs).toBe(3_000_000_000);
  });

  it("are all of the export's without a filter, as for a capture of the app alone", async () => {
    const out = await runIosProfilerPipeline({ cpu: null, hangs, leaks: null });
    expect(out.uiHangs.map((h) => h.durationMs)).toEqual([735, 371, 735, 361]);
  });
});
