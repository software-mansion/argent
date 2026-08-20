/**
 * Point `os.tmpdir()` at `dir` for the caller, and return the restore.
 *
 * `os.tmpdir()` re-reads the environment on every call, but not the same
 * variable everywhere: POSIX takes TMPDIR, TMP, TEMP in that order, and Windows
 * takes TEMP then TMP and never looks at TMPDIR. Setting TMPDIR alone leaves a
 * Windows run materializing into the machine-wide %TEMP% while the test scans a
 * scratch directory nothing ever writes to — so a leak assertion over that
 * listing passes there no matter what the code under test does.
 *
 * Restore before deleting `dir`, so a later suite still resolves a real tmpdir
 * even if that cleanup rejects.
 */
export function redirectTmpdir(dir: string): () => void {
  const keys = ["TMPDIR", "TEMP", "TMP"] as const;
  const saved = keys.map((k) => [k, process.env[k]] as const);
  for (const k of keys) process.env[k] = dir;

  return () => {
    for (const [k, value] of saved) {
      if (value === undefined) delete process.env[k];
      else process.env[k] = value;
    }
  };
}
