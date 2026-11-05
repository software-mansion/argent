import { vi } from "vitest";

// Every `simctl` and `devicectl` call site asks whether Xcode's component install
// is pending, which reads the host's real Xcode. Pin the answer to "installed"
// suite-wide, so a test that expects such a call gets the same answer on any host.
//
// This does not protect a Mac with a pending Xcode: a test that reaches the real
// wrapper still starts the install. list-devices-harmony and harmony-flag-gate
// call the real `xcrun devicectl`.
//
// Tests of the pending state mock the module themselves with their own answer,
// and test/xcode-first-launch.test.ts opts back in to the real module with
// vi.unmock.
vi.mock("../../src/utils/xcode-first-launch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/xcode-first-launch")>()),
  xcodeFirstLaunchPending: () => false,
}));
