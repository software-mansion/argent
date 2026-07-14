import { vi } from "vitest";

// Every flow run pins/restores the device status bar (src/tools/flows/flow-run.ts),
// and src/utils/status-bar shells out to real `xcrun simctl status_bar` / adb —
// even for the fake device ids unit tests use. Each call is ~1s uncontended and
// multiple seconds under the parallel suite load, which tripped a rotating set of
// per-test 5s timeouts across the flow tests. No unit test wants the real side
// effect, so stub the module suite-wide here instead of copy-pasting the mock
// into every flow test file.
//
// `pinStatusBar` resolves false ("nothing pinned") so flow-run never schedules a
// restore. Plain async functions (not vi.fn) so a test's resetAllMocks can never
// strip the implementation.
//
// test/status-bar.test.ts deliberately tests the real module (mocking at the
// child_process seam) and opts back in with vi.unmock.
vi.mock("../../src/utils/status-bar", () => ({
  pinStatusBar: async () => false,
  restoreStatusBar: async () => true,
}));
