import { describe, it, expect } from "vitest";
import {
  emulatorFailure,
  isChinaOnlyRestriction,
  type HarmonyRunResult,
} from "../src/utils/harmony-cli";

/**
 * Every fixture here is verbatim stdout captured from DevEco Studio 6.1's
 * `Emulator` manager on macOS (Emulator 6.1.1.200), together with the exit code
 * measured alongside it. Those codes are the reason this classifier exists: a
 * failure is usually exit 0 (`-create`, `-stop`, `-install`) but not always
 * (`-start` exits 1), so the exit code is unreliable in both directions and the
 * verdict has to come from stdout.
 */

/** `Emulator -list` with no instances deployed. Exit 0. */
const EMULATOR_EMPTY = "[Empty]\n";

/** `Emulator -create testinst -deviceType phone -osVersion "…"` with no image. Exit 0. */
const EMULATOR_CREATE_NO_IMAGE = `Cannot find image, please verify your SDK installation.

Device create fail.
`;

/** `Emulator -start nosuchinstance`. Exit 1 — the one failure that does not exit 0. */
const EMULATOR_START_MISSING = `"nosuchinstance"  is not found. Please create the device(folder):  "/Users/ignacylatka/.Huawei/Emulator/deployed/nosuchinstance"
Unable to start the emulator
`;

/** `Emulator -stop nosuchinstance`. Exit 0. */
const EMULATOR_STOP_MISSING = `Stop emulator  "nosuchinstance"  failed, emulator is not exists.
`;

/** `Emulator -install -deviceType phone -osVersion "…"` outside mainland China. Exit 0. */
const EMULATOR_CHINA_ONLY =
  "Currently, this capability is available only in the Chinese mainland.\n";

/** `Emulator -imageList -downloaded true` with nothing downloaded. Exit 0, and not a failure. */
const EMULATOR_NO_MATCHING_IMAGES = "No images matching the criteria were found.\n";

function result(stdout: string, stderr = ""): HarmonyRunResult {
  return { stdout, stderr };
}

describe("emulatorFailure", () => {
  it("returns null for the empty-instance-list sentinel", () => {
    expect(emulatorFailure(result(EMULATOR_EMPTY))).toBeNull();
  });

  it("does not fire on a listing whose instance name merely contains 'fail'", () => {
    // Pins the "verified markers, not a bare `fail` substring" design: an
    // instance the user named `failsafe_phone` must still list as an instance.
    expect(emulatorFailure(result("failsafe_phone\nPhone_1\n"))).toBeNull();
  });

  it("does not fire on an image query that simply matched nothing", () => {
    expect(emulatorFailure(result(EMULATOR_NO_MATCHING_IMAGES))).toBeNull();
  });

  it("finds a diagnostic printed on stderr rather than stdout", () => {
    expect(emulatorFailure(result("", EMULATOR_CHINA_ONLY))).toBe(
      "Currently, this capability is available only in the Chinese mainland."
    );
  });
});

describe("failure is read from stdout, whatever the exit code was", () => {
  // Branching on the exit status misclassifies these in both directions: the
  // exit-0 rows would read as success, and were `-start`'s exit 1 taken as the
  // signal, an exit-0 `-create` failure would still slip through.
  it.each([
    {
      label: "`-create` with no image downloaded (exit 0)",
      output: EMULATOR_CREATE_NO_IMAGE,
      diagnostic: "Cannot find image, please verify your SDK installation.",
    },
    {
      // Second line of the `-create` output above, on its own: the marker is
      // otherwise shadowed by "Cannot find image" and nothing would pin it.
      label: "`-create` reporting only the trailing create-fail line (exit 0)",
      output: "Device create fail.\n",
      diagnostic: "Device create fail.",
    },
    {
      // This output carries two diagnostics — the naming line and a bare
      // "Unable to start the emulator". Marker order has to pick the naming
      // line, since it is the one that says what to do about it.
      label: "`-start` on an instance that does not exist (exit 1)",
      output: EMULATOR_START_MISSING,
      diagnostic:
        '"nosuchinstance"  is not found. Please create the device(folder):  "/Users/ignacylatka/.Huawei/Emulator/deployed/nosuchinstance"',
    },
    {
      // The bare trailer on its own: otherwise shadowed by the naming line
      // above, so nothing would pin this marker.
      label: "`-start` reporting only the trailing unable-to-start line (exit 1)",
      output: "Unable to start the emulator\n",
      diagnostic: "Unable to start the emulator",
    },
    {
      label: "`-stop` on an instance that does not exist (exit 0)",
      output: EMULATOR_STOP_MISSING,
      diagnostic: 'Stop emulator  "nosuchinstance"  failed, emulator is not exists.',
    },
    {
      label: "`-install` outside mainland China (exit 0)",
      output: EMULATOR_CHINA_ONLY,
      diagnostic: "Currently, this capability is available only in the Chinese mainland.",
    },
  ])("Emulator $label", ({ output, diagnostic }) => {
    expect(emulatorFailure(result(output))).toBe(diagnostic);
  });
});

describe("isChinaOnlyRestriction", () => {
  it("is true for the mainland-China image-download restriction", () => {
    const diagnostic = emulatorFailure(result(EMULATOR_CHINA_ONLY));
    expect(diagnostic).not.toBeNull();
    expect(isChinaOnlyRestriction(diagnostic as string)).toBe(true);
  });

  it("is false for every other verified diagnostic", () => {
    expect(isChinaOnlyRestriction("Cannot find image, please verify your SDK installation.")).toBe(
      false
    );
    expect(isChinaOnlyRestriction("Device create fail.")).toBe(false);
    expect(isChinaOnlyRestriction("Unable to start the emulator")).toBe(false);
    expect(
      isChinaOnlyRestriction('Stop emulator  "nosuchinstance"  failed, emulator is not exists.')
    ).toBe(false);
  });
});
