import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseDeviceClaims, readDeviceClaims } from "../src/utils/device-claims";
import { applyDeviceClaims } from "../src/tools/devices/list-devices";

describe("parseDeviceClaims", () => {
  it("keeps well-formed entries and skips malformed ones", () => {
    const claims = parseDeviceClaims(
      JSON.stringify({
        "emulator-5554": { owner: "agent-2", mine: false },
        "AAAA-1111": { mine: true },
        "emulator-5556": { owner: "x" }, // no `mine`
        "bad": "nope",
      })
    );
    expect([...claims]).toEqual([
      ["emulator-5554", { owner: "agent-2", mine: false }],
      ["AAAA-1111", { mine: true }],
    ]);
  });

  it("treats non-object output as no claims", () => {
    expect(parseDeviceClaims("").size).toBe(0);
    expect(parseDeviceClaims("[]").size).toBe(0);
    expect(parseDeviceClaims("not json").size).toBe(0);
  });
});

describe.skipIf(process.platform === "win32")("readDeviceClaims", () => {
  let dir: string;
  const script = (name: string, body: string) => {
    const file = path.join(dir, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
    return file;
  };

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "argent-claims-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reads the provider's stdout", async () => {
    const cmd = script("ok.sh", `echo '{"emulator-5554":{"owner":"bob","mine":false}}'`);
    expect([...(await readDeviceClaims(cmd))]).toEqual([
      ["emulator-5554", { owner: "bob", mine: false }],
    ]);
  });

  it("ignores a provider that fails or is missing", async () => {
    const cmd = script("fail.sh", `echo '{"emulator-5554":{"mine":false}}'; exit 3`);
    expect((await readDeviceClaims(cmd)).size).toBe(0);
    expect((await readDeviceClaims(path.join(dir, "missing"))).size).toBe(0);
    expect((await readDeviceClaims(null)).size).toBe(0);
  });
});

describe("applyDeviceClaims", () => {
  const android = (serial: string, state = "device") =>
    ({
      platform: "android",
      serial,
      state,
      isEmulator: true,
      kind: "emulator",
      model: null,
      avdName: null,
      sdkLevel: null,
    }) as const;

  it("annotates claimed rows and lists busy devices after free ready ones", () => {
    const devices = [android("emulator-5554"), android("emulator-5556"), android("x", "offline")];
    const claims = new Map([
      ["emulator-5554", { owner: "alice", mine: false }],
      ["emulator-5556", { mine: true }],
    ]);
    const listed = applyDeviceClaims(devices, claims);
    expect(listed.map((d) => [(d as { serial: string }).serial, d.claim])).toEqual([
      ["emulator-5556", { mine: true }],
      ["emulator-5554", { owner: "alice", mine: false }],
      // A busy ready device still ranks above one that is not ready.
      ["x", undefined],
    ]);
  });
});
