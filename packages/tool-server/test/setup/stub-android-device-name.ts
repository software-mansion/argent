import { vi } from "vitest";

// A debugger connect whose device_id matches no Metro target reads the device's
// name through real `adb` when the id looks like an Android serial
// (src/utils/debugger/fallback-target.ts). The unit tests' fake ids ("mock-device",
// a serial another session's emulator holds) all look like one, and the real adb
// call outlived their 5 s timeouts under the parallel suite load. No unit test
// wants the real call, so stub the module suite-wide: "adb cannot read it".
//
// test/metro/fallback-target.test.ts sets its own answers;
// test/metro/android-device-name.test.ts tests the reader.
vi.mock("../../src/utils/debugger/android-device-name", () => ({
  androidDeviceNames: async () => undefined,
  otherAndroidDeviceOnline: async () => true,
}));
