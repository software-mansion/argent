import * as fs from "node:fs";
import { getConsentState } from "@argent/telemetry";
import { configFilePath } from "@argent/configuration-core";
import {
  formatShellCommand,
  globalInstallCommand,
  isNewerVersion,
  resolveInstallableUpdateTarget,
  PACKAGE_NAME,
} from "@argent/installer";
import {
  type DoctorCheck,
  type DoctorContext,
  type DoctorSection,
  type GlobalInstall,
  check,
  home,
} from "./doctor-shared.js";
import { type PackageManager, globalPackageManagerOf } from "./doctor-install.js";

// `argent doctor`: the Other section (telemetry, updates).

const UPDATE_CHECK_DEADLINE_MS = 15_000;

/**
 * Doctor must change nothing, but `pnpm config get` through corepack downloads
 * the project's pinned pnpm, and npm writes a debug log and its notifier stamp.
 */
export const READ_ONLY_PM_ENV = {
  COREPACK_ENABLE_NETWORK: "0",
  COREPACK_ENABLE_AUTO_PIN: "0",
  npm_config_update_notifier: "false",
  npm_config_logs_max: "0",
};

/** Bare `argent mcp` entries start the global install, which may lag behind this copy. */
export function globalBehindCheck(
  global: GlobalInstall | null,
  running: string,
  latest: string
): DoctorCheck | null {
  const version = global?.runError ? null : global?.version;
  if (!version || version === running || !isNewerVersion(latest, version)) return null;
  // A script shim has no package root, but its path names its owner (~/Library/pnpm/argent).
  const pm = globalPackageManagerOf(global!.root ?? global!.bin);
  return check(
    "warn",
    `Global install v${version}, which \`argent mcp\` entries start, is behind v${latest}`,
    { fix: formatShellCommand(globalInstallCommand(pm, `${PACKAGE_NAME}@latest`)) }
  );
}

/** Config readers treat a file that doesn't parse as empty, silently dropping its settings. */
function unparsableConfigChecks(cwd: string): DoctorCheck[] {
  const files = [...new Set([configFilePath("global"), configFilePath("project", { cwd })])];
  return files.flatMap((file) => {
    const error = configParseError(file);
    if (!error) return [];
    return [
      check("warn", `${home(file)} doesn't parse, so every setting in it is ignored`, {
        detail: error,
        fix: "Fix the JSON (look for merge-conflict markers), or delete the file",
      }),
    ];
  });
}

function configParseError(file: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    const json = JSON.parse(raw) as unknown;
    return json && typeof json === "object" && !Array.isArray(json) ? null : "not a JSON object";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export async function otherSection(
  ctx: DoctorContext,
  running: string,
  offline: boolean,
  updateCmd: string,
  pm: PackageManager,
  entriesStartGlobal = false
): Promise<DoctorSection> {
  const checks: DoctorCheck[] = [];
  // The same root `argent telemetry status` reads, which stops at package.json.
  const consent = getConsentState(process.env, ctx.cwd);
  const source = consent.source.detail ?? consent.source.source;
  checks.push(...unparsableConfigChecks(ctx.cwd));
  checks.push(
    check("info", `Telemetry ${consent.enabled ? "enabled" : "disabled"} (${source})`, {
      detail: consent.enabled ? `${ctx.argentCmd} telemetry disable to opt out` : undefined,
    })
  );

  if (offline) {
    checks.push(check("info", "Update check skipped (--offline)"));
  } else {
    // The same target `argent update` would install, minimum-release-age included.
    const target = await resolveInstallableUpdateTarget(pm, running, {
      deadlineMs: UPDATE_CHECK_DEADLINE_MS,
      env: { ...process.env, ...READ_ONLY_PM_ENV },
    }).catch(() => null);
    const installable = target?.targetVersion ?? null;
    if (!target) {
      checks.push(
        check("info", "Update check skipped (npm registry unreachable or too slow)", {
          detail: `the request failed (DNS, proxy, HTTP error) or took over ${UPDATE_CHECK_DEADLINE_MS / 1000}s; --offline skips the check`,
        })
      );
    } else if (installable && isNewerVersion(installable, running)) {
      checks.push(
        check("warn", `Update available: v${running} → v${installable}`, { fix: updateCmd })
      );
    } else if (isNewerVersion(target.latestVersion, running)) {
      checks.push(
        check(
          "info",
          `v${target.latestVersion} is out, but held by your minimum-release-age policy`
        )
      );
    } else {
      checks.push(check("ok", `Up to date (latest v${target.latestVersion})`));
    }
    // On latest there is no upgrade for this copy, but the global entries start may still lag.
    const globalTarget =
      installable ??
      (target && !isNewerVersion(target.latestVersion, running) ? target.latestVersion : null);
    // A local-mode project's own entries start its copy; only bare `argent` ones start the global.
    const behind =
      (ctx.mode !== "local" || entriesStartGlobal) &&
      globalTarget &&
      globalBehindCheck(ctx.global, running, globalTarget);
    if (behind) checks.push(behind);
  }
  return { title: "Other", checks };
}
