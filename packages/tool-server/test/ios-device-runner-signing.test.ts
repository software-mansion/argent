import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import {
  resolveRunnerSigningConfig,
  resolveSigningHint,
} from "../src/utils/ios-device/runner-signing";
import { __setCertificateListerForTests } from "../src/utils/ios-device/team-detect";
import { TEAM_B_PEM } from "./fixtures/signing-certs";

describe("resolveRunnerSigningConfig", () => {
  // The keychain seam: every case pins the lister, so no test ever shells out
  // to the developer's real `security` keychain.
  beforeEach(() => __setCertificateListerForTests(async () => ""));
  afterEach(() => {
    delete process.env.ARGENT_IOS_TEAM_ID;
    __setCertificateListerForTests(null);
  });

  it("derives the whole config from ARGENT_IOS_TEAM_ID without touching the keychain", async () => {
    process.env.ARGENT_IOS_TEAM_ID = " FGHIJ67890 ";
    const lister = vi.fn(async () => "");
    __setCertificateListerForTests(lister);

    await expect(resolveRunnerSigningConfig()).resolves.toEqual({
      teamId: "FGHIJ67890",
      appBundleId: "com.argent.runner.tfghij67890",
      testBundleId: "com.argent.runner.tfghij67890.uitests",
    });
    expect(lister).not.toHaveBeenCalled();
  });

  it("falls back to the detected team when the env var is unset", async () => {
    __setCertificateListerForTests(async (cn) => (cn === "Apple Development" ? TEAM_B_PEM : ""));

    await expect(resolveRunnerSigningConfig()).resolves.toEqual({
      teamId: "FGHIJ67890",
      appBundleId: "com.argent.runner.tfghij67890",
      testBundleId: "com.argent.runner.tfghij67890.uitests",
    });
  });

  it("answers an empty keychain with the sign-into-Xcode error, never naming the env var", async () => {
    const caught: unknown = await resolveRunnerSigningConfig().then(
      () => null,
      (error: unknown) => error
    );

    expect((caught as Error).message).toBe(
      "No Apple Development signing certificate was found in this Mac's keychain, " +
        "so the on-device runner cannot be signed. Open Xcode > Settings > Accounts " +
        "and sign in with your Apple ID; then, still in that pane, choose Manage " +
        "Certificates and click + > Apple Development. Retry once the certificate " +
        "exists; argent detects the team automatically."
    );
    // The pre-detection message told users to set ARGENT_IOS_TEAM_ID; with no
    // certificate a team id alone could not sign anything, so it must be gone.
    expect((caught as Error).message).not.toContain("ARGENT_IOS_TEAM_ID");
    const signal = getFailureSignal(caught);
    expect(signal?.error_code).toBe(FAILURE_CODES.IOS_DEVICE_RUNNER_NOT_READY);
    expect(signal?.failure_stage).toBe("ios_device_signing_team");
    expect(signal?.error_kind).toBe("validation");
  });
});

describe("resolveSigningHint", () => {
  it("answers the fresh-team failure with the registration hint, not the sign-in one", () => {
    const hint = resolveSigningHint(
      "error: Your team has no devices from which to generate a provisioning profile."
    );
    expect(hint).toContain("no registered devices");
    expect(hint).not.toContain("Xcode > Settings > Accounts");
  });

  it("maps the explicit registration failure to the personal-team cap", () => {
    expect(
      resolveSigningHint("error: Failed Registering Bundle Identifier (in target 'ArgentRunner')")
    ).toContain("Personal Team");
  });

  it("gives the registration hint when 'is not available' carries registration context", () => {
    const output =
      'The app identifier "com.argent.runner.tabcde12345" cannot be registered to your ' +
      "development team because it is not available.";
    expect(resolveSigningHint(output)).toContain("Personal Team");
  });

  it("does not blame registration for unrelated 'is not available' failures", () => {
    const output =
      "xcodebuild: error: iPhone 15 with iOS 18.0 is not available for this run destination.";
    expect(resolveSigningHint(output)).toBeNull();
  });

  it("maps provisioning failures to the Xcode sign-in hint", () => {
    expect(
      resolveSigningHint('No profiles for "com.argent.runner.tabcde12345" were found')
    ).toContain("Xcode > Settings > Accounts");
  });

  it("maps errSecInternalComponent to the exact partition-list fix, case-insensitively", () => {
    const hint = resolveSigningHint(
      "/usr/bin/codesign --force --sign 4E815... ArgentRunner.app\n" +
        "errSecInternalComponent\nCommand CodeSign failed with a nonzero exit code"
    );
    expect(hint).toBe(
      "The signing key's access control needs stamping. Run: " +
        "security set-key-partition-list -S apple-tool:,apple:,codesign: " +
        "-s ~/Library/Keychains/login.keychain-db (it asks for your login password), " +
        "then retry."
    );
    expect(resolveSigningHint("ERRSECINTERNALCOMPONENT")).toBe(hint);
  });

  it("keeps the partition-list hint when the log also mentions a provisioning profile", () => {
    // A build log lists the embedded provisioning profile during codesign;
    // that mention must not divert an errSecInternalComponent failure to the
    // sign-into-Xcode arm, which cannot fix a locked keychain key.
    const hint = resolveSigningHint(
      "Entitlements from provisioning profile argent-runner.mobileprovision\n" +
        "errSecInternalComponent"
    );
    expect(hint).toContain("set-key-partition-list");
    expect(hint).not.toContain("Xcode > Settings > Accounts");
  });
});
