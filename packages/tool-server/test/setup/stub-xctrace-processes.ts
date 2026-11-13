import { vi } from "vitest";

// native-profiler-start on iOS and on a Mac app refuses while another
// `xctrace record` runs on the host, and lists the host's processes to find one.
// A unit test that starts a recording must not depend on what the host records
// at that time, so the list is empty suite-wide.
//
// A plain async function (not vi.fn), so a test's resetAllMocks cannot strip it.
// Tests of the refusal mock the module themselves, and
// test/xctrace-processes.test.ts opts back in to the real module with vi.unmock.
vi.mock("../../src/utils/ios-profiler/xctrace-processes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/ios-profiler/xctrace-processes")>()),
  runningXctraceRecordings: async () => [],
}));
