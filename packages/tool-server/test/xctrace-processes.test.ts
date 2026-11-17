/**
 * The host's `xctrace record` processes, which native-profiler-start refuses
 * next to: from `ps`, by the executable, not by a command line that names it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.unmock("../src/utils/ios-profiler/xctrace-processes");

const ps = vi.hoisted(() => ({
  outputs: [] as (string | Error)[],
  calls: [] as string[][],
  files: [] as string[],
}));
vi.mock("node:child_process", async (importOriginal) => {
  const { promisify: custom } = await import("node:util");
  const execFile = Object.assign(vi.fn(), {
    [custom.custom]: async (file: string, args: string[]) => {
      ps.files.push(file);
      ps.calls.push(args);
      const next = ps.outputs.shift() ?? "";
      if (next instanceof Error) throw next;
      return { stdout: next, stderr: "" };
    },
  });
  return { ...(await importOriginal<typeof import("node:child_process")>()), execFile };
});

import { runningXctraceRecordings } from "../src/utils/ios-profiler/xctrace-processes";
import { PS_BIN } from "../src/utils/vega-process";

const XCTRACE = "/Applications/Xcode.app/Contents/Developer/usr/bin/xctrace";

beforeEach(() => {
  ps.outputs = [];
  ps.calls = [];
  ps.files = [];
});

describe("runningXctraceRecordings", () => {
  it("lists the xctrace processes that record, with their run time", async () => {
    ps.outputs = [
      [
        `    1 /sbin/launchd`,
        `  321 ${XCTRACE}`,
        `  322 /Applications/Xcode 27 beta.app/Contents/Developer/usr/bin/xctrace`,
        `  400 /usr/bin/pgrep`,
        `  500 ${XCTRACE}`,
      ].join("\n"),
      [
        `  321    01:05 ${XCTRACE} record --template Time Profiler --all-processes --output a.trace`,
        `  322 1-02:03:04 /Applications/Xcode 27 beta.app/Contents/Developer/usr/bin/xctrace record --attach 9`,
        `  500    00:02 ${XCTRACE} export --input a.trace --toc`,
      ].join("\n"),
    ];

    const found = await runningXctraceRecordings();

    expect(ps.calls[1]).toEqual(["-o", "pid=,etime=,args=", "-p", "321,322,500"]);
    expect(found).toEqual([
      {
        pid: 321,
        elapsed: "01:05",
        command: `${XCTRACE} record --template Time Profiler --all-processes --output a.trace`,
      },
      {
        pid: 322,
        elapsed: "1-02:03:04",
        command:
          "/Applications/Xcode 27 beta.app/Contents/Developer/usr/bin/xctrace record --attach 9",
      },
    ]);
  });

  it("does not count a process whose command line only names xctrace", async () => {
    ps.outputs = [`  400 /usr/bin/pgrep\n  401 /bin/zsh\n`];

    expect(await runningXctraceRecordings()).toEqual([]);
    // pgrep -f "xctrace record" and a shell are not xctrace, so ps is not asked for their command lines.
    expect(ps.calls).toHaveLength(1);
  });

  // A tool-server that a GUI app or launchd started has a PATH without /bin, where ps is.
  it("runs ps by its absolute path, not from PATH", async () => {
    ps.outputs = [`  321 ${XCTRACE}\n`, `  321    01:05 ${XCTRACE} record --all-processes\n`];

    expect(await runningXctraceRecordings()).toHaveLength(1);
    expect(ps.files).toEqual([PS_BIN, PS_BIN]);
  });

  it("knows of no recording when ps fails", async () => {
    ps.outputs = [new Error("ps: fork failed")];

    expect(await runningXctraceRecordings()).toEqual([]);
  });
});
