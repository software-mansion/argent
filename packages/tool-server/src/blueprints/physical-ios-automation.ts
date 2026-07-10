import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { XCUITestDriver } from "appium-xcuitest-driver";
import {
  FAILURE_CODES,
  FailureError,
  TypedEventEmitter,
  type DeviceInfo,
  type ServiceBlueprint,
  type ServiceEvents,
  type ServiceInstance,
} from "@argent/registry";
import { assertPhysicalIosEnabled } from "./core-device";

const execFileAsync = promisify(execFile);

export const PHYSICAL_IOS_AUTOMATION_NAMESPACE = "PhysicalIosAutomation";

type PhysicalIosAutomationFactoryOptions = Record<string, unknown> & { device: DeviceInfo };

export interface PhysicalIosTouchEvent {
  type: "Down" | "Move" | "Up";
  x: number;
  y: number;
  x2?: number;
  y2?: number;
  delayMs?: number;
}

export interface PhysicalIosLogEntry {
  timestamp: number;
  level: string;
  message: string;
}

export interface PhysicalIosAutomationApi {
  screenshot(): Promise<{ path: string }>;
  source(): Promise<string>;
  windowSize(): Promise<{ width: number; height: number }>;
  tap(x: number, y: number): Promise<void>;
  swipe(fromX: number, fromY: number, toX: number, toY: number, durationMs: number): Promise<void>;
  touch(events: PhysicalIosTouchEvent[]): Promise<void>;
  button(name: "home" | "power" | "volumeUp" | "volumeDown" | "actionButton"): Promise<void>;
  typeText(text: string, delayMs?: number): Promise<void>;
  pasteText(text: string): Promise<void>;
  pressKey(key: string): Promise<void>;
  rotate(orientation: "Portrait" | "LandscapeLeft" | "LandscapeRight" | "PortraitUpsideDown"): Promise<void>;
  launchApp(bundleId: string): Promise<void>;
  openUrl(url: string, bundleId?: string): Promise<void>;
  terminateApp(bundleId: string): Promise<boolean>;
  activeApp(): Promise<{ bundleId: string; pid: number; name?: string }>;
  drainLogs(): Promise<PhysicalIosLogEntry[]>;
  /** Wait until every previously registered control has completed on-device. */
  flushControls(): Promise<void>;
}

export function physicalIosAutomationRef(device: DeviceInfo): {
  urn: string;
  options: PhysicalIosAutomationFactoryOptions;
} {
  return {
    urn: `${PHYSICAL_IOS_AUTOMATION_NAMESPACE}:${device.id}`,
    options: { device },
  };
}

interface DeviceDetails {
  name: string;
  osVersion: string;
}

interface WdaBuild {
  bundleId: string;
  derivedDataPath: string;
  teamId: string;
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

// The simulator-server sends one IPC message per touch point. Across idle and
// concurrently-profiled runs this contributes roughly 0.7–1.8 ms per point on
// top of the 16 ms frame cadence. The midpoint keeps physical registration
// within 5% in both conditions while XCTest work continues in-order behind the
// queue.
const SIMULATOR_IPC_POINT_MS = 1.2;

function simulatorGestureCadenceMs(durationMs: number): number {
  const steps = Math.max(1, Math.round(durationMs / 16));
  return steps * 16 + (steps + 1) * SIMULATOR_IPC_POINT_MS;
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function failure(
  message: string,
  code: (typeof FAILURE_CODES)[keyof typeof FAILURE_CODES],
  stage: string,
  cause?: unknown
): FailureError {
  return new FailureError(
    message,
    {
      error_code: code,
      failure_stage: stage,
      failure_area: "tool_server",
      error_kind: "subprocess",
    },
    cause == null ? undefined : { cause: cause instanceof Error ? cause : new Error(String(cause)) }
  );
}

async function physicalDeviceDetails(udid: string): Promise<DeviceDetails> {
  const outputPath = join(tmpdir(), `argent-ios-details-${randomUUID()}.json`);
  try {
    await execFileAsync(
      "xcrun",
      [
        "devicectl",
        "device",
        "info",
        "details",
        "--device",
        udid,
        "--quiet",
        "--json-output",
        outputPath,
      ],
      { timeout: 30_000 }
    );
    const parsed = JSON.parse(await readFile(outputPath, "utf8")) as {
      result?: {
        deviceProperties?: { name?: string; osVersionNumber?: string };
      };
    };
    const props = parsed.result?.deviceProperties;
    if (!props?.osVersionNumber) throw new Error("devicectl omitted the iOS version");
    return { name: props.name ?? "iPhone", osVersion: props.osVersionNumber };
  } catch (error) {
    throw failure(
      `Could not read details for physical iOS device ${udid}. Ensure it is connected, unlocked, trusted, and has Developer Mode enabled.`,
      FAILURE_CODES.PHYSICAL_IOS_AUTOMATION_DEVICE_DETAILS_FAILED,
      "physical_ios_device_details",
      error
    );
  } finally {
    await rm(outputPath, { force: true }).catch(() => {});
  }
}

async function discoverSigningTeams(): Promise<string[]> {
  if (process.env.ARGENT_WDA_TEAM_ID) return [process.env.ARGENT_WDA_TEAM_ID];
  try {
    const { stdout } = await execFileAsync(
      "defaults",
      ["read", "com.apple.dt.Xcode", "IDEProvisioningTeamByIdentifier"],
      { timeout: 10_000 }
    );
    const teams = [...stdout.matchAll(/teamID\s*=\s*([A-Z0-9]+);/g)].map((match) => match[1]!);
    return [...new Set(teams)];
  } catch {
    return [];
  }
}

function webdriverAgentPaths(): { projectPath: string; version: string } {
  const driverPackagePath = require.resolve("appium-xcuitest-driver/package.json");
  const driverDir = dirname(driverPackagePath);
  const wdaPackagePath = require.resolve("appium-webdriveragent/package.json", {
    paths: [driverDir],
  });
  const wdaPackage = require(wdaPackagePath) as { version?: string };
  return {
    projectPath: join(dirname(wdaPackagePath), "WebDriverAgent.xcodeproj"),
    version: wdaPackage.version ?? "unknown",
  };
}

function appPathForDerivedData(derivedDataPath: string): string {
  return join(
    derivedDataPath,
    "Build",
    "Products",
    "Debug-iphoneos",
    "WebDriverAgentRunner-Runner.app"
  );
}

async function verifySignedApp(appPath: string): Promise<boolean> {
  if (!existsSync(appPath)) return false;
  try {
    await execFileAsync("codesign", ["--verify", "--deep", "--strict", appPath], {
      timeout: 30_000,
    });
    return true;
  } catch {
    return false;
  }
}

async function signingIdentityForTeam(teamId: string): Promise<string> {
  if (process.env.ARGENT_WDA_SIGNING_ID) return process.env.ARGENT_WDA_SIGNING_ID;
  const { stdout } = await execFileAsync(
    "security",
    ["find-certificate", "-a", "-Z", join(homedir(), "Library/Keychains/login.keychain-db")],
    { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }
  );
  const matches: string[] = [];
  for (const block of stdout.split(/(?=SHA-256 hash:)/)) {
    if (!block.includes(teamId) || !block.includes("Apple Development:")) continue;
    const sha1 = /^SHA-1 hash:\s*([A-F0-9]{40})$/m.exec(block)?.[1];
    if (sha1) matches.push(sha1);
  }
  // Keychain may contain two certificates with the same display name. The
  // most recently returned matching identity is the one Xcode currently uses;
  // passing its SHA-1 avoids both the name ambiguity and a stale private-key
  // access prompt from an older duplicate.
  if (matches.length > 0) return matches[matches.length - 1]!;
  throw new Error(
    `no Apple Development certificate with a private key was found for team ${teamId}`
  );
}

async function buildAndResignWda(
  udid: string,
  osVersion: string,
  teamId: string,
  bundleId: string,
  derivedDataPath: string,
  projectPath: string
): Promise<void> {
  await mkdir(derivedDataPath, { recursive: true });
  const identity = await signingIdentityForTeam(teamId);
  await execFileAsync(
    "xcodebuild",
    [
      "build-for-testing",
      "-allowProvisioningUpdates",
      "-allowProvisioningDeviceRegistration",
      "-project",
      projectPath,
      "-scheme",
      "WebDriverAgentRunner",
      "-destination",
      `id=${udid}`,
      "-derivedDataPath",
      derivedDataPath,
      `IPHONEOS_DEPLOYMENT_TARGET=${osVersion}`,
      `DEVELOPMENT_TEAM=${teamId}`,
      "CODE_SIGN_IDENTITY=Apple Development",
      `EXPANDED_CODE_SIGN_IDENTITY=${identity}`,
      `PRODUCT_BUNDLE_IDENTIFIER=${bundleId}`,
      "GCC_TREAT_WARNINGS_AS_ERRORS=0",
      "COMPILER_INDEX_STORE_ENABLE=NO",
    ],
    { timeout: 10 * 60_000, maxBuffer: 64 * 1024 * 1024 }
  );

  const appPath = appPathForDerivedData(derivedDataPath);
  if (!existsSync(appPath)) throw new Error(`xcodebuild did not produce ${appPath}`);

  // Xcode 26 can leave the generated XCTest runner wrapper with an invalid
  // top-level signature even though its nested .xctest is valid. Physical iOS
  // rejects that wrapper with 0xe8008001. Removing provenance xattrs and
  // re-signing the complete runner with the identity Xcode selected makes the
  // result installable while preserving its identifiers and entitlements.
  await execFileAsync("xattr", ["-cr", appPath], { timeout: 30_000 });
  await execFileAsync(
    "codesign",
    [
      "--force",
      "--deep",
      "--sign",
      identity,
      "--preserve-metadata=identifier,entitlements,requirements,flags,runtime",
      appPath,
    ],
    { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }
  );
  await execFileAsync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], {
    timeout: 30_000,
  });
}

async function prepareWda(udid: string, details: DeviceDetails): Promise<WdaBuild> {
  const teams = await discoverSigningTeams();
  if (teams.length === 0) {
    throw failure(
      "No Apple development team is configured in Xcode. Add an Apple Account in Xcode Settings → Accounts, or set ARGENT_WDA_TEAM_ID.",
      FAILURE_CODES.PHYSICAL_IOS_AUTOMATION_SIGNING_TEAM_NOT_FOUND,
      "physical_ios_wda_signing_team"
    );
  }

  const { projectPath, version } = webdriverAgentPaths();
  const configuredBundleId = process.env.ARGENT_WDA_BUNDLE_ID;
  const failures: string[] = [];

  for (const teamId of teams) {
    const bundleId = configuredBundleId ?? `dev.argent.WebDriverAgentRunner.${teamId.toLowerCase()}`;
    const cacheKey = createHash("sha256")
      .update(`${version}:${teamId}:${bundleId}:${details.osVersion}`)
      .digest("hex")
      .slice(0, 16);
    const derivedDataPath = join(
      homedir(),
      ".argent",
      "webdriveragent",
      safeSegment(version),
      cacheKey
    );
    const appPath = appPathForDerivedData(derivedDataPath);

    if (await verifySignedApp(appPath)) return { bundleId, derivedDataPath, teamId };

    try {
      await buildAndResignWda(
        udid,
        details.osVersion,
        teamId,
        bundleId,
        derivedDataPath,
        projectPath
      );
      return { bundleId, derivedDataPath, teamId };
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? String(error);
      failures.push(`${teamId}: ${stderr.split("\n").slice(-8).join(" ").trim()}`);
      if (configuredBundleId || process.env.ARGENT_WDA_TEAM_ID) break;
    }
  }

  throw failure(
    `WebDriverAgent could not be built and signed for ${details.name}. ` +
      `Set ARGENT_WDA_TEAM_ID and, if your team requires an explicit App ID, ARGENT_WDA_BUNDLE_ID.\n` +
      failures.join("\n"),
    FAILURE_CODES.PHYSICAL_IOS_AUTOMATION_WDA_BUILD_FAILED,
    "physical_ios_wda_build"
  );
}

function pointerActions(
  id: string,
  points: Array<{ x: number; y: number; duration?: number }>,
  holdMs = 0
): Record<string, unknown> {
  const actions: Array<Record<string, unknown>> = [
    { type: "pointerMove", duration: 0, x: points[0]!.x, y: points[0]!.y, origin: "viewport" },
    { type: "pointerDown", button: 0 },
  ];
  if (holdMs > 0) actions.push({ type: "pause", duration: holdMs });
  for (const point of points.slice(1)) {
    actions.push({
      type: "pointerMove",
      duration: point.duration ?? 0,
      x: point.x,
      y: point.y,
      origin: "viewport",
    });
  }
  actions.push({ type: "pointerUp", button: 0 });
  return { type: "pointer", id, parameters: { pointerType: "touch" }, actions };
}

function customTouchActions(
  events: PhysicalIosTouchEvent[],
  width: number,
  height: number
): Array<Record<string, unknown>> {
  const hasSecondPointer = events.some((event) => event.x2 != null && event.y2 != null);
  const first: Array<Record<string, unknown>> = [];
  const second: Array<Record<string, unknown>> = [];

  const appendBoth = (a: Record<string, unknown>, b: Record<string, unknown>) => {
    first.push(a);
    if (hasSecondPointer) second.push(b);
  };

  for (const [index, event] of events.entries()) {
    // WDA requires every pointer sequence to start with pointerMove. A delay
    // before the first Down is therefore meaningless (the finger is not on the
    // screen yet) and invalid in XCTest's action parser; delays before later
    // events preserve Argent's gesture-custom semantics.
    const duration = index === 0 ? 0 : Math.max(0, event.delayMs ?? 16);
    const p1 = {
      type: "pointerMove",
      duration,
      x: clampUnit(event.x) * width,
      y: clampUnit(event.y) * height,
      origin: "viewport",
    };
    const p2 =
      event.x2 != null && event.y2 != null
          ? {
            type: "pointerMove",
            duration,
            x: clampUnit(event.x2) * width,
            y: clampUnit(event.y2) * height,
            origin: "viewport",
          }
        : { type: "pause", duration };
    appendBoth(p1, p2);

    const operation =
      event.type === "Down"
        ? { type: "pointerDown", button: 0 }
        : event.type === "Up"
          ? { type: "pointerUp", button: 0 }
          : { type: "pause", duration: 0 };
    appendBoth(operation, event.x2 != null && event.y2 != null ? { ...operation } : { type: "pause", duration: 0 });
  }

  const result: Array<Record<string, unknown>> = [
    { type: "pointer", id: "finger1", parameters: { pointerType: "touch" }, actions: first },
  ];
  if (hasSecondPointer) {
    result.push({
      type: "pointer",
      id: "finger2",
      parameters: { pointerType: "touch" },
      actions: second,
    });
  }
  return result;
}

function pointSegmentDistance(
  point: readonly number[],
  start: readonly number[],
  end: readonly number[]
): number {
  let lengthSquared = 0;
  let dot = 0;
  for (let i = 0; i < point.length; i++) {
    const delta = end[i]! - start[i]!;
    lengthSquared += delta * delta;
    dot += (point[i]! - start[i]!) * delta;
  }
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, dot / lengthSquared));
  let distanceSquared = 0;
  for (let i = 0; i < point.length; i++) {
    const delta = point[i]! - (start[i]! + (end[i]! - start[i]!) * t);
    distanceSquared += delta * delta;
  }
  return Math.sqrt(distanceSquared);
}

function touchPoint(event: PhysicalIosTouchEvent, twoFinger: boolean): number[] {
  return twoFinger
    ? [event.x, event.y, event.x2 ?? event.x, event.y2 ?? event.y]
    : [event.x, event.y];
}

/**
 * XCTest's synthesized-event setup cost grows with every path vertex. Argent's
 * simulator backend emits one point per ~16 ms, but XCTest already interpolates
 * between timed pointer moves. Remove redundant collinear vertices while
 * retaining curves, explicit contact boundaries, and the original total time.
 */
export function compactPhysicalTouchEvents(
  events: PhysicalIosTouchEvent[],
  epsilon = 0.002
): PhysicalIosTouchEvent[] {
  if (
    events.length <= 2 ||
    events[0]?.type !== "Down" ||
    events.at(-1)?.type !== "Up" ||
    events.slice(1, -1).some((event) => event.type !== "Move")
  ) {
    return events;
  }

  const twoFinger = events.some((event) => event.x2 != null && event.y2 != null);
  if (
    twoFinger &&
    events.some((event) => event.x2 == null || event.y2 == null)
  ) {
    return events;
  }

  const kept = new Set<number>([0, events.length - 1]);
  const visit = (startIndex: number, endIndex: number): void => {
    const start = touchPoint(events[startIndex]!, twoFinger);
    const end = touchPoint(events[endIndex]!, twoFinger);
    let maxDistance = epsilon;
    let maxIndex = -1;
    for (let i = startIndex + 1; i < endIndex; i++) {
      const distance = pointSegmentDistance(touchPoint(events[i]!, twoFinger), start, end);
      if (distance > maxDistance) {
        maxDistance = distance;
        maxIndex = i;
      }
    }
    if (maxIndex === -1) return;
    kept.add(maxIndex);
    visit(startIndex, maxIndex);
    visit(maxIndex, endIndex);
  };
  visit(0, events.length - 1);

  const indices = [...kept].sort((a, b) => a - b);
  return indices.map((index, position) => {
    if (position === 0) return { ...events[index]! };
    const previousIndex = indices[position - 1]!;
    let delayMs = 0;
    for (let i = previousIndex + 1; i <= index; i++) {
      delayMs += Math.max(0, events[i]!.delayMs ?? 16);
    }
    return { ...events[index]!, delayMs };
  });
}

const KEY_NAMES: Record<string, string> = {
  enter: "\r",
  escape: "XCUIKeyboardKeyEscape",
  backspace: "XCUIKeyboardKeyDelete",
  tab: "XCUIKeyboardKeyTab",
  space: " ",
  "arrow-up": "XCUIKeyboardKeyUpArrow",
  "arrow-down": "XCUIKeyboardKeyDownArrow",
  "arrow-left": "XCUIKeyboardKeyLeftArrow",
  "arrow-right": "XCUIKeyboardKeyRightArrow",
};

export const physicalIosAutomationBlueprint: ServiceBlueprint<
  PhysicalIosAutomationApi,
  DeviceInfo
> = {
  namespace: PHYSICAL_IOS_AUTOMATION_NAMESPACE,
  getURN(device) {
    return `${PHYSICAL_IOS_AUTOMATION_NAMESPACE}:${device.id}`;
  },
  recoverable(error) {
    const message = error instanceof Error ? error.message : String(error);
    return /ECONNREFUSED|socket hang up|WebDriverAgent is not reachable/i.test(message);
  },
  async factory(_deps, _payload, options) {
    const opts = options as PhysicalIosAutomationFactoryOptions | undefined;
    const device = opts?.device;
    if (!device?.id) {
      throw failure(
        `${PHYSICAL_IOS_AUTOMATION_NAMESPACE}.factory requires options.device.`,
        FAILURE_CODES.PHYSICAL_IOS_AUTOMATION_FACTORY_OPTIONS_MISSING,
        "physical_ios_automation_factory_options"
      );
    }
    if (device.platform !== "ios" || device.kind !== "device") {
      throw failure(
        `${PHYSICAL_IOS_AUTOMATION_NAMESPACE} only drives physical iOS devices; got ${device.platform}/${device.kind}.`,
        FAILURE_CODES.PHYSICAL_IOS_AUTOMATION_WRONG_DEVICE,
        "physical_ios_automation_factory_platform"
      );
    }
    assertPhysicalIosEnabled();

    const details = await physicalDeviceDetails(device.id);
    const wdaBuild = await prepareWda(device.id, details);
    const driver = new XCUITestDriver({} as never);
    const caps = {
      alwaysMatch: {
        platformName: "iOS",
        "appium:automationName": "XCUITest",
        "appium:udid": device.id,
        "appium:deviceName": details.name,
        "appium:platformVersion": details.osVersion,
        "appium:noReset": true,
        "appium:useNewWDA": false,
        "appium:usePrebuiltWDA": true,
        "appium:derivedDataPath": wdaBuild.derivedDataPath,
        "appium:updatedWDABundleId": wdaBuild.bundleId,
        "appium:xcodeOrgId": wdaBuild.teamId,
        "appium:xcodeSigningId": process.env.ARGENT_WDA_SIGNING_ID ?? "Apple Development",
        "appium:wdaLaunchTimeout": 240_000,
        "appium:wdaConnectionTimeout": 240_000,
        "appium:showXcodeLog": process.env.ARGENT_WDA_SHOW_XCODE_LOG === "1",
        "appium:waitForIdleTimeout": 0,
        "appium:useJSONSource": false,
      },
      firstMatch: [{}],
    };

    try {
      await (driver.createSession as unknown as (...args: unknown[]) => Promise<unknown>)(
        null,
        null,
        caps
      );
      // WDA otherwise waits up to two seconds for Maps' continuously animating
      // render tree to become stable after every action. Input has already been
      // synthesized at this point, so this wait only inflates acknowledgement
      // latency and is inappropriate for an agent-control transport.
      await driver.updateSettings({ animationCoolOffTimeout: 0 });
    } catch (error) {
      throw failure(
        `WebDriverAgent could not start on ${details.name} (${device.id}). Keep the phone unlocked and trust the developer certificate if iOS prompts for it.`,
        FAILURE_CODES.PHYSICAL_IOS_AUTOMATION_WDA_SESSION_FAILED,
        "physical_ios_wda_session",
        error
      );
    }

    let queue: Promise<void> = Promise.resolve();
    let queuedFailure: FailureError | null = null;
    const commandFailure = (label: string, error: unknown): FailureError =>
      error instanceof FailureError
        ? error
        : failure(
            `Physical iOS ${label} failed on ${details.name}: ${error instanceof Error ? error.message : String(error)}`,
            FAILURE_CODES.PHYSICAL_IOS_AUTOMATION_COMMAND_FAILED,
            `physical_ios_${label}`,
            error
          );

    const serialized = async <T>(label: string, operation: () => Promise<T>): Promise<T> => {
      const run = queue.then(async () => {
        if (queuedFailure) {
          const error = queuedFailure;
          queuedFailure = null;
          throw error;
        }
        return operation();
      });
      queue = run.then(
        () => undefined,
        () => undefined
      );
      try {
        return await run;
      } catch (error) {
        throw commandFailure(label, error);
      }
    };

    /**
     * Register a control without waiting for XCTest's response bookkeeping.
     * The queue still preserves strict device order. Acknowledgement is paced
     * to the gesture's own duration, matching the simulator backend (which
     * sleeps while emitting its 60 fps points) to within scheduling jitter.
     * Read operations and capture stop calls use flushControls as a barrier and
     * surface any deferred WDA error.
     */
    const enqueueControl = async (
      label: string,
      operation: () => Promise<unknown>,
      acknowledgeDelayMs = 0
    ): Promise<void> => {
      if (queuedFailure) {
        const error = queuedFailure;
        queuedFailure = null;
        throw error;
      }
      const run = queue.then(operation);
      queue = run.then(
        () => undefined,
        (error) => {
          queuedFailure = commandFailure(label, error);
        }
      );
      if (acknowledgeDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, acknowledgeDelayMs));
      }
    };

    let cachedDimensions: { width: number; height: number } | null = await driver.getWindowSize();
    const dimensions = async () => {
      if (cachedDimensions) return cachedDimensions;
      cachedDimensions = await serialized("window_size", () => driver.getWindowSize());
      return cachedDimensions;
    };
    const api: PhysicalIosAutomationApi = {
      async screenshot() {
        return serialized("screenshot", async () => {
          const base64 = await driver.getScreenshot();
          const path = join(tmpdir(), `argent-physical-ios-${randomUUID()}.png`);
          await writeFile(path, Buffer.from(base64, "base64"));
          return { path };
        });
      },
      source: () => serialized("source", () => driver.getPageSource()),
      windowSize: dimensions,
      async tap(x, y) {
        const size = await dimensions();
        await enqueueControl(
          "tap",
          () => driver.mobileTap(clampUnit(x) * size.width, clampUnit(y) * size.height),
          52
        );
      },
      async swipe(fromX, fromY, toX, toY, durationMs) {
        const size = await dimensions();
        await enqueueControl(
          "swipe",
          () =>
            driver.performActions([
              pointerActions("finger1", [
                { x: clampUnit(fromX) * size.width, y: clampUnit(fromY) * size.height },
                {
                  x: clampUnit(toX) * size.width,
                  y: clampUnit(toY) * size.height,
                  duration: Math.max(50, durationMs),
                },
              ]),
            ] as never),
          simulatorGestureCadenceMs(durationMs)
        );
      },
      async touch(events) {
        if (events.length === 0) return;
        const size = await dimensions();
        const compacted = compactPhysicalTouchEvents(events);
        const durationMs = events.reduce(
          (sum, event) => sum + Math.max(0, event.delayMs ?? 16),
          0
        ) + events.length * SIMULATOR_IPC_POINT_MS;
        await enqueueControl(
          "touch",
          () =>
            driver.performActions(customTouchActions(compacted, size.width, size.height) as never),
          durationMs
        );
      },
      async button(name) {
        await enqueueControl("button", async () => {
          if (name === "power") {
            await driver.lock();
            return;
          }
          const mapped =
            name === "volumeUp"
              ? "volumeup"
              : name === "volumeDown"
                ? "volumedown"
                : name === "actionButton"
                  ? "action"
                  : "home";
          await driver.proxyCommand("/wda/pressButton", "POST", { name: mapped });
        });
      },
      async typeText(text, delayMs) {
        const simulatorDelayMs = delayMs ?? 50;
        await enqueueControl(
          "keyboard",
          async () => {
            if (delayMs && delayMs > 0) {
              for (const char of text) {
                await driver.keys(char);
                await new Promise((resolve) => setTimeout(resolve, delayMs));
              }
            } else {
              await driver.keys(text);
            }
          },
          text.length * simulatorDelayMs * 2
        );
      },
      async pressKey(key) {
        const mapped = KEY_NAMES[key] ?? (/^f(?:[1-9]|1[0-2])$/i.test(key) ? `XCUIKeyboardKey${key.toUpperCase()}` : undefined);
        if (!mapped) throw new Error(`Unsupported physical iOS key: ${key}`);
        await enqueueControl("keyboard_key", () => driver.mobileKeys([mapped]), 50);
      },
      async pasteText(text) {
        await enqueueControl("paste", () => driver.keys(text));
      },
      async rotate(orientation) {
        const mapped = orientation.startsWith("Landscape") ? "LANDSCAPE" : "PORTRAIT";
        await enqueueControl("rotate", () =>
          driver.proxyCommand("/orientation", "POST", { orientation: mapped })
        );
      },
      launchApp: (bundleId) => serialized("launch_app", () => driver.mobileLaunchApp(bundleId)),
      openUrl: (url, bundleId) =>
        enqueueControl("open_url", () => driver.mobileDeepLink(url, bundleId)),
      terminateApp: (bundleId) => serialized("terminate_app", () => driver.mobileTerminateApp(bundleId)),
      async activeApp() {
        return serialized("active_app", async () => {
          const app = await driver.mobileGetActiveAppInfo();
          return { bundleId: app.bundleId, pid: app.pid, name: app.name || undefined };
        });
      },
      drainLogs: () => serialized("device_logs", () => driver.extractLogs("syslog")),
      flushControls: () => serialized("control_flush", async () => {}),
    };

    const events = new TypedEventEmitter<ServiceEvents>();
    const instance: ServiceInstance<PhysicalIosAutomationApi> = {
      api,
      events,
      async dispose() {
        await Promise.race([
          queue,
          new Promise<void>((resolve) => setTimeout(resolve, 30_000)),
        ]).catch(() => {});
        await driver.wda.xcodebuild.quit().catch(() => {});
        const cleanup = driver.deleteSession().catch(() => {});
        await Promise.race([cleanup, new Promise((resolve) => setTimeout(resolve, 5_000))]);
      },
    };
    return instance;
  },
};
