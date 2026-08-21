import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import { hdcFileRecv, hdcProse, runHdcShell } from "../src/utils/harmony-hdc";

// Every case below is a real `hdc` outcome that exits 0 with no `[Fail]` line,
// so nothing but what was printed separates them. Measured on hdc 3.2.0d:
// a completed transfer prints `FileTransfer finish, …`, and a client that
// cannot reach its own server writes bare prose to STDERR with stdout empty.
// The stub reads the case from a file rather than argv so one binary can stand
// in for all of them.
const root = mkdtempSync(join(tmpdir(), "argent-deveco-"));
const binDir = join(root, "sdk", "default", "openharmony", "toolchains");
const modeFile = join(root, "mode");
mkdirSync(binDir, { recursive: true });
writeFileSync(
  join(binDir, "hdc"),
  `#!/usr/bin/env bash
case "$(cat ${modeFile})" in
  connect-fail) echo "Connect server failed" >&2 ;;
  transfer-ok) echo "FileTransfer finish, Size:6, File count = 1, time:10ms rate:0.60kB/s" ;;
  truncated) echo "DumpLayout saved to:/data/local/tmp/dump.json" ;;
  shell-ok) printf 'line one\nline two\n__argent_hdc_rc=0\n' ;;
  shell-decoy) printf '__argent_hdc_rc=99 is device output, not the echo\nreal output\n__argent_hdc_rc=3\n' ;;
  shell-inline-token) printf 'saved to /tmp/__argent_hdc_rc=0.json\n' ;;
  shell-garbled-status) printf 'work done\n__argent_hdc_rc=x\n' ;;
  silent) ;;
esac
exit 0
`,
  { mode: 0o755 }
);
const hdcBehaves = (mode: string): void => writeFileSync(modeFile, mode);

beforeAll(() => vi.stubEnv("DEVECO_STUDIO_HOME", root));
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

async function rejection(p: Promise<unknown>): Promise<Error> {
  return p.then(
    () => {
      throw new Error("expected a rejection, got a resolution");
    },
    (e: unknown) => e as Error
  );
}

describe("hdcFileRecv success is read off the transfer line", () => {
  const remote = "/data/local/tmp/argent-screen.png";

  it("refuses a transfer the connector never made", async () => {
    // The whole failure is on stderr with no prefix, so classifying on `[Fail]`
    // alone resolves — handing `harmony-screen` a path with nothing at it, where
    // `readFile` throws a bare ENOENT naming a tmp file, the connector's own
    // diagnostic having already been dropped.
    hdcBehaves("connect-fail");
    const err = await rejection(hdcFileRecv("127.0.0.1:5555", remote, join(root, "out.png")));
    expect(err.message).toContain("Connect server failed");
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.HARMONY_FILE_TRANSFER_FAILED);
  });

  it("refuses a silent run rather than reading silence as a copy", async () => {
    hdcBehaves("silent");
    const err = await rejection(hdcFileRecv("127.0.0.1:5555", remote, join(root, "out.png")));
    expect(err.message).toMatch(/neither a transfer nor a diagnostic/);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.HARMONY_FILE_TRANSFER_FAILED);
  });

  it("accepts a completed transfer", async () => {
    // The other half of the positive match: every HarmonyOS screenshot and
    // layout dump goes through here, so a marker that never matches breaks all
    // of them just as silently as one that always does.
    hdcBehaves("transfer-ok");
    await expect(
      hdcFileRecv("127.0.0.1:5555", remote, join(root, "out.png"))
    ).resolves.toBeUndefined();
  });
});

describe("runHdcShell without an exit status", () => {
  it("quotes the connector's own diagnostic instead of blaming the device", async () => {
    // Same stderr prose, one layer up: it leaves stdout empty, so the rc
    // sentinel is missing and this lands in the no-status branch. Sending the
    // caller to look at a device that was never reached is the wrong repair.
    hdcBehaves("connect-fail");
    const err = await rejection(runHdcShell("127.0.0.1:5555", "uitest dumpLayout"));
    expect(err.message).toContain("Connect server failed");
    expect(err.message).not.toMatch(/terminated on the device/);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.HARMONY_SHELL_NO_STATUS);
  });

  it("still names a truncated command when hdc said nothing at all", async () => {
    hdcBehaves("silent");
    const err = await rejection(runHdcShell("127.0.0.1:5555", "uitest dumpLayout"));
    expect(err.message).toMatch(/returned no exit status/);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.HARMONY_SHELL_NO_STATUS);
  });

  it("does not quote a cut-off command's own output back as hdc's verdict", async () => {
    // `uitest`'s success line is prose by every test {@link hdcProse} applies —
    // spaces, no tab, no prefix. Output that arrived without the sentinel is a
    // command that ran and was truncated, which is the opposite repair from a
    // connector that never reached the device.
    hdcBehaves("truncated");
    const err = await rejection(runHdcShell("127.0.0.1:5555", "uitest dumpLayout"));
    expect(err.message).toMatch(/returned no exit status/);
    expect(err.message).not.toContain("DumpLayout saved to");
  });
});

describe("runHdcShell recovering the remote exit status", () => {
  it("returns the command's own output, without the echo that carried the status", () => {
    // The sentinel line is argent's, not the command's. Left in, it lands in
    // whatever parses this output — `resolveHarmonyEntry` runs `JSON.parse` on
    // it, so a trailing sentinel breaks every launch-app and open-url.
    hdcBehaves("shell-ok");
    return expect(runHdcShell("127.0.0.1:5555", "echo hi")).resolves.toEqual({
      stdout: "line one\nline two",
      exitCode: 0,
    });
  });

  it("takes the last status echo, not a line the command printed that looks like one", async () => {
    hdcBehaves("shell-decoy");
    const result = await runHdcShell("127.0.0.1:5555", "cat /tmp/log");
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toContain("real output");
  });

  it("does not accept the token buried in a line as the status", async () => {
    // Matched at the start of a line only: a device path or log line that merely
    // contains the token is not the echo, and reading it as one fabricates an
    // exit status for a command whose real one never came back.
    hdcBehaves("shell-inline-token");
    const err = await rejection(runHdcShell("127.0.0.1:5555", "uitest dumpLayout"));
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.HARMONY_SHELL_NO_STATUS);
  });

  it("reports an unreadable status as failure rather than as 0", async () => {
    hdcBehaves("shell-garbled-status");
    const result = await runHdcShell("127.0.0.1:5555", "uitest dumpLayout");
    expect(result.exitCode).toBe(-1);
  });
});

describe("hdcProse tells a diagnostic from output", () => {
  const of = (stdout: string, stderr = "") => hdcProse({ stdout, stderr });

  it("reads a bare diagnostic off either stream", () => {
    expect(of("", "Connect server failed\n")).toBe("Connect server failed");
    expect(of("Connect server failed\n")).toBe("Connect server failed");
  });

  it("does not read hdc's own tabular output as prose", () => {
    // `list targets -v` rows are tab-separated and hold spaces in no column that
    // matters; taken as a diagnostic, a healthy device table would read as a
    // connector failure and hide every attached device.
    expect(of("025DEK236V035771\t\tUSB\tConnected\tlocalhost\n")).toBeNull();
  });

  it("does not read a bare connect key as prose", () => {
    expect(of("127.0.0.1:5555\n")).toBeNull();
  });

  it("leaves the bracketed forms to their own readers", () => {
    // `[Fail]` is hdcFailure's, `[Empty]` means "none" — neither is an
    // unprefixed diagnostic, and claiming them here would double-report one
    // failure and turn an empty device list into an error.
    expect(of("[Fail]Not match target founded, check connect-key please\n")).toBeNull();
    expect(of("[Empty]\n")).toBeNull();
  });
});
