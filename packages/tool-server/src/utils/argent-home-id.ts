import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { argentHomeDir, canonicalPath, resolveHomeDir } from "@argent/configuration-core";

/** Response header naming the Argent home a tool-server runs under, as an opaque id. */
export const ARGENT_HOME_HEADER = "x-argent-home";

/** Canonical spelling of `dir`, also when it does not exist yet. */
function canonicalDir(dir: string): string {
  const resolved = path.resolve(dir);
  const parent = path.dirname(resolved);
  if (fs.existsSync(resolved) || parent === resolved) return canonicalPath(resolved);
  return path.join(canonicalDir(parent), path.basename(resolved));
}

export function argentHomeId(dir: string = argentHomeDir()): string {
  return createHash("sha256").update(canonicalDir(dir)).digest("hex").slice(0, 12);
}

/** Older tool-servers send no header and always run under `~/.argent`. */
export function peerArgentHomeId(header: string | string[] | undefined): string {
  if (typeof header === "string" && header) return header;
  return argentHomeId(path.join(resolveHomeDir(), ".argent"));
}

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** Only a peer on this machine needs the header, so a network client never sees it. */
export function isLocalConnection(socket: {
  remoteAddress?: string;
  localAddress?: string;
}): boolean {
  const remote = socket.remoteAddress;
  if (remote === undefined) return false;
  return LOOPBACK_ADDRESSES.has(remote) || remote === socket.localAddress;
}
