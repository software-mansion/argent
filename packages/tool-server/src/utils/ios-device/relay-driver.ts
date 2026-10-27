import type { ChildProcess } from "node:child_process";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { IosRelay } from "./relay";

/**
 * What the tool-server asks of the tool that drives a relayed iPhone, the
 * calls devicectl and xcodebuild make for a phone on this Mac's USB. Two
 * tools implement it: go-ios (the default, a static binary) and
 * pymobiledevice3 (a Python package with a wider feature set). Both speak the
 * usbmuxd protocol to the relay endpoint and build the iOS 17+ tunnel in user
 * space, so neither needs root.
 */
export interface IosRelayDriver {
  readonly name: IosRelayDriverName;
  /** Bundle ids of the user apps installed on the phone. */
  installedBundleIds(relay: IosRelay): Promise<Set<string>>;
  installApp(relay: IosRelay, installablePath: string): Promise<void>;
  /** Missing apps count as success, matching the devicectl path. */
  uninstallApp(relay: IosRelay, bundleId: string): Promise<void>;
  launchApp(
    relay: IosRelay,
    bundleId: string,
    opts: { terminateExisting?: boolean; args?: string[] }
  ): Promise<void>;
  /**
   * Start the XCUITest runner, already installed, listening on `port`. The
   * child is the session: it ends when the runner does. Output goes to `logFd`.
   */
  launchRunner(
    relay: IosRelay,
    opts: { xctestrunPath: string; runnerBundleId: string; port: number; logFd: number }
  ): Promise<ChildProcess>;
  /** Does this `ps` line belong to a runner session this driver launched for `udid`? */
  isRunnerProcessLine(line: string, udid: string): boolean;
}

const IOS_RELAY_DRIVER_NAMES = ["go-ios", "pymobiledevice3"] as const;

export type IosRelayDriverName = (typeof IOS_RELAY_DRIVER_NAMES)[number];

/** Selects the driver for relayed iPhones. Unset means go-ios. */
const IOS_RELAY_DRIVER_ENV = "ARGENT_IOS_RELAY_DRIVER";

/**
 * The driver name the environment asks for. Exported for the test; the
 * driver itself is resolved lazily so the modules behind it load only when a
 * relayed phone is actually driven.
 */
export function iosRelayDriverName(env: NodeJS.ProcessEnv = process.env): IosRelayDriverName {
  const raw = env[IOS_RELAY_DRIVER_ENV]?.trim().toLowerCase();

  if (!raw) {
    return "go-ios";
  }

  if ((IOS_RELAY_DRIVER_NAMES as readonly string[]).includes(raw)) {
    return raw as IosRelayDriverName;
  }

  throw new FailureError(
    `${IOS_RELAY_DRIVER_ENV}=${JSON.stringify(raw)} names no relay driver; use one of ` +
      `${IOS_RELAY_DRIVER_NAMES.join(", ")}.`,
    {
      error_code: FAILURE_CODES.TOOL_INPUT_INVALID,
      failure_stage: "ios_relay_driver_select",
      failure_area: "tool_server",
      error_kind: "validation",
    }
  );
}

/** The driver for relayed iPhones, per the environment. */
export async function iosRelayDriver(): Promise<IosRelayDriver> {
  switch (iosRelayDriverName()) {
    case "pymobiledevice3":
      return (await import("./pymobiledevice3")).pymobiledevice3Driver;
    case "go-ios":
      return (await import("./go-ios")).goIosDriver;
  }
}
