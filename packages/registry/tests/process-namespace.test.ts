import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { readFile, readlink } from "node:fs/promises";
import * as os from "node:os";
import { processNamespaceId } from "../src/process-namespace";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
vi.mock("node:fs/promises", () => ({ readFile: vi.fn(), readlink: vi.fn() }));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
}));

beforeEach(() => {
  vi.spyOn(os, "platform").mockReturnValue("linux");
  vi.mocked(readFile).mockResolvedValue("boot-one");
  vi.mocked(readlink).mockResolvedValue("pid:[1234]");
});
afterEach(() => vi.restoreAllMocks());

it("separates Linux boots and PID namespaces", async () => {
  const first = await processNamespaceId();
  expect(first).toMatch(/^[a-f0-9]{12}$/);
  vi.mocked(readFile).mockResolvedValue("boot-two");
  expect(await processNamespaceId()).not.toBe(first);
  vi.mocked(readFile).mockResolvedValue("boot-one");
  vi.mocked(readlink).mockResolvedValue("pid:[5678]");
  expect(await processNamespaceId()).not.toBe(first);
});

it("keeps macOS ownership stable across hostname changes", async () => {
  vi.mocked(os.platform).mockReturnValue("darwin");
  vi.spyOn(os, "hostname").mockReturnValue("first.local");
  let boot = "boot-session-uuid\n";
  const probe = vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const callback = args[3] as (err: Error | null, stdout: string) => void;
    callback(null, boot);
    return {} as ReturnType<typeof execFile>;
  });
  const first = await processNamespaceId();
  expect(first).toMatch(/^[a-f0-9]{12}$/);
  vi.mocked(os.hostname).mockReturnValue("dhcp.example.com");
  expect(await processNamespaceId()).toBe(first);
  boot = "other-boot-session-uuid\n";
  expect(await processNamespaceId()).not.toBe(first);
  expect(probe).toHaveBeenCalledWith(
    "/usr/sbin/sysctl",
    ["-n", "kern.bootsessionuuid"],
    { timeout: 2_000 },
    expect.any(Function)
  );
});

it.each(["boot", "namespace", "macOS"])(
  "disables cleanup when %s identity is unavailable",
  async (part) => {
    if (part === "boot") vi.mocked(readFile).mockRejectedValue(new Error("unavailable"));
    else if (part === "namespace") vi.mocked(readlink).mockRejectedValue(new Error("unavailable"));
    else {
      vi.mocked(os.platform).mockReturnValue("darwin");
      vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
        (args[3] as (err: Error) => void)(new Error("unavailable"));
        return {} as ReturnType<typeof execFile>;
      });
    }
    expect(await processNamespaceId()).toBeNull();
  }
);
