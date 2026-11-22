import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listHarmonyHdcTargets,
  listHarmonyHdcTargetsStrict,
  parseHdcTargets,
} from "../src/utils/harmony-devices";

// A real stub via `$DEVECO_STUDIO_HOME`: which stream `hdc` writes to matters.
const root = mkdtempSync(join(tmpdir(), "argent-deveco-targets-"));
const binDir = join(root, "sdk", "default", "openharmony", "toolchains");
mkdirSync(binDir, { recursive: true });
writeFileSync(
  join(binDir, "hdc"),
  '#!/usr/bin/env bash\nprintf %s "$HDC_STUB_OUT"\nprintf %s "$HDC_STUB_ERR" >&2\n',
  { mode: 0o755 }
);

const REAL_ROW = "025DEK236V035771\t\tUSB\tConnected\tlocalhost\n";
/** Verbatim hdc 3.2.0d with no server: stdout empty, this on stderr, exit 0. */
const PROSE_ERR = "Connect server failed\n";
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
    expect(parseHdcTargets("Connect server failed\n")).toEqual([]);
    expect(parseHdcTargets(`${REAL_ROW}Connect server failed\n`)).toEqual([
      { connectKey: "025DEK236V035771", connection: "USB", state: "Connected" },
    ]);
  });

  it("is an empty device table to a polling caller, on either stream", async () => {
    for (const [out, err] of [
      ["", PROSE_ERR],
      [PREFIXED, ""],
    ]) {
      said(out!, err!);
      await expect(listHarmonyHdcTargets()).resolves.toEqual([]);
    }
  });

  it("is raised for a caller establishing a baseline, including on stderr", async () => {
    // Stdout is empty here, so a lenient parse would yield a clean `[]`.
    for (const [out, err] of [
      ["", PROSE_ERR],
      [PREFIXED, ""],
    ]) {
      said(out!, err!);
      await expect(listHarmonyHdcTargetsStrict()).rejects.toThrow(/Connect server failed/);
    }
  });

  it("never displaces a listing that did print rows", async () => {
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
