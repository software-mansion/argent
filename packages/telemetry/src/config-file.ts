import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { argentHomeDir, configFilePath } from "./paths.js";

// Shared read/write for ~/.argent/config.json. The config holds several
// independent keys (telemetry consent, first-run notices, ...), so every writer
// must merge rather than overwrite, and publish atomically so an interrupted
// write can never truncate keys it does not own.

/** Parse the config document, returning an empty object when missing/malformed. */
export function readConfigObject(): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(configFilePath(), "utf8");
    const json = JSON.parse(raw) as unknown;
    if (json && typeof json === "object") {
      return json as Record<string, unknown>;
    }
  } catch {
    /* missing or malformed — treat as a fresh document */
  }
  return {};
}

/**
 * Apply `mutate` to the current config and persist the result atomically.
 *
 * Reads the existing document (preserving keys this caller does not touch),
 * lets `mutate` patch it in place, then writes to a temp file and renames so a
 * crash mid-write leaves the previous config intact.
 */
export function updateConfig(mutate: (config: Record<string, unknown>) => void): void {
  fs.mkdirSync(argentHomeDir(), { recursive: true });

  const next = readConfigObject();
  mutate(next);

  const finalPath = configFilePath();
  const tmpPath = path.join(argentHomeDir(), `.config.tmp.${process.pid}.${crypto.randomUUID()}`);
  const fd = fs.openSync(tmpPath, "wx", 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(next, null, 2) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmpPath, finalPath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* nothing to clean up */
    }
    throw err;
  }
}
