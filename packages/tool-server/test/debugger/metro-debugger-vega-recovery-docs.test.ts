import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";

const SKILL = path.resolve(__dirname, "../../../skills/skills/argent-metro-debugger/SKILL.md");
const FAILURE_SCENARIOS = path.resolve(
  __dirname,
  "../../../skills/skills/argent-metro-debugger/references/failure-scenarios.md"
);
const RESTART_APP_VEGA = path.resolve(__dirname, "../../src/tools/restart-app/platforms/vega.ts");

/** The single line carrying `needle`; more or fewer than one is a doc rewrite the assertions no longer cover. */
function lineWith(file: string, needle: string): string {
  const matches = readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.includes(needle));
  expect(matches, `expected exactly one line containing ${needle} in ${file}`).toHaveLength(1);
  return matches[0]!;
}

describe("metro-debugger Vega no_app_connected recovery", () => {
  // The premise both surfaces rest on: the Vega relaunch is terminate-then-launch,
  // so an agent that only restarts the app gets the same no_app_connected back.
  it("leaves restart-app's Vega arm with no Metro forward of its own", () => {
    expect(readFileSync(RESTART_APP_VEGA, "utf8")).not.toContain("port-forwarding");
  });

  it("branches Golden Rule 2 to the port forward", () => {
    expect(lineWith(SKILL, '**`reason: "no_app_connected"`')).toContain(
      "vega device start-port-forwarding"
    );
  });

  it("branches the App-not-connected row to the port forward", () => {
    expect(lineWith(FAILURE_SCENARIOS, "**App not connected**")).toContain(
      "vega device start-port-forwarding"
    );
  });
});
