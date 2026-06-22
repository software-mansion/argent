import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach } from "vitest";
import { _resetConsentCacheForTest } from "../src/consent.js";
import { _resetIdentityCacheForTest } from "../src/identity.js";

let savedHome: string | undefined;
let savedUserProfile: string | undefined;

// Point telemetry home resolution at a vitest-scoped temp directory.
export function useTempHome(): { tmp: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "argent-telemetry-"));
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  return { tmp };
}

export function restoreHome(tmp: string): void {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedUserProfile;
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  _resetConsentCacheForTest();
  _resetIdentityCacheForTest();
}

export function scopeHome(): { tmp: () => string } {
  let active: string;
  beforeEach(() => {
    const { tmp } = useTempHome();
    active = tmp;
  });
  afterEach(() => {
    restoreHome(active);
  });
  return { tmp: () => active };
}

export function withEnv(snapshot: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(snapshot)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/** Snapshot env vars and return a restorer. */
export function snapshotEnv(keys: string[]): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) saved[k] = process.env[k];
  return () => withEnv(saved);
}
