import { describe, it, expect, afterEach } from "vitest";
import { redirectTmpdir } from "./helpers/tmpdir-env";

// The variable os.tmpdir() consults is platform-dependent — POSIX reads TMPDIR,
// TMP, TEMP in that order and Windows reads TEMP then TMP — so a redirect that
// covers only the local platform's name leaves the other one resolving into the
// machine-wide temp directory. The files that scope the tmpdir to catch a leak
// then scan a directory nothing writes to and pass whatever the code does.
const LOOKUPS = {
  posix: ["TMPDIR", "TMP", "TEMP"],
  win32: ["TEMP", "TMP"],
};

describe("redirectTmpdir", () => {
  const saved = new Map<string, string | undefined>();
  for (const k of ["TMPDIR", "TEMP", "TMP"]) saved.set(k, process.env[k]);

  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it.each(Object.entries(LOOKUPS))(
    "redirects the whole %s lookup chain, not just its first entry",
    (_platform, chain) => {
      const restore = redirectTmpdir("/scratch/owned-by-this-run");
      try {
        for (const key of chain) {
          expect(process.env[key]).toBe("/scratch/owned-by-this-run");
        }
      } finally {
        restore();
      }
    }
  );

  it("restores an absent variable by deleting it rather than setting undefined", () => {
    delete process.env.TEMP;
    process.env.TMPDIR = "/before";

    redirectTmpdir("/scratch")();

    expect("TEMP" in process.env).toBe(false);
    expect(process.env.TMPDIR).toBe("/before");
  });
});
