import * as fs from "node:fs";
import type net from "node:net";
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

/**
 * Bind a server on a free loopback port and return the port. A bind that fails has to
 * reject: `listen`'s callback fires only on success, so awaiting it alone turns
 * an EADDRNOTAVAIL into a test that hangs to its timeout while the unhandled
 * 'error' event surfaces against whichever test vitest happens to be running.
 */
export async function listenLoopback(server: net.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}
