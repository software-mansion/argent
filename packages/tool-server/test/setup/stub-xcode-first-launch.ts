import { vi } from "vitest";

// The simulator watcher and list-devices ask whether Xcode's component install
// is pending, which reads the host's real Xcode. On a Mac caught right after an
// Xcode update, every test that expects them to call `simctl` would then fail.
// Pin the answer to "installed" suite-wide.
//
// Tests of the pending state mock the module themselves with their own answer,
// and test/xcode-first-launch.test.ts opts back in to the real module with
// vi.unmock.
vi.mock("../../src/utils/xcode-first-launch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/xcode-first-launch")>()),
  xcodeFirstLaunchPending: () => false,
}));
