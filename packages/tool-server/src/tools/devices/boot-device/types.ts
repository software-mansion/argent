export interface BootDeviceParams {
  udid?: string;
  avdName?: string;
  coldBoot?: boolean;
  noWindow?: boolean;
  bootTimeoutMs?: number;
}

export type BootDeviceResult =
  | { platform: "ios"; udid: string; booted: true }
  | { platform: "android"; serial: string; avdName: string; booted: true; coldBoot: boolean };

// Neither branch reads services from the registry — the iOS branch closes
// over `registry` and resolves native-devtools mid-handler (timing-sensitive,
// must come after `bootstatus`), and the Android branch shells out via adb.
export type BootDeviceServices = Record<string, never>;
