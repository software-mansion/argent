import { FAILURE_CODES, withFailureSignal } from "@argent/registry";
import { teamsCoveringDevice } from "./provisioning-profiles";
import { announceDetectedSigningTeam, detectSigningTeams } from "./team-detect";

/**
 * Signing for the on-device runner: the team the build signs under, and the
 * recovery hints for xcodebuild's signing failures.
 */

/**
 * Automatic signing under a single Apple team.
 * Bundle ids are derived from the team id.
 */
export interface RunnerSigningConfig {
  teamId: string;
  appBundleId: string;
  testBundleId: string;
}

function signingTeamError(message: string): Error {
  return withFailureSignal(new Error(message), {
    error_code: FAILURE_CODES.IOS_DEVICE_RUNNER_NOT_READY,
    failure_stage: "ios_device_signing_team",
    failure_area: "tool_server",
    error_kind: "validation",
  });
}

function signingConfigForTeam(teamId: string): RunnerSigningConfig {
  // The leading "t" keeps the derived segment from starting with a digit.
  const appBundleId = `com.argent.runner.t${teamId.toLowerCase()}`;

  return {
    teamId,
    appBundleId,
    testBundleId: `${appBundleId}.uitests`,
  };
}

/**
 * Resolve signing: `ARGENT_IOS_TEAM_ID` when set, otherwise a team detected
 * from this Mac's keychain (memoized). With several teams, `udid` narrows the
 * pick to teams whose provisioning profile already lists that phone, since those
 * can build for it without registering it; the newest of those wins. Without any,
 * the newest team wins, and building against the phone can register it.
 * Throws only when neither yields a team, and that error prompts an Xcode
 * sign-in: with no certificate in the keychain, naming a team id could not
 * make the build signable anyway.
 */
export async function resolveRunnerSigningConfig(udid?: string): Promise<RunnerSigningConfig> {
  const envTeamId = process.env.ARGENT_IOS_TEAM_ID?.trim();

  if (envTeamId) {
    return signingConfigForTeam(envTeamId);
  }

  const teams = await detectSigningTeams();

  if (teams.length === 0) {
    throw signingTeamError(
      "No Apple Development signing certificate was found in this Mac's keychain, " +
        "so the on-device runner cannot be signed. Open Xcode > Settings > Accounts " +
        "and sign in with your Apple ID; then, still in that pane, choose Manage " +
        "Certificates and click + > Apple Development. Retry once the certificate " +
        "exists; argent detects the team automatically."
    );
  }

  const covering = udid && teams.length > 1 ? await teamsCoveringDevice(udid) : new Set<string>();
  const winner = teams.find((team) => covering.has(team.teamId)) ?? teams[0]!;

  announceDetectedSigningTeam(
    teams,
    winner,
    udid
      ? { udid, coveringTeams: teams.filter((team) => covering.has(team.teamId)).length }
      : undefined
  );

  return signingConfigForTeam(winner.teamId);
}

/**
 * For the failures a team choice can cause. The detection note carries this too,
 * but only on a completed call, once per phone and team: a failed build, or a
 * later session on the same tool-server, would never see it.
 */
const TEAM_OVERRIDE_HINT =
  "To sign under a different team, set ARGENT_IOS_TEAM_ID in the tool-server's environment: " +
  "argent server stop && ARGENT_IOS_TEAM_ID=<team-id> argent server start --detach";

/** Map xcodebuild output to a signing-recovery hint, or null. */
export function resolveSigningHint(output: string): string | null {
  const lower = output.toLowerCase();

  // Check this before the provisioning arm. This message also mentions
  // "provisioning profile" and the Xcode-account hint would be wrong.
  if (lower.includes("team has no devices")) {
    return (
      "This team has no registered devices yet. Keep the phone connected and retry: " +
      `building against the connected device registers it with the team. ${TEAM_OVERRIDE_HINT}`
    );
  }

  if (
    lower.includes("failed registering bundle identifier") ||
    // Bare "is not available" also appears in destination and OS failures.
    // Require identifier or registered context as well.
    (lower.includes("is not available") &&
      (lower.includes("identifier") || lower.includes("registered")))
  ) {
    // The derived bundle id is unique per team. This is a free-team app-id cap.
    return (
      "Registering the runner bundle id failed. On a free Personal Team, Apple limits " +
      `new app ids; wait a few days and retry, or sign under a paid team. ${TEAM_OVERRIDE_HINT}`
    );
  }

  // Check this before the provisioning arm too: errSecInternalComponent is a
  // codesign-stage verdict (the signing key's keychain partition list blocks
  // non-Xcode callers), so provisioning already succeeded and any
  // "provisioning profile" mention further up the log is context, not the
  // failure. The two arms above never co-occur with it.
  if (lower.includes("errsecinternalcomponent")) {
    return (
      "The signing key's access control needs stamping. Run: " +
      "security set-key-partition-list -S apple-tool:,apple:,codesign: " +
      "-s ~/Library/Keychains/login.keychain-db (it asks for your login password), " +
      "then retry."
    );
  }

  // Real signing errors only. Every signed build log prints "Provisioning
  // Profile:" lines, so the bare phrase proves nothing.
  if (
    lower.includes("no profiles for") ||
    lower.includes("requires a provisioning profile") ||
    lower.includes("no provisioning profile") ||
    /error:[^\n]*provisioning profile/.test(lower)
  ) {
    return (
      "Provisioning failed. Check that this team's Apple ID is signed into Xcode " +
      `(Xcode > Settings > Accounts), then retry. ${TEAM_OVERRIDE_HINT}`
    );
  }

  return null;
}
