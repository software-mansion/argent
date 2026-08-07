import { execFile } from "node:child_process";
import { z } from "zod";
import {
  FAILURE_CODES,
  FailureError,
  subprocessFailureMetadata,
  type ToolCapability,
  type ToolDefinition,
} from "@argent/registry";
import { assertSupported, InvalidToolInputError } from "../../utils/capability";
import { resolveDevice } from "../../utils/device-info";

// `simctl push` rejects payloads over this size (documented in its usage text),
// with an error that doesn't name the offending byte count — so the limit is
// enforced here first with a message that does.
const APNS_MAX_PAYLOAD_BYTES = 4096;

const SIMCTL_TIMEOUT_MS = 30_000;

const zodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe("Target iOS simulator UDID from `list-devices` — push-notification is iOS-only."),
  bundleId: z
    .string()
    .min(1)
    .describe(
      "Bundle id of the installed app that receives the notification (e.g. com.example.app)."
    ),
  title: z
    .string()
    .optional()
    .describe("Notification title. Provide title and/or body unless `payload` is used."),
  body: z.string().optional().describe("Notification body text."),
  subtitle: z.string().optional().describe("Optional subtitle shown under the title."),
  badge: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("App-icon badge count to set with the notification (0 clears the badge)."),
  sound: z
    .string()
    .optional()
    .describe('Notification sound, e.g. "default". Omitted = silent banner.'),
  payload: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Raw APNS payload object, delivered verbatim — full control for silent pushes " +
        "(aps.content-available), custom data keys, etc. Must contain an `aps` key, e.g. " +
        '{"aps":{"alert":{"title":"Hi","body":"There"}},"customKey":1}. ' +
        "Mutually exclusive with title/body/subtitle/badge/sound."
    ),
});

type Params = z.infer<typeof zodSchema>;

interface Result {
  delivered: boolean;
  bundleId: string;
  payloadBytes: number;
}

// Capability gate (HTTP layer + the assertSupported call inside execute)
// rejects every non-iOS-simulator target. `simctl push` only exists for local
// simulators: physical devices need a real APNS server, and sim-remote has no
// push verb yet, so appleRemote is deliberately absent.
const capability: ToolCapability = {
  apple: { simulator: true },
};

// InvalidToolInputError (not FailureError) so the HTTP layer maps these to
// 400 like the zod-validation path — client input errors, not server faults.
// The granular error_code keeps its own telemetry bucket.
function payloadInvalid(message: string): InvalidToolInputError {
  return new InvalidToolInputError(message, {
    error_code: FAILURE_CODES.IOS_PUSH_PAYLOAD_INVALID,
    failure_stage: "ios_push_validate_payload",
  });
}

// Callback-style execFile wrapped by hand (not promisify) because the push
// call must write the payload to simctl's stdin — promisify(execFile) hides
// the ChildProcess behind a custom symbol that mocks don't carry.
function runXcrun(
  args: string[],
  stdinPayload?: string
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile("xcrun", args, { timeout: SIMCTL_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) {
        // instanceof narrow: ExecFileException's typing hides its Error base
        // behind an Omit<>, which the prefer-promise-reject-errors rule can't
        // see through. At runtime err is always an Error.
        const failure = err instanceof Error ? err : new Error(JSON.stringify(err));
        Object.assign(failure, { stdout: String(stdout), stderr: String(stderr) });
        reject(failure);
      } else {
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      }
    });
    if (stdinPayload !== undefined && child?.stdin) {
      // If simctl exits before reading stdin (bad udid, instant failure), the
      // write EPIPEs — without a listener that's an uncaught stream 'error'
      // that would take down the whole tool-server. The exit failure itself
      // still arrives through the execFile callback.
      child.stdin.on("error", () => {});
      child.stdin.write(stdinPayload);
      child.stdin.end();
    }
  });
}

/**
 * Whether `bundleId` is installed on `udid`, when the probe can tell: `true`
 * installed, `false` definitively not installed, `undefined` when the probe
 * couldn't answer (e.g. a shutdown simulator, where `get_app_container` fails
 * for installed and missing apps alike). Only a definitive `false` rejects the
 * push up front — anything else falls through so `simctl push` surfaces the
 * real cause (e.g. the boot-device hint). Mirrors the settings-permissions
 * install probe.
 */
async function isInstalled(udid: string, bundleId: string): Promise<boolean | undefined> {
  try {
    // Exits 0 and prints the container path for an installed app.
    await runXcrun(["simctl", "get_app_container", udid, bundleId]);
    return true;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (/no such file or directory|is not installed/i.test(detail)) return false;
    return undefined;
  }
}

export const pushNotificationTool: ToolDefinition<Params, Result> = {
  id: "push-notification",
  description: `Deliver a simulated push notification to an app on the iOS simulator — no APNS server, device token, or signing required.
Pass title and/or body (plus optional subtitle/badge/sound) for a standard alert banner, OR a raw \`payload\` object for full APNS control (silent pushes via aps.content-available, custom data keys); a raw payload must contain an \`aps\` key and fit in 4096 bytes.
The app must be installed and must have notification permission — if it has never shown its permission dialog, launch it and accept the dialog first, or iOS delivers the push without any visible banner. An app in the foreground may present the banner differently or suppress it; send the app to the background (button home) first for a classic banner.
Returns { delivered, bundleId, payloadBytes }. The delivered banner is a normal UI element: wait for it with await-ui-element (condition visible, text from the title), read its frame with describe, and tap it to open the app.
iOS simulators only — physical devices, Android, and remote simulators are not supported.`,
  zodSchema,
  capability,
  requires: ["xcrun"],
  searchHint:
    "push notification apns simulate send deliver banner alert badge sound remote notification simctl",
  services: () => ({}),
  async execute(_services, params) {
    const { udid, bundleId, title, body, subtitle, badge, sound, payload } = params;
    const device = resolveDevice(udid);
    // The HTTP edge asserts capability too, but internal callers (flows,
    // run-sequence-style dispatch) reach execute directly — assert here so an
    // Android serial can't slip through to a bogus simctl call.
    assertSupported("push-notification", capability, device);

    const sugarUsed =
      title !== undefined ||
      body !== undefined ||
      subtitle !== undefined ||
      badge !== undefined ||
      sound !== undefined;

    if (payload && sugarUsed) {
      throw payloadInvalid(
        "Provide either a raw `payload` object OR the title/body/subtitle/badge/sound fields, not both — " +
          "a raw payload is delivered verbatim, so the convenience fields would be silently ignored."
      );
    }
    if (!payload && title === undefined && body === undefined) {
      throw payloadInvalid(
        "Nothing to deliver: provide `title` and/or `body` for a standard banner, or a raw `payload` object."
      );
    }

    let apnsPayload: Record<string, unknown>;
    if (payload) {
      if (!("aps" in payload)) {
        throw payloadInvalid(
          "Raw push payload must contain a top-level `aps` key (Apple Push Notification Service envelope) — " +
            'e.g. {"aps":{"alert":{"title":"Hi","body":"There"}}}. `simctl push` rejects payloads without it.'
        );
      }
      apnsPayload = payload;
    } else {
      const alert: Record<string, unknown> = {};
      if (title !== undefined) alert.title = title;
      if (subtitle !== undefined) alert.subtitle = subtitle;
      if (body !== undefined) alert.body = body;
      const aps: Record<string, unknown> = { alert };
      if (badge !== undefined) aps.badge = badge;
      if (sound !== undefined) aps.sound = sound;
      apnsPayload = { aps };
    }

    const json = JSON.stringify(apnsPayload);
    const payloadBytes = Buffer.byteLength(json, "utf8");
    if (payloadBytes > APNS_MAX_PAYLOAD_BYTES) {
      throw payloadInvalid(
        `Push payload is ${payloadBytes} bytes; \`simctl push\` caps payloads at ${APNS_MAX_PAYLOAD_BYTES} bytes ` +
          "(the real APNS limit). Trim custom data keys."
      );
    }

    // Reject a definitively-missing app with an actionable error instead of
    // simctl's opaque failure. A non-definitive probe (e.g. shutdown sim)
    // falls through so the push itself reports the real cause.
    if ((await isInstalled(udid, bundleId)) === false) {
      throw new FailureError(
        `Cannot push to ${bundleId} on ${udid}: the app is not installed. ` +
          "Install/launch the app first, and check the bundle id for typos.",
        {
          error_code: FAILURE_CODES.IOS_PUSH_FAILED,
          failure_stage: "ios_push_app_not_installed",
          failure_area: "tool_server",
          error_kind: "not_found",
        }
      );
    }

    try {
      // `-` = read the payload from stdin, so no temp file ever touches disk.
      await runXcrun(["simctl", "push", udid, bundleId, "-"], json);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      // simctl push requires a booted device; its "Unable to lookup in current
      // state: Shutdown" doesn't tell an agent what to do about it.
      const shutdownHint = /current state:\s*shutdown/i.test(detail)
        ? " The simulator must be booted first — use boot-device."
        : "";
      throw new FailureError(
        `Failed to deliver push notification to ${bundleId} on ${udid}: ${detail.trim()}${shutdownHint}`,
        {
          error_code: FAILURE_CODES.IOS_PUSH_FAILED,
          failure_stage: "ios_push_simctl_push",
          failure_area: "tool_server",
          error_kind: "subprocess",
          ...subprocessFailureMetadata(err, "xcrun_simctl"),
        },
        { cause: err instanceof Error ? err : new Error(String(err)) }
      );
    }

    return { delivered: true, bundleId, payloadBytes };
  },
};
