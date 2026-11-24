/**
 * Shared failure-message format for the subprocess wrappers (`adb`, `vega`/
 * `kepler`, …): prefer the child's own stderr/stdout (the actionable diagnostic:
 * "device offline", etc.), and fall back to the bare message plus a
 * killed/signal/code suffix when both are empty (timeout-SIGKILL, daemon hang)
 * so the failure mode stays identifiable instead of a tautological "Command
 * failed".
 */

/** Fields we read off a Node `execFile` rejection. */
interface SubprocessErrorLike {
  code?: string | number | null;
  signal?: string | null;
  killed?: boolean;
  // Binary execs (runAdbBinary passes encoding:"buffer") reject with Buffer
  // stderr/stdout, not string, so coerce before trimming.
  stderr?: string | Buffer;
  stdout?: string | Buffer;
  message?: string;
}

/**
 * Build the `"<label> <argv> failed: <detail>"` message. `label` is the binary
 * name (`"adb"`, `"vega"`).
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
