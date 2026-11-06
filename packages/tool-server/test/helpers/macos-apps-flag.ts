import { setFlag } from "@argent/configuration-core";
import { beforeEach } from "vitest";
import { scopeTempHome } from "./temp-home";

/**
 * Runs every test of the calling file in a fresh HOME with the `macos-apps`
 * flag on, so the developer's own flags never leak in. The flag is read per
 * call, so `off()` takes effect for the rest of the test.
 *
 * Call at file top level.
 */
export function useMacosAppsFlag(): { on: () => void; off: () => void } {
  scopeTempHome("argent-macos-test-home-");
  const on = () => setFlag("macos-apps", true, "global");
  beforeEach(on);
  return { on, off: () => setFlag("macos-apps", false, "global") };
}
