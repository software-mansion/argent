import { FAILURE_CODES, FailureError } from "@argent/registry";
import { runHdcShell, shellQuote } from "./harmony-hdc";

/**
 * App lifecycle over the device's `aa` and `bm`. `aa` exits 0 on failure, so
 * every verdict is read from stdout and a missing success line is a failure.
 */

const AA_SUCCESS = "start ability successfully.";

/** Matched positively: `aa`'s failures share no common marker. */
const AA_STOP_SUCCESS = "force stop process successfully.";

/**
 * Per-step ceilings, together under the MCP client's 30s abort-and-replay;
 * `runHdcShell`'s 30s default would give restart-app 90s.
 */
const AA_STOP_TIMEOUT_MS = 8_000;
const BM_DUMP_TIMEOUT_MS = 6_000;
const AA_START_TIMEOUT_MS = 10_000;

interface HarmonyBundleEntry {
  /** The `abilityInfos` name `aa start -a` accepts, not `bm`'s `mainAbility`. */
  mainAbility: string;
  module: string;
}

/**
 * A bundle's launchable ability and module. Needed because `aa start -b` alone
 * is an implicit start: it fails and leaves a "No options to open with" chooser
 * on screen.
 *
 * `mainAbility` picks the launcher's entry among `abilityInfos`, but `aa start
 * -a` takes that entry's `name`, spelled differently on real bundles:
 *
 *   bundle       mainAbility                                 abilityInfos name
 *   calculator   com.huawei.hmos.calculator.CalculatorAbility CalculatorAbility
 *   photos       MainAbility                                  com.huawei.hmos.photos.MainAbility
 */
export async function resolveHarmonyEntry(
  connectKey: string,
  bundleId: string
): Promise<HarmonyBundleEntry> {
  const { stdout } = await runHdcShell(
    connectKey,
    `bm dump -n ${shellQuote(bundleId)}`,
    BM_DUMP_TIMEOUT_MS
  );
  const start = stdout.indexOf("{");
  if (start === -1) {
    throw new FailureError(
      `HarmonyOS device '${connectKey}' has no app with bundle name '${bundleId}'. ` +
        `List what is installed with \`bm dump -a\`.`,
      {
        error_code: FAILURE_CODES.HARMONY_ABILITY_START_FAILED,
        failure_stage: "harmony_resolve_bundle",
        failure_area: "tool_server",
        error_kind: "not_found",
        failure_command: "hdc",
      }
    );
  }
  let parsed: {
    mainEntry?: unknown;
    hapModuleInfos?: Array<{
      name?: unknown;
      mainAbility?: unknown;
      abilityInfos?: Array<{ name?: unknown }>;
    }>;
  };
  try {
    parsed = JSON.parse(stdout.slice(start));
  } catch (err) {
    throw new FailureError(
      `Could not read the bundle description of '${bundleId}' from HarmonyOS device '${connectKey}'.`,
      {
        error_code: FAILURE_CODES.HARMONY_ABILITY_START_FAILED,
        failure_stage: "harmony_resolve_bundle",
        failure_area: "tool_server",
        error_kind: "subprocess",
        failure_command: "hdc",
      },
      { cause: err as Error }
    );
  }
  const modules = Array.isArray(parsed.hapModuleInfos) ? parsed.hapModuleInfos : [];
  const mainEntry = typeof parsed.mainEntry === "string" ? parsed.mainEntry : null;
  // `bm` reports a bundle with no launcher entry as `mainAbility: ""`, and
  // `aa start -a ''` is an implicit start that leaves a chooser on screen.
  const hasMain = (m: (typeof modules)[number]): boolean =>
    typeof m.mainAbility === "string" && m.mainAbility.length > 0;
  // `mainEntry` names the launcher's module; some bundles omit it.
  const chosen = modules.find((m) => m.name === mainEntry && hasMain(m)) ?? modules.find(hasMain);
  if (!chosen || typeof chosen.name !== "string" || typeof chosen.mainAbility !== "string") {
    throw new FailureError(
      `App '${bundleId}' on HarmonyOS device '${connectKey}' declares no launchable main ability, ` +
        `so there is nothing to start. It may be a service or extension rather than an app.`,
      {
        error_code: FAILURE_CODES.HARMONY_ABILITY_START_FAILED,
        failure_stage: "harmony_resolve_bundle",
        failure_area: "tool_server",
        error_kind: "not_found",
        failure_command: "hdc",
      }
    );
  }
  return {
    mainAbility: startableAbilityName(chosen.abilityInfos, chosen.mainAbility),
    module: chosen.name,
  };
}

/**
 * An uninstalled bundle: `not_found`, not a retryable subprocess failure.
 * Prefixed so a bundle id containing the digits cannot forge it.
 */
const AA_NO_SUCH_PACKAGE = "Error Code:10104002";

/**
 * `aa force-stop` succeeds for an app that is not running, so anything but the
 * success line is a failure. The bundle is positional: `-b` answers "not
 * installed" even for a running app.
 */
export async function terminateHarmonyApp(connectKey: string, bundleId: string): Promise<void> {
  const { stdout } = await runHdcShell(
    connectKey,
    `aa force-stop ${shellQuote(bundleId)}`,
    AA_STOP_TIMEOUT_MS
  );
  if (stdout.includes(AA_STOP_SUCCESS)) return;
  throw new FailureError(
    `Failed to stop '${bundleId}' on HarmonyOS device '${connectKey}': ${firstLine(stdout)}`,
    {
      error_code: FAILURE_CODES.HARMONY_ABILITY_STOP_FAILED,
      failure_stage: "harmony_force_stop",
      failure_area: "tool_server",
      error_kind: stdout.includes(AA_NO_SUCH_PACKAGE) ? "not_found" : "subprocess",
      failure_command: "hdc",
    }
  );
}

/**
 * Matches either spelling being the other's final dot-segment (see
 * `resolveHarmonyEntry`). Falls back to `mainAbility`, which `aa` names
 * precisely if wrong.
 */
function startableAbilityName(
  abilityInfos: Array<{ name?: unknown }> | undefined,
  mainAbility: string
): string {
  const names = (Array.isArray(abilityInfos) ? abilityInfos : [])
    .map((a) => a?.name)
    .filter((n): n is string => typeof n === "string" && n.length > 0);
  if (names.includes(mainAbility)) return mainAbility;
  return (
    names.find((n) => mainAbility.endsWith(`.${n}`) || n.endsWith(`.${mainAbility}`)) ?? mainAbility
  );
}

export async function launchHarmonyApp(connectKey: string, bundleId: string): Promise<void> {
  const entry = await resolveHarmonyEntry(connectKey, bundleId);
  const { stdout } = await runHdcShell(
    connectKey,
    `aa start -b ${shellQuote(bundleId)} -a ${shellQuote(entry.mainAbility)} -m ${shellQuote(entry.module)}`,
    AA_START_TIMEOUT_MS
  );
  assertAbilityStarted(stdout, connectKey, bundleId);
}

/** No ability claims the scheme; prefixed as {@link AA_NO_SUCH_PACKAGE}. */
const AA_NO_IMPLICIT_MATCH = "Error Code:10103101";

/** An implicit start, which is right here: the system picks the handler. */
export async function openHarmonyUrl(connectKey: string, url: string): Promise<void> {
  const { stdout } = await runHdcShell(
    connectKey,
    `aa start -U ${shellQuote(url)}`,
    AA_START_TIMEOUT_MS
  );
  if (!stdout.includes(AA_SUCCESS)) {
    throw new FailureError(
      `HarmonyOS device '${connectKey}' could not open '${url}': ${firstLine(stdout)}. ` +
        `If no installed app claims the scheme \`aa\` reports \`10103101\`; either way the device may ` +
        `now be showing a chooser dialog.`,
      {
        error_code: FAILURE_CODES.HARMONY_ABILITY_START_FAILED,
        failure_stage: "harmony_open_url",
        failure_area: "tool_server",
        error_kind: stdout.includes(AA_NO_IMPLICIT_MATCH) ? "not_found" : "subprocess",
        failure_command: "hdc",
      }
    );
  }
}

function assertAbilityStarted(stdout: string, connectKey: string, bundleId: string): void {
  if (stdout.includes(AA_SUCCESS)) return;
  throw new FailureError(
    `Failed to launch '${bundleId}' on HarmonyOS device '${connectKey}': ${firstLine(stdout)}`,
    {
      error_code: FAILURE_CODES.HARMONY_ABILITY_START_FAILED,
      failure_stage: "harmony_ability_start",
      failure_area: "tool_server",
      error_kind: "subprocess",
      failure_command: "hdc",
    }
  );
}

/** The headline plus the `Error Code:` line, which carries the cause. */
function firstLine(stdout: string): string {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return "the ability assistant printed nothing";
  const coded = lines.find((l) => l.startsWith("Error Code:"));
  return coded ? `${lines[0]} ${coded}` : lines[0];
}
