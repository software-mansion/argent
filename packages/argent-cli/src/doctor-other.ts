import { getConsentState } from "@argent/telemetry";
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
} from "./doctor-shared.js";
import { type PackageManager, globalPackageManagerOf } from "./doctor-install.js";

// `argent doctor`: the Other section (telemetry, updates).

/** Bare `argent mcp` entries start the global install, which may lag behind this copy. */
export function globalBehindCheck(
  global: GlobalInstall | null,
  running: string,
  latest: string
): DoctorCheck | null {
  const version = global?.runError ? null : global?.version;
  if (!version || version === running || !isNewerVersion(latest, version)) return null;
  const pm = global!.root ? globalPackageManagerOf(global!.root) : "npm";
  return check(
    "warn",
    `Global install v${version}, which \`argent mcp\` entries start, is behind v${latest}`,
    { fix: formatShellCommand(globalInstallCommand(pm, `${PACKAGE_NAME}@latest`)) }
  );
}

export async function otherSection(
  ctx: DoctorContext,
  running: string,
  offline: boolean,
  updateCmd: string,
  pm: PackageManager
): Promise<DoctorSection> {
  const checks: DoctorCheck[] = [];
  // The same root `argent telemetry status` reads, which stops at package.json.
  const consent = getConsentState(process.env, ctx.cwd);
  const source = consent.source.detail ?? consent.source.source;
  checks.push(
    check("info", `Telemetry ${consent.enabled ? "enabled" : "disabled"} (${source})`, {
      detail: consent.enabled ? `${ctx.argentCmd} telemetry disable to opt out` : undefined,
    })
  );

  if (offline) {
    checks.push(check("info", "Update check skipped (--offline)"));
  } else {
    // The same target `argent update` would install, minimum-release-age included.
    const target = await resolveInstallableUpdateTarget(pm, running).catch(() => null);
    const installable = target?.targetVersion ?? null;
    if (!target) {
      checks.push(check("info", "Update check skipped (npm registry unreachable)"));
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
    const behind = installable && globalBehindCheck(ctx.global, running, installable);
    if (behind) checks.push(behind);
  }
  return { title: "Other", checks };
}
