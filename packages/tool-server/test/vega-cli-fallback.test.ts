import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveVegaBinary, __resetVegaBinaryCacheForTests } from "../src/utils/vega-cli";

// resolveVegaBinary's fallback is join(homedir(), "vega", "bin", "vega").
// os.homedir() reads USERPROFILE on Windows and HOME elsewhere, so point both at
// a temp dir, and neutralize PATH so the on-PATH `command -v vega/kepler` lookups
// miss and the SDK fallback path is exercised.
let tmpHome: string;
let savedHome: string | undefined;
let savedUserProfile: string | undefined;
let savedPath: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "vega-home-"));
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
  savedPath = process.env.PATH;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.PATH = join(tmpHome, "no-such-bin"); // nothing resolvable on PATH
  __resetVegaBinaryCacheForTests();
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedUserProfile;
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
  __resetVegaBinaryCacheForTests();
  rmSync(tmpHome, { recursive: true, force: true });
});

function writeFallbackBinary(mode: number): string {
  const dir = join(tmpHome, "vega", "bin");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "vega");
  writeFileSync(p, "#!/bin/sh\necho vega\n");
  chmodSync(p, mode);
  return p;
}

describe("resolveVegaBinary fallback gating", () => {
  it("does not return a present-but-non-executable ~/vega/bin/vega", async () => {
    // A partial/corrupted SDK install: the file exists but lacks +x. Returning it
    // makes runVega fail later with an opaque EACCES at spawn instead of the
    // actionable not-found message.
    writeFallbackBinary(0o644);
    expect(await resolveVegaBinary()).toBeNull();
  });

  it("returns the fallback when it is executable", async () => {
    const p = writeFallbackBinary(0o755);
    expect(await resolveVegaBinary()).toBe(p);
  });
});
