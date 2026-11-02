import * as fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { readRunnerSessionToken } from "../src/utils/ios-device/devicectl";

const fake = vi.hoisted(() => ({ data: "", argv: [] as string[], folder: "" }));
vi.mock("node:child_process", async () => {
  const { writeFileSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  return {
    execFile: (_file: unknown, args: unknown, _options: unknown, callback: unknown) => {
      fake.argv = args as string[];
      const destination = fake.argv[fake.argv.indexOf("--destination") + 1]!;
      fake.folder = dirname(destination);
      writeFileSync(destination, fake.data);
      (callback as (error: null, output: { stdout: string; stderr: string }) => void)(null, {
        stdout: "",
        stderr: "",
      });
    },
  };
});

describe("runner session bootstrap through the paired connection", () => {
  it("reads the expected runner container and removes its local secret copy", async () => {
    const token = "a".repeat(64);
    fake.data = JSON.stringify({ port: 12345, token });
    await expect(
      readRunnerSessionToken("phone", "com.example.uitests.xctrunner", 12345)
    ).resolves.toBe(token);
    expect(fake.argv).toEqual(
      expect.arrayContaining([
        "copy",
        "from",
        "phone",
        "Documents/argent-runner-session.json",
        "appDataContainer",
        "com.example.uitests.xctrunner",
      ])
    );
    await expect(fs.stat(fake.folder)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    '{"token":"SECRET",',
    "null",
    JSON.stringify({ port: 12346, token: "a".repeat(64) }),
    JSON.stringify({ port: 12345, token: "bad" }),
    "x".repeat(4097),
  ])("rejects invalid or stale credentials without including their contents", async (data) => {
    fake.data = data;
    await expect(readRunnerSessionToken("phone", "runner", 12345)).rejects.toThrow(
      /^Invalid runner session$/
    );
    await expect(fs.stat(fake.folder)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
