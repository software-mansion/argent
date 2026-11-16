import { vi } from "vitest";

// A native profiler start and react-profiler-stop delete the saved sessions in
// `<os.tmpdir()>/argent-profiler-cwd` that no tool used for 3 days
// (src/utils/profiler-shared/session-retention.ts). Several suites reach a start
// with the real os.tmpdir(), so on a developer's machine a run deleted the old
// sessions of the real folder. No unit test wants that side effect, so stub the
// cleanup suite-wide. test/profiler-session-retention.test.ts tests the real
// module and opts back in with vi.unmock.
vi.mock("../../src/utils/profiler-shared/session-retention", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  startOldProfilerSessionCleanup: () => {},
}));
