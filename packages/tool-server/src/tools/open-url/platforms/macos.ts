import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import { FAILURE_CODES } from "@argent/registry";
import type { MacosAppApi } from "../../../blueprints/macos-app";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { InvalidToolInputError } from "../../../utils/capability";
import { macosFailure, runningTrackedApp } from "../../../utils/macos-apps";
import type { OpenUrlParams, OpenUrlResult } from "../types";

const execFileAsync = promisify(execFile);

const WEB_URL_NOTE =
  "The URL went to the app of the device, not to the default browser. The app shows it only if it handles that URL.";

/** The URL schemes the bundle declares in CFBundleURLTypes, lowercased. */
async function declaredSchemes(appPath: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      "plutil",
      [
        "-extract",
        "CFBundleURLTypes",
        "json",
        "-o",
        "-",
        path.join(appPath, "Contents", "Info.plist"),
      ],
      { timeout: 10_000 }
    );
    const types = JSON.parse(stdout) as Array<{ CFBundleURLSchemes?: unknown }>;
    return types
      .flatMap((t) => (Array.isArray(t?.CFBundleURLSchemes) ? t.CFBundleURLSchemes : []))
      .filter((scheme): scheme is string => typeof scheme === "string")
      .map((scheme) => scheme.toLowerCase());
  } catch {
    return [];
  }
}

/**
 * `open -g -a <app path> <url>`: LaunchServices hands the URL to the running
 * app as an Apple event, and `-g` keeps it in the background. By path, not by
 * bundle id: a development build is often missing from the LaunchServices
 * database, or is there next to another build with the same id. The app must
 * be running: `open` would otherwise start a copy without the argent library.
 *
 * `open -a` skips the scheme routing, so a scheme the app does not declare is
 * refused here, as a deep link to it fails on iOS.
 */
export const macosImpl: PlatformImpl<{ macosApp: MacosAppApi }, OpenUrlParams, OpenUrlResult> = {
  handler: async (services, params, device) => {
    // A scheme first, so the value can never read as an `open` option.
    const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(params.url)?.[1]?.toLowerCase();
    if (!scheme) {
      throw new InvalidToolInputError(
        `'${params.url}' is not a URL: on a Mac app, open-url needs a scheme (https://, myapp://).`
      );
    }
    const bundleId = services.macosApp.bundleId;
    const app = await runningTrackedApp(bundleId);
    if (!app) {
      throw macosFailure(
        `${bundleId} is not running. Start it with launch-app on ${device.id}, then open the URL.`,
        FAILURE_CODES.MACOS_APP_NOT_RUNNING,
        "macos_open_url",
        "not_found"
      );
    }
    const web = scheme === "http" || scheme === "https";
    if (!web && scheme !== "file" && !(await declaredSchemes(app.appPath)).includes(scheme)) {
      throw macosFailure(
        `${bundleId} does not declare the URL scheme '${scheme}' (CFBundleURLTypes in its ` +
          `Info.plist), so macOS does not give it this URL.`,
        FAILURE_CODES.MACOS_APP_OPEN_URL_FAILED,
        "macos_open_url",
        "validation"
      );
    }
    // Another tool-server may drive the app.
    await services.macosApp.connect();
    try {
      await execFileAsync("open", ["-g", "-a", app.appPath, params.url], { timeout: 10_000 });
    } catch (err) {
      const stderr = (err as { stderr?: string }).stderr?.trim();
      throw macosFailure(
        `Failed to open the URL in ${bundleId}: ${stderr || (err as Error).message}`,
        FAILURE_CODES.MACOS_APP_OPEN_URL_FAILED,
        "macos_open_url",
        "subprocess",
        err
      );
    }
    return {
      opened: true,
      url: params.url,
      ...(web ? { note: WEB_URL_NOTE } : {}),
    };
  },
};
