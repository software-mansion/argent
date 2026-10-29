import { promises as fs, renameSync } from "node:fs";
import os from "node:os";
import { processNamespaceId } from "@argent/registry";
import path from "node:path";

const PREFIX = "argent-recording-frames-";

export async function cleanupAbandonedFrames(): Promise<void> {
  const namespace = await processNamespaceId();
  if (!namespace) return;
  for (const entry of await fs.readdir(os.tmpdir(), { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(PREFIX)) continue;
    const directory = path.join(os.tmpdir(), entry.name);
    const owner = /^(\d+)-([a-f0-9]{12})-/.exec(entry.name.slice(PREFIX.length));
    if (!owner || owner[2] !== namespace) continue;
    try {
      process.kill(Number(owner[1]), 0);
      if (os.platform() !== "linux") continue;
      const stat = await fs.readFile(`/proc/${owner[1]}/stat`, "utf8");
      if (!stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ")) continue;
    } catch (err) {
      if (!["ESRCH", "ENOENT"].includes((err as NodeJS.ErrnoException).code ?? "")) continue;
    }
    await fs.rm(directory, { recursive: true, force: true }).catch((err: unknown) => {
      process.stderr.write(
        `[screen-recording] Could not remove abandoned JPEGs at ${directory}: ${String(err)}\n`
      );
    });
  }
}

export async function createFrameDirectory(): Promise<string> {
  await cleanupAbandonedFrames();
  const namespace = await processNamespaceId();
  return fs.mkdtemp(path.join(os.tmpdir(), `${PREFIX}${process.pid}-${namespace ?? "unknown"}-`));
}

// The encoder can outlive the tool-server's shutdown grace.
export function setFrameDirectoryOwner(directory: string, pid: number): string {
  const owned = path.join(
    path.dirname(directory),
    path.basename(directory).replace(`${PREFIX}${process.pid}-`, `${PREFIX}${pid}-`)
  );
  renameSync(directory, owned);
  return owned;
}
