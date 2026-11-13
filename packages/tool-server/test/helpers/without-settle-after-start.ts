import type * as Xctrace from "../../src/tools/profiler/native-profiler/platforms/xctrace";

/**
 * A `vi.mock` or `vi.doMock` factory for the xctrace module: the module with no
 * wait after the recording starts, for tests about other parts of
 * native-profiler-start. That wait has its own tests (native-profiler-ios-start).
 */
export async function withoutSettleAfterStart(
  importOriginal: () => Promise<unknown>
): Promise<typeof Xctrace> {
  return {
    ...((await importOriginal()) as typeof Xctrace),
    settleAfterStart: async () => {},
  };
}
