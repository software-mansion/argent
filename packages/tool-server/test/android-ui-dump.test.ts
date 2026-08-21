import { beforeEach, describe, expect, it, vi } from "vitest";

// The shared hierarchy read is one command line, and every part of it is load
// bearing: the transport, the flag, the per-call path and the cleanup. It has
// two consumers — `describe` and the keyboard clear's measurement — and both
// mock it out, so nothing owned the command itself.
const { adbExecOutBinary } = vi.hoisted(() => ({
  adbExecOutBinary: vi.fn(
    async (
      _serial: string,
      _shellCommand: string,
      _options?: { timeoutMs?: number }
    ): Promise<Buffer> => Buffer.from("<hierarchy />")
  ),
}));
vi.mock("../src/utils/adb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/adb")>()),
  adbExecOutBinary,
}));

import { dumpAndroidUiXml } from "../src/utils/android-ui-dump";

type DumpCall = [string, string, { timeoutMs?: number }?];
const commandOf = (call: DumpCall) => call[1];
const timeoutOf = (call: DumpCall) => call[2]?.timeoutMs;

describe("dumpAndroidUiXml — the command every hierarchy read rides on", () => {
  beforeEach(() => adbExecOutBinary.mockClear());

  it("asks uiautomator for a --compressed dump", async () => {
    // `--compressed` drops the nodes `isImportantForAccessibility()` would skip
    // while keeping every text, content-desc, resource-id and focus/password
    // flag its callers read — a Bluesky thread dump goes 65 KB → 23 KB. Losing
    // it costs nothing visible in a test that stubs the reply, and everything on
    // a real device with a deep tree.
    await dumpAndroidUiXml("emulator-5554");

    expect(commandOf(adbExecOutBinary.mock.calls[0]!)).toMatch(/^uiautomator dump --compressed /);
  });

  it("reads over exec-out, to a file, and removes it even when the dump failed", async () => {
    // `adb shell 'uiautomator dump /dev/tty'` exits 0 and returns only a status
    // line, so a read taken that way parses an empty tree forever. The dump goes
    // to a per-call file rather than the shared /sdcard/window_dump.xml, so two
    // concurrent readers cannot read each other's write mid-flight, and the
    // trailing `;` (not `&&`) is what stops a refused dump leaking a file per
    // attempt.
    await dumpAndroidUiXml("emulator-5554");
    const command = commandOf(adbExecOutBinary.mock.calls[0]!);

    expect(adbExecOutBinary.mock.calls[0]![0]).toBe("emulator-5554");
    const path = command.match(/(\/data\/local\/tmp\/argent-ui-dump-[^\s]+\.xml)/)?.[1];
    expect(path).toBeDefined();
    expect(command).toBe(
      `uiautomator dump --compressed ${path} >/dev/null && cat ${path}; rm -f ${path}`
    );
  });

  it("gives each dump its own file, so concurrent reads cannot collide", async () => {
    await dumpAndroidUiXml("emulator-5554");
    await dumpAndroidUiXml("emulator-5554");

    const pathOf = (call: DumpCall) => commandOf(call).match(/argent-ui-dump-[^\s]+\.xml/)?.[0];
    expect(pathOf(adbExecOutBinary.mock.calls[0]!)).toBeDefined();
    expect(pathOf(adbExecOutBinary.mock.calls[0]!)).not.toBe(
      pathOf(adbExecOutBinary.mock.calls[1]!)
    );
  });

  it("passes the caller's budget through, and defaults to one of its own", async () => {
    // The clear hands it whatever is left of a shared deadline; `describe` takes
    // the default. A cold uiautomator on a busy emulator is slow either way.
    await dumpAndroidUiXml("emulator-5554");
    expect(timeoutOf(adbExecOutBinary.mock.calls[0]!)).toBe(20_000);

    await dumpAndroidUiXml("emulator-5554", { timeoutMs: 6_000 });
    expect(timeoutOf(adbExecOutBinary.mock.calls[1]!)).toBe(6_000);
  });

  it("returns the device's bytes as UTF-8", async () => {
    adbExecOutBinary.mockImplementationOnce(async () => Buffer.from("<hierarchy>é</hierarchy>"));

    await expect(dumpAndroidUiXml("emulator-5554")).resolves.toBe("<hierarchy>é</hierarchy>");
  });
});
