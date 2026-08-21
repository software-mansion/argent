import { z } from "zod";
import type { ToolCapability, ToolDefinition } from "@argent/registry";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { androidImpl } from "./platforms/android";
import { iosImpl } from "./platforms/ios";
import { iosRemoteImpl } from "./platforms/ios-remote";
import type { InstallAppResult, InstallAppServices } from "./types";

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

const zodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe("Target device id from `list-devices` (iOS UDID or Android serial)."),
  url: z
    .string()
    .refine(isHttpUrl, "url must be an absolute http or https URL")
    .describe(
      "Public URL of an app build. Android accepts an APK directly or one APK inside a ZIP/tar.gz. iOS accepts an IPA/ZIP or tar.gz containing one simulator .app bundle."
    ),
  headers: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "Optional HTTP request headers for authenticated artifact URLs (for example Authorization). Caller-provided headers are not forwarded to a different origin after a redirect."
    ),
});

type Params = z.infer<typeof zodSchema>;

function safeHost(value: string): string {
  try {
    return new URL(value).hostname || "remote URL";
  } catch {
    return "remote URL";
  }
}

const capability: ToolCapability = {
  apple: { simulator: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
};

export const installAppTool: ToolDefinition<Params, InstallAppResult> = {
  id: "install-app",
  interaction: {
    startedMsg: ({ params }) => `Installing app from ${safeHost(params.url)}`,
    completedMsg: ({ result }) => `Installed ${result.bundleId}`,
    failedMsg: ({ params, failureSignal }) =>
      `Failed to install app from ${safeHost(params.url)}: ${failureSignal.error_code}`,
  },
  description: `Download and install an app build from a remote URL, resolving its bundle/package id automatically.
Use when an app build is available as a CI or EAS artifact and is not present in the local checkout. The existing installation is updated in place when possible; unlike reinstall-app, this tool does not uninstall first or clear app data.
Android supports a direct .apk or an archive containing exactly one .apk. iOS simulators support .ipa/.zip, .tar.gz, or .tgz artifacts containing exactly one simulator-compatible .app bundle. GitHub Actions ZIPs that wrap a single app archive are supported. URLs and every redirect must resolve to public network addresses; use optional headers for authenticated downloads. Caller-provided headers are dropped if a redirect changes origin.
Returns { installed, bundleId }, where bundleId is the Android package name or iOS CFBundleIdentifier. The downloaded artifact is removed after installation.`,
  searchHint:
    "install app apk ipa app bundle remote url download CI EAS GitHub artifact simulator emulator device",
  longRunning: true,
  zodSchema,
  capability,
  services: () => ({}),
  execute: dispatchByPlatform<
    InstallAppServices,
    InstallAppServices,
    Params,
    InstallAppResult,
    Record<string, unknown>,
    never,
    InstallAppServices
  >({
    toolId: "install-app",
    capability,
    ios: iosImpl,
    android: androidImpl,
    iosRemote: iosRemoteImpl,
  }),
};
