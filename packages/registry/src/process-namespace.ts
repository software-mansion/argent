import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readlink } from "node:fs/promises";
import { platform } from "node:os";

export async function processNamespaceId(): Promise<string | null> {
  try {
    let identity: string;
    if (platform() === "linux") {
      const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
      const namespace = await readlink("/proc/self/ns/pid");
      if (!boot || !namespace) return null;
      identity = `${boot}:${namespace}`;
    } else if (platform() === "darwin") {
      identity = (
        await new Promise<string>((resolve) => {
          execFile(
            "/usr/sbin/sysctl",
            ["-n", "kern.bootsessionuuid"],
            { timeout: 2_000 },
            (err, stdout) => resolve(err ? "" : stdout)
          );
        })
      ).trim();
      if (!identity) return null;
    } else {
      return null;
    }
    return createHash("sha256").update(identity).digest("hex").slice(0, 12);
  } catch {
    return null;
  }
}
