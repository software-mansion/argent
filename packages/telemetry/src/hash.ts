import * as crypto from "node:crypto";

// Build-time salt prefix for device id hashes.
declare const ARGENT_CLI_MAJOR_VERSION: string | undefined;

function readSalt(): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const define = (globalThis as any).ARGENT_CLI_MAJOR_VERSION;
  if (typeof define === "string" && define !== "") return define;
  if (typeof ARGENT_CLI_MAJOR_VERSION === "string" && ARGENT_CLI_MAJOR_VERSION !== "") {
    return ARGENT_CLI_MAJOR_VERSION;
  }
  return "0";
}

/** Truncated, salted SHA-256 of a sensitive device identifier. */
export function hashId(value: string): string {
  const salt = readSalt();
  return crypto.createHash("sha256").update(`${salt}:${value}`).digest("hex").slice(0, 12);
}
