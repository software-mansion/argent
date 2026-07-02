/**
 * Shared failure-message formatting for the subprocess wrappers (`adb`, `vega`/
 * `kepler`, …). The wrappers differ in how they classify a failure — `adb`
 * attaches a `FailureSignal` and throws a `FailureError`, the `vega` CLI throws a
 * plain `Error` — but the *message* they build is identical: prefer the child's
 * own stderr/stdout (the actionable diagnostic: "device offline", etc.), and
 * fall back to the bare message plus a killed/signal/code suffix when both are
 * empty (timeout-SIGKILL, daemon hang) so the failure mode stays identifiable
 * instead of a tautological "Command failed".
 *
 * Keeping this in one place means a later change to the format reaches every
 * subprocess wrapper rather than silently drifting between them.
 */

/** The shape of a Node `execFile` rejection we read fields off of. */
interface SubprocessErrorLike {
  code?: string | number | null;
  signal?: string | null;
  killed?: boolean;
  // Binary execs (e.g. runAdbBinary with encoding:"buffer") reject with Buffer
  // stderr/stdout, not string — so coerce before trimming below, otherwise
  // `.trim()` throws and masks the real diagnostic.
  stderr?: string | Buffer;
  stdout?: string | Buffer;
  message?: string;
}

/**
 * Build the `"<label> <argv> failed: <detail>"` message for a failed subprocess
 * invocation. `label` is the human binary name (`"adb"`, `"vega"`); `args` is the
 * argv passed to it.
 */
export function formatSubprocessFailure(label: string, args: string[], err: unknown): string {
  const e = err as SubprocessErrorLike;
  const argv = args.join(" ");
  const asText = (v: string | Buffer | undefined): string => (v == null ? "" : v.toString());
  const ioDetail = asText(e.stderr).trim() || asText(e.stdout).trim();
  if (ioDetail) return `${label} ${argv} failed: ${ioDetail}`;
  const meta: string[] = [];
  if (e.killed) meta.push("killed=true");
  if (e.signal) meta.push(`signal=${e.signal}`);
  if (e.code) meta.push(`code=${e.code}`);
  const baseMsg = (e.message ?? String(err)).trim();
  const suffix = meta.length ? ` (${meta.join(" ")})` : "";
  return `${label} ${argv} failed: ${baseMsg}${suffix}`;
}
