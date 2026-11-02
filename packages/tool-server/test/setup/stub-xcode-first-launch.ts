import { vi } from "vitest";

// Every `simctl` argv, `devicectl` call and `xcrun` preflight asks whether
// Xcode's component install is pending, which reads the host's real Xcode. On a
// Mac caught right after an Xcode update every iOS test would then fail with a
// refusal it never set up. Pin the answer to "installed" suite-wide.
//
// Tests of the refusal mock the module themselves with their own answer, and
// test/xcode-first-launch.test.ts opts back in to the real module with vi.unmock.
vi.mock("../../src/utils/xcode-first-launch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/xcode-first-launch")>()),
  xcodeFirstLaunchPending: () => false,
}));
