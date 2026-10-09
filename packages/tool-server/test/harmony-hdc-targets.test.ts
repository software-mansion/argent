import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listHarmonyHdcTargets,
  listHarmonyHdcTargetsStrict,
  parseHdcTargets,
} from "../src/utils/harmony-devices";

// A real stub binary reached through the documented `$DEVECO_STUDIO_HOME`
// layout, as `harmony-hdc-timeout.test.ts` does: what is under test is `hdc`
// reporting a failure while exiting 0, which a mock at the run boundary would
// assert rather than reproduce — including WHICH STREAM it uses, the detail
// that defeated the first attempt at this guard. `$HDC_STUB_OUT` goes to
// stdout, `$HDC_STUB_ERR` to stderr.
const root = mkdtempSync(join(tmpdir(), "argent-deveco-targets-"));
const binDir = join(root, "sdk", "default", "openharmony", "toolchains");
mkdirSync(binDir, { recursive: true });
writeFileSync(
  join(binDir, "hdc"),
  '#!/usr/bin/env bash\nprintf %s "$HDC_STUB_OUT"\nprintf %s "$HDC_STUB_ERR" >&2\n',
  { mode: 0o755 }
);

/** Verbatim `hdc list targets -v` with one phone attached. */
const REAL_ROW = "025DEK236V035771\t\tUSB\tConnected\tlocalhost\n";
/**
 * Verbatim hdc 3.2.0d that cannot reach its server: stdout EMPTY, this on
 * stderr, exit 0, and no `[Fail]` prefix — connector-level failures print
 * differently from the device-level ones that carry it.
 */
const PROSE_ERR = "Connect server failed\n";
/** The prefixed form, as `hdc tconn` to a dead endpoint prints it. */
const PREFIXED = "[Fail]Connect server failed\n";

function said(out: string, err = "") {
  vi.stubEnv("HDC_STUB_OUT", out);
  vi.stubEnv("HDC_STUB_ERR", err);
}

beforeAll(() => vi.stubEnv("DEVECO_STUDIO_HOME", root));
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("hdc reporting a failure instead of listing targets", () => {
  it("is not parsed as a target called `Connect`", () => {
    // Split on whitespace the three words are the shape of a `-v` row, so
    // without the delimiter check this is a device that does not exist —
    // offered to `list-devices` and counted in a boot's baseline.
    expect(parseHdcTargets("Connect server failed\n")).toEqual([]);
    expect(parseHdcTargets(`${REAL_ROW}Connect server failed\n`)).toEqual([
      { connectKey: "025DEK236V035771", connection: "USB", state: "Connected" },
    ]);
  });

  it("is an empty device table to a polling caller, on either stream", async () => {
    // Exit status cannot tell this from success, so a caller watching for a
    // change gets what it wants either way: nothing new.
    for (const [out, err] of [
      ["", PROSE_ERR],
      [PREFIXED, ""],
    ]) {
      said(out!, err!);
      await expect(listHarmonyHdcTargets()).resolves.toEqual([]);
    }
  });

  it("is raised for a caller establishing a baseline, including on stderr", async () => {
    // The stderr case is the one that matters: stdout is empty, so the listing
    // parses to a clean `[]` and `boot-device` would adopt an emulator that was
    // already connected as the instance it just started.
    for (const [out, err] of [
      ["", PROSE_ERR],
      [PREFIXED, ""],
    ]) {
      said(out!, err!);
      await expect(listHarmonyHdcTargetsStrict()).rejects.toThrow(/Connect server failed/);
    }
  });

  it("never displaces a listing that did print rows", async () => {
    // The guard keys on prose being space-delimited where a row is tabbed, so a
    // real listing must survive it — including one a diagnostic trails, on
    // EITHER form. The prefixed form is the one that had no guard of its own:
    // `hdcFailure` was consulted ahead of the rows-were-printed check, so a
    // `[Fail]` line beside a real listing emptied it for a polling caller and
    // refused the boot for a strict one. `parseAdbDevices` holds the same line.
    for (const [out, err] of [
      [REAL_ROW, ""],
      [REAL_ROW, PROSE_ERR],
      [REAL_ROW, PREFIXED],
      [`${PREFIXED}${REAL_ROW}`, ""],
    ]) {
      said(out!, err!);
      await expect(listHarmonyHdcTargetsStrict()).resolves.toEqual([
        { connectKey: "025DEK236V035771", connection: "USB", state: "Connected" },
      ]);
      await expect(listHarmonyHdcTargets()).resolves.toEqual([
        { connectKey: "025DEK236V035771", connection: "USB", state: "Connected" },
      ]);
    }
  });

  it("reports a genuinely empty device table as empty, not as a refusal", async () => {
    said("[Empty]\n");
    await expect(listHarmonyHdcTargetsStrict()).resolves.toEqual([]);
  });
});
